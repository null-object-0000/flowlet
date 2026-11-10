// Extractor 调用与输出解析（Rust commands/scrape.rs 的对应实现）。
//
// 关键契约（不能简化）：
// - extractor 只在 per-account 抓取窗口的页面沙箱内执行，绝不在 Node 进程里 eval；
// - 第二个实参是账号凭据指纹 `{keyPrefix, keyLastFour}`，不是明文 Key；
// - 输出解析必须区分「空串（脚本语法错误）」「双重编码」「error 字段」「null」。
import type { JsonRow } from "../types.ts";

/** Rust `CREDENTIAL_KEY_PREFIX_CHARS`。 */
export const CREDENTIAL_KEY_PREFIX_CHARS = 8;

export interface CredentialKeyContext {
  keyPrefix: string;
  keyLastFour: string;
}

/** Rust `credential_key_context`：太短的 Key 无法形成有意义的指纹，返回 null。 */
export function credentialKeyContext(apiKey: string): CredentialKeyContext | null {
  const chars = Array.from(apiKey.trim());
  if (chars.length < CREDENTIAL_KEY_PREFIX_CHARS + 4) return null;
  return {
    keyPrefix: chars.slice(0, CREDENTIAL_KEY_PREFIX_CHARS).join(""),
    keyLastFour: chars.slice(chars.length - 4).join(""),
  };
}

/**
 * 构造交给宿主的 extractor 函数表达式。
 *
 * 宿主以 `(<source>)(bundle, credential)` 调用（Rust `build_extractor_call` 同一形态），
 * 因此 source 必须是**单个函数表达式**：原始 `extractor_js` 作为内层函数求值，
 * 顶层的 helper 仍必须内联（与 Rust 的空结果报错文案互相印证）。
 *
 * - `aggregate === true`：第一实参是 `{ slot: parsedJson }` bundle；
 * - 否则：第一实参是唯一目标槽位的**原始响应字符串**（Rust 单响应模式的 payload）。
 */
export function buildExtractorSource(
  extractorJs: string,
  aggregate: boolean,
  targetSlot: string,
): string {
  const target = JSON.stringify(targetSlot);
  const lines = [
    "function (__flowlet_bundle, __flowlet_credential) {",
    `  var __flowlet_extract = (${extractorJs});`,
    "  var __flowlet_payload = __flowlet_bundle;",
  ];
  if (aggregate) {
    // 聚合模式：bundle 是 { slot: 已解析 JSON }。宿主可能只提供原始字符串
    // （runPlan 回退路径），这里统一解析；解析失败保留原串，交给 extractor 判断。
    lines.push(
      "  var __flowlet_parsed = {};",
      "  if (__flowlet_bundle && typeof __flowlet_bundle === 'object') {",
      "    Object.keys(__flowlet_bundle).forEach(function (key) {",
      "      var value = __flowlet_bundle[key];",
      "      if (typeof value === 'string') {",
      "        try { __flowlet_parsed[key] = JSON.parse(value); } catch (e) { __flowlet_parsed[key] = value; }",
      "      } else { __flowlet_parsed[key] = value; }",
      "    });",
      "  }",
      "  __flowlet_payload = __flowlet_parsed;",
    );
  } else {
    // 单响应模式：第一实参是唯一目标槽位的**原始响应字符串**。
    lines.push(
      `  var __flowlet_target = ${target};`,
      "  var __raw = __flowlet_bundle && Object.prototype.hasOwnProperty.call(__flowlet_bundle, __flowlet_target)",
      "    ? __flowlet_bundle[__flowlet_target]",
      "    : undefined;",
      "  __flowlet_payload = typeof __raw === 'string' ? __raw : JSON.stringify(__raw);",
    );
  }
  lines.push("  return __flowlet_extract(__flowlet_payload, __flowlet_credential);", "}");
  return lines.join("\n");
}

/**
 * Rust `parse_extractor_output` 的等价解析。
 *
 * wry 的 `eval_with_callback` 在脚本抛错时把异常吞成空串，因此空串必须单独报错，
 * 否则用户只会看到 JSON EOF。WebView2 会把 JS 字符串返回值再次 JSON 序列化。
 */
export function parseExtractorOutput(rawResult: unknown): unknown {
  if (rawResult === undefined) {
    // 宿主未返回 result（脚本抛错被吞成空/未执行 extractor）：与 Rust 空串同因。
    throw new Error(extractorEmptyResultMessage());
  }
  if (rawResult === null) {
    // JS 返回 null 时 wry 拿到字符串 "null"，Rust 报「返回空结果」而不是语法错误。
    throw new Error("extractor 返回空结果,请确认页面已加载目标数据");
  }
  let parsed: unknown = rawResult;
  if (typeof rawResult === "string") {
    if (rawResult.trim() === "") throw new Error(extractorEmptyResultMessage());
    try {
      parsed = JSON.parse(rawResult);
    } catch (error) {
      throw new Error(`extractor 输出解析失败: ${errorText(error)}, raw=${rawResult}`);
    }
  }
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new Error(`extractor 字符串结果解析失败: ${errorText(error)}, raw=${String(parsed)}`);
    }
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const errorField = (parsed as JsonRow)["error"];
    if (typeof errorField === "string") throw new Error(`extractor 执行错误: ${errorField}`);
  }
  if (parsed === null) throw new Error("extractor 返回空结果,请确认页面已加载目标数据");
  return parsed;
}

export function extractorEmptyResultMessage(): string {
  return (
    "extractor 未返回任何结果：脚本存在语法错误，或 extractor_js 不是单个函数声明" +
    "（Rust 以 (extractor_js)(bundle, credential) 形式调用，顶层不能再有第二条语句，" +
    "helper 需内联到该函数内）"
  );
}

/** Rust extractor 输出的字段读取（缺失/类型不符一律 null）。 */
export interface ExtractedBalance {
  balance: number | null;
  currency: string | null;
  plan_name: string | null;
  token_total: number | null;
  token_used: number | null;
  token_remaining: number | null;
  token_expire_at: string | null;
  token_packs: string | null;
}

export function readExtractedBalance(parsed: unknown): ExtractedBalance {
  const row: JsonRow =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRow)
      : {};
  const numberOrNull = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const integerOrNull = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) ? value : null;
  const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    balance: numberOrNull(row["balance"]),
    currency: stringOrNull(row["currency"]),
    plan_name: stringOrNull(row["plan_name"]),
    token_total: integerOrNull(row["token_total"]),
    token_used: integerOrNull(row["token_used"]),
    token_remaining: integerOrNull(row["token_remaining"]),
    token_expire_at: stringOrNull(row["token_expire_at"]),
    token_packs: Array.isArray(row["token_packs"]) ? JSON.stringify(row["token_packs"]) : null,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}