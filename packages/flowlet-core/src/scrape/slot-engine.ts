// 抓取模式的槽位引擎：URL → 槽位分类、槽位有效性校验、同槽位多批合并。
//
// 权威行为：src-tauri/src/core/scrape_console.rs 的 `ScrapeSlotEngine` +
// core/channel_capability_adapter.rs（内置 adapter 分派）+
// core/channel_capability_adapter/adapters/{longcat,qwen,zhipu}.rs。
//
// 分派规则与 Rust 一致：内置渠道（`slotRules === null`）走编译期 adapter；
// 自定义描述符（`slotRules !== null`）走声明式规则。命令层与宿主都只通过
// 本模块判定「这个响应属于哪个槽位」「是否算抓全」，禁止各自复制一份。
import type { JsonRow } from "../types.ts";
import {
  mergeArrays,
  parseJsonOrNull,
  slotSatisfies,
  urlMatches,
  type CustomSlotRule,
  type LoginKind,
  type UrlMatcher,
} from "./custom-registry.ts";
import { hasLoginPath } from "./custom-registry.ts";

/** 与 Rust `core::scrape_console::ScrapeModeRuntime` 等价的抓取模式。 */
export interface ScrapeMode {
  consoleUrl: string;
  consoleUrlSecondary: string | null;
  consoleUrlTertiary: string | null;
  interceptorJs: string;
  extractorJs: string;
  aggregate: boolean;
  requiredSlots: string[];
  /** 自定义描述符槽位规则；内置渠道为 null。 */
  slotRules: CustomSlotRule[] | null;
  /** 自定义描述符登录页规则；内置渠道为 null（走 adapter 声明）。 */
  login: LoginKind | null;
  /** 自定义描述符的去敏计划名；内置渠道为 null。 */
  summaryPlan: string | null;
}

/** Rust `is_explicit_login_url_with_mode`。 */
export function isExplicitLoginUrl(
  mode: ScrapeMode,
  channelId: string,
  pageUrl: string,
): boolean {
  if (mode.login !== null) {
    switch (mode.login.kind) {
      case "none":
        return false;
      case "generic":
        return hasLoginPath(pageUrl);
      case "generic_or_host":
        return hasLoginPath(pageUrl) || pageUrl.toLowerCase().includes(mode.login.host);
    }
  }
  return builtinLoginPageMatches(channelId, pageUrl);
}

/** Rust `is_explicit_login_url`（内置 adapter 的 LoginPageAdapter）。 */
function builtinLoginPageMatches(channelId: string, pageUrl: string): boolean {
  const loginPage = BUILTIN_ADAPTERS[channelId]?.loginPage;
  if (loginPage === undefined || loginPage.kind === "none") return false;
  const url = pageUrl.toLowerCase();
  const hasPath = hasLoginPath(pageUrl);
  return loginPage.kind === "generic" ? hasPath : hasPath || url.includes(loginPage.host);
}

// ─── URL 分类 ───────────────────────────────────────────────────────────────

/** Rust `ScrapeSlotEngine::classify`。 */
export function classifySlot(mode: ScrapeMode, url: string): string {
  if (mode.slotRules !== null) {
    for (const rule of mode.slotRules) {
      if (rule.match !== null && rule.match.kind !== "fallback" && urlMatches(rule.match, url)) {
        return rule.key;
      }
    }
    const fallback = mode.slotRules.find((rule) => rule.match === null || rule.match.kind === "fallback");
    return fallback === undefined ? "unknown" : fallback.key;
  }
  return classifyBuiltinResponseUrl(url);
}

/** Rust `classify_scrape_response_url`：首个给出非 None 结论的 adapter 生效。 */
export function classifyBuiltinResponseUrl(url: string): string {
  for (const adapter of Object.values(BUILTIN_ADAPTERS)) {
    const kind = adapter.classify(url);
    if (kind !== null) return kind;
  }
  return "unknown";
}

// ─── 槽位有效性 ─────────────────────────────────────────────────────────────

/** Rust `ScrapeSlotEngine::satisfies`。 */
export function slotSatisfied(mode: ScrapeMode, kind: string, body: string): boolean {
  if (mode.slotRules !== null) {
    const rule = mode.slotRules.find((item) => item.key === kind);
    if (rule !== undefined) return slotSatisfies(rule.satisfies, body);
    return parseJsonOrNull(body) !== null;
  }
  return builtinSlotSatisfied(kind, body);
}

/**
 * Rust `scrape_response_satisfies_slot`：任一 adapter 判定满足即满足；
 * 所有处理该槽位的 adapter 都判定不满足才视为不满足；没有 adapter 处理该槽位时
 * 退回「合法 JSON 即视为到位」。
 */
export function builtinSlotSatisfied(kind: string, body: string): boolean {
  let sawRejection = false;
  for (const adapter of Object.values(BUILTIN_ADAPTERS)) {
    const verdict = adapter.satisfies(kind, body);
    if (verdict === true) return true;
    if (verdict === false) sawRejection = true;
  }
  if (sawRejection) return false;
  return parseJsonOrNull(body) !== null;
}

// ─── 同槽位合并 ─────────────────────────────────────────────────────────────

/** Rust `ScrapeSlotEngine::merge`：返回 null 表示「同槽位最新覆盖旧」。 */
export function mergeSlot(
  mode: ScrapeMode,
  kind: string,
  existing: string,
  incoming: string,
): string | null {
  if (mode.slotRules !== null) {
    const rule = mode.slotRules.find((item) => item.key === kind);
    if (rule !== undefined && rule.merge.kind === "merge_arrays") {
      return mergeArrays(rule.merge.path, rule.merge.dedupBy, rule.merge.keepFields, existing, incoming);
    }
    return null;
  }
  for (const adapter of Object.values(BUILTIN_ADAPTERS)) {
    const merged = adapter.merge(kind, existing, incoming);
    if (merged !== null) return merged;
  }
  return null;
}

/**
 * Rust `record_captured_response`：把一条业务响应写入账号缓冲。
 *
 * - 同槽位已存在：先尝试合并；否则默认「最新覆盖」，
 *   但若已有响应满足槽位而新响应不满足（残缺体），保留已有完整响应。
 */
export function recordCapturedResponse(
  entry: Array<[string, string]>,
  url: string,
  body: string,
  mode: ScrapeMode,
): void {
  const kind = classifySlot(mode, url);
  const index = entry.findIndex(([existingUrl]) => classifySlot(mode, existingUrl) === kind);
  if (index >= 0) {
    const merged = mergeSlot(mode, kind, entry[index]![1], body);
    if (merged !== null) {
      entry[index] = [url, merged];
      return;
    }
    if (slotSatisfied(mode, kind, entry[index]![1]) && !slotSatisfied(mode, kind, body)) {
      return;
    }
    entry[index] = [url, body];
    return;
  }
  for (let i = entry.length - 1; i >= 0; i -= 1) {
    if (classifySlot(mode, entry[i]![0]) === kind) entry.splice(i, 1);
  }
  entry.push([url, body]);
}

/** Rust `collect_scrape_slots`：只保留满足校验的槽位。 */
export function collectSlots(
  responses: Array<[string, string]>,
  mode: ScrapeMode,
): Map<string, string> {
  const slots = new Map<string, string>();
  for (const [url, body] of responses) {
    const kind = classifySlot(mode, url);
    if (slotSatisfied(mode, kind, body)) slots.set(kind, body);
  }
  return slots;
}

// ─── 阶段/完成判定 ──────────────────────────────────────────────────────────

/** Rust `required_slots_for_phase`。 */
export function requiredSlotsForPhase(
  mode: ScrapeMode,
  phaseIndex: number,
  phaseCount: number,
): string[] {
  if (!mode.aggregate || mode.requiredSlots.length === 0) return [];
  if (phaseCount <= 1) return mode.requiredSlots.slice();
  if (mode.requiredSlots.length === phaseCount) return [mode.requiredSlots[phaseIndex] as string];
  if (phaseIndex + 1 === phaseCount) return mode.requiredSlots.slice();
  return [];
}

/** Rust `missing_required_slots`。 */
export function missingRequiredSlots(slots: Map<string, string>, required: string[]): string[] {
  return required.filter((slot) => !slots.has(slot));
}

/** Rust `aggregate_complete`。 */
export function aggregateComplete(slots: Map<string, string>, mode: ScrapeMode): boolean {
  if (mode.aggregate) {
    if (mode.requiredSlots.length === 0) {
      return slots.has("token_packs_summary") || slots.has("api_usage_summary");
    }
    return mode.requiredSlots.every((slot) => slots.has(slot));
  }
  return slots.has("token_packs_summary") || slots.has("api_usage_summary");
}

/** Rust `build_aggregate_bundle`：把槽位原文解析成 JSON 对象供 extractor 使用。 */
export function buildAggregateBundle(slots: Map<string, string>): JsonRow {
  const bundle: JsonRow = {};
  for (const [key, body] of slots) {
    const parsed = parseJsonOrNull(body);
    if (parsed !== null) bundle[key] = parsed;
  }
  return bundle;
}

/**
 * 单响应模式下 extractor 的输入槽位（Rust `scrape_balance`）。
 * `tab=api` 的 LongCat 控制台对应按量余额槽，其余按资源包槽。
 */
export function singleResponseTargetSlot(mode: ScrapeMode): "api_usage_summary" | "token_packs_summary" {
  return mode.consoleUrl.includes("tab=api") ? "api_usage_summary" : "token_packs_summary";
}

/** 抓取步骤：按 mode 的三个 URL 展开导航阶段（跳过空值）。 */
export function scrapePhases(mode: ScrapeMode): string[] {
  return [mode.consoleUrl, mode.consoleUrlSecondary, mode.consoleUrlTertiary].filter(
    (url): url is string => typeof url === "string" && url !== "",
  );
}

// ─── 宿主 ScrapePlan.slotRules 的构造 ───────────────────────────────────────

/**
 * 宿主 `ScrapeSlotRule`（`packages/flowlet-desktop/src/scrape.ts`）。
 * 命令层不 import 宿主（宿主是 electron 依赖，命令层禁止 import electron），
 * 这里按契约本地声明结构，逐字段对齐。
 */
export interface ScrapePlanRule {
  slot: string;
  urlContains?: string[];
  urlRegex?: string;
  /** 未命中任何显式规则时归属此槽位（与自定义描述符 `fallback` 语义一致）。 */
  fallback?: boolean;
}

/** 内置渠道的 URL → 槽位规则（宿主只做子串/正则匹配，语义与 adapter 等价）。 */
const BUILTIN_PLAN_RULES: Record<string, ReadonlyArray<{ slot: string; urlContains: string[] }>> = {
  longcat: [
    {
      slot: "token_packs_list",
      urlContains: ["/api/pay/commercial/entitlements/token-packs/list"],
    },
    {
      slot: "token_packs_summary",
      urlContains: ["/api/pay/quota/metering/token-packs/summary"],
    },
    {
      slot: "api_usage_summary",
      urlContains: ["/api/pay/quota/metering/api-usage/summary"],
    },
  ],
  qwen: [
    { slot: "freetier_list", urlContains: ["listbailianfreetier"] },
    { slot: "fq_instance", urlContains: ["describefqinstance"] },
    { slot: "billing_amount", urlContains: ["getbillingaccountavailableamount"] },
    { slot: "settle_bill", urlContains: ["listsettlebilltotalsummary"] },
    { slot: "cert_info", urlContains: ["querycurrentcertinfo"] },
    { slot: "session_info", urlContains: ["tool/user/info.json"] },
    { slot: "subscription", urlContains: ["/tokenplan/personal/api/v2/subscription"] },
    { slot: "quota_config", urlContains: ["/tokenplan/personal/api/v2/quota-config"] },
    { slot: "reset_card_list", urlContains: ["/tokenplan/personal/api/v2/reset-card/list"] },
    { slot: "usage", urlContains: ["/tokenplan/personal/api/v2/usage"] },
  ],
  zhipu: [
    { slot: "token_packs_list", urlContains: ["tokenaccounts/list/my"] },
    { slot: "account_report", urlContains: ["account/query-customer-account-report"] },
  ],
};

/**
 * 内置渠道的宿主槽位规则。
 *
 * 只产出本渠道抓取真正需要的槽位：`requiredSlots` 为空时用整张表（单响应模式仍要
 * 能按 URL 归类），否则收窄到必需槽位，避免 LongCat 的 usage 明细/埋点响应被
 * 误当成业务槽位。
 */
export function builtinSlotRules(channelId: string, requiredSlots: string[]): ScrapePlanRule[] {
  const table = BUILTIN_PLAN_RULES[channelId] ?? [];
  const wanted =
    requiredSlots.length === 0
      ? table
      : table.filter((rule) => requiredSlots.includes(rule.slot));
  return wanted.map((rule) => ({ slot: rule.slot, urlContains: [...rule.urlContains] }));
}

/** 自定义描述符声明式规则 → 宿主 ScrapePlanRule。 */
export function customSlotRules(slotRules: CustomSlotRule[]): ScrapePlanRule[] {
  const rules: ScrapePlanRule[] = [];
  for (const rule of slotRules) {
    const matcher = rule.match;
    if (matcher === null || matcher.kind === "fallback") {
      rules.push({ slot: rule.key, fallback: true });
      continue;
    }
    switch (matcher.kind) {
      case "substring":
        rules.push({
          slot: rule.key,
          // 宿主 `urlContains` 区分大小写；`caseInsensitive` 时把常见大小写变体
          // 都收起不便，改用正则的 inline 大小写修饰符等价表达。
          urlRegex: matcher.caseInsensitive
            ? `(?i:${escapeRegex(matcher.value)})`
            : undefined,
          urlContains: matcher.caseInsensitive ? [matcher.value] : [matcher.value],
        });
        break;
      case "prefix":
        rules.push({ slot: rule.key, urlRegex: `^${escapeRegex(matcher.value)}` });
        break;
      case "exact": {
        const withoutQuery = matcher.value.split("?")[0] ?? matcher.value;
        rules.push({
          slot: rule.key,
          urlRegex: `^${escapeRegex(stripTrailingSlash(withoutQuery))}/?(?:\\?|$)`,
        });
        break;
      }
      case "regex":
        rules.push({ slot: rule.key, urlRegex: matcher.pattern });
        break;
    }
  }
  return rules;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

// ─── 内置渠道 adapter（Rust channel_capability_adapter/adapters/*） ──────────

interface BuiltinAdapter {
  loginPage: { kind: "none" } | { kind: "generic" } | { kind: "generic_or_host"; host: string };
  classify(url: string): string | null;
  /**
   * `true` / `false`：本 adapter 对该槽位有明确结论；
   * `null`：本 adapter 不处理该槽位。
   */
  satisfies(kind: string, body: string): boolean | null;
  merge(kind: string, existing: string, incoming: string): string | null;
}

function normalizeUrl(url: string): string {
  return url.toLowerCase().replace(/%2f/g, "/");
}

/** LongCat（adapters/longcat.rs）。 */
const LONGCAT_ADAPTER: BuiltinAdapter = {
  loginPage: { kind: "generic" },
  classify(url) {
    const normalized = normalizeUrl(url);
    if (normalized.includes("/api/pay/commercial/entitlements/token-packs/list")) return "token_packs_list";
    if (normalized.includes("/api/pay/quota/metering/token-packs/summary")) return "token_packs_summary";
    if (normalized.includes("/api/pay/quota/metering/api-usage/summary")) return "api_usage_summary";
    return null;
  },
  satisfies(kind, body) {
    if (!["token_packs_list", "token_packs_summary", "api_usage_summary"].includes(kind)) return null;
    const root = parseJsonOrNull(body);
    if (root === null) return false;
    if (kind !== "token_packs_list") return true;
    const record = asObjectOrNull(root);
    if (record !== null && typeof record["code"] === "number" && record["code"] !== 0) return false;
    const data = asObjectOrNull(record?.["data"]) ?? record ?? {};
    const items = data["items"];
    if (!Array.isArray(items)) return false;
    const historyCount = toUint(data["historyCount"]);
    const pageSize = data["pageSize"] === undefined ? historyCount : toUint(data["pageSize"]);
    if (historyCount === 0) return pageSize > 1;
    const expectedHistoryItems = Math.min(historyCount, Math.max(pageSize, 1));
    const hasStatusCodes = items.some(
      (item) => asObjectOrNull(item)?.["statusCode"] !== undefined ||
        asObjectOrNull(item)?.["displayStatusCode"] !== undefined,
    );
    const captured = hasStatusCodes
      ? items.filter((item) => {
          const row = asObjectOrNull(item);
          if (row === null) return false;
          const status = row["statusCode"] ?? row["displayStatusCode"];
          return typeof status === "number" && status !== 1;
        }).length
      : items.length;
    return captured >= expectedHistoryItems;
  },
  merge(kind, existing, incoming) {
    return kind === "token_packs_list" ? mergeLongcatTokenPackList(existing, incoming) : null;
  },
};

function tokenPackItemKey(item: unknown): string {
  const row = asObjectOrNull(item);
  if (row === null) return JSON.stringify(item) ?? "";
  const id = row["resourceId"] ?? row["packageId"];
  if (typeof id === "string") return id;
  if (typeof id === "number") return String(id);
  return JSON.stringify(item) ?? "";
}

/** Rust `merge_token_pack_list`：按 resourceId/packageId 合并，计数取 max。 */
function mergeLongcatTokenPackList(existing: string, incoming: string): string | null {
  const existingRoot = asObjectOrNull(parseJsonOrNull(existing));
  const incomingRoot = asObjectOrNull(parseJsonOrNull(incoming));
  if (existingRoot === null || incomingRoot === null) return null;
  const existingData = asObjectOrNull(existingRoot["data"]) ?? existingRoot;
  const incomingData = asObjectOrNull(incomingRoot["data"]) ?? incomingRoot;
  const existingItems = existingData["items"];
  const incomingItems = incomingData["items"];
  if (!Array.isArray(existingItems) || !Array.isArray(incomingItems)) return null;

  const mergedItems: unknown[] = [];
  const indexes = new Map<string, number>();
  for (const item of [...existingItems, ...incomingItems]) {
    const key = tokenPackItemKey(item);
    const index = indexes.get(key);
    if (index !== undefined) mergedItems[index] = item;
    else {
      indexes.set(key, mergedItems.length);
      mergedItems.push(item);
    }
  }

  const mergedLength = mergedItems.length;
  const target = asObjectOrNull(existingRoot["data"]) ?? existingRoot;
  target["items"] = mergedItems;
  for (const field of ["activeCount", "historyCount", "total", "pageSize", "totalPage"]) {
    let value = Math.max(toUint(existingData[field]), toUint(incomingData[field]));
    if (field === "total") value = Math.max(value, mergedLength);
    target[field] = value;
  }
  if (existingRoot["data"] === undefined) {
    // 无信封的响应：合并结果直接写回根对象（Rust 用 `&mut existing_root` 同一语义）。
    return JSON.stringify(target);
  }
  return JSON.stringify(existingRoot);
}

/** Qwen（adapters/qwen.rs）。 */
const QWEN_ADAPTER: BuiltinAdapter = {
  loginPage: { kind: "generic_or_host", host: "account.aliyun.com" },
  classify(url) {
    const normalized = normalizeUrl(url);
    if (normalized.includes("listbailianfreetier")) return "freetier_list";
    if (normalized.includes("describefqinstance")) return "fq_instance";
    if (normalized.includes("getbillingaccountavailableamount")) return "billing_amount";
    if (normalized.includes("listsettlebilltotalsummary")) return "settle_bill";
    if (normalized.includes("querycurrentcertinfo")) return "cert_info";
    if (normalized.includes("tool/user/info.json")) return "session_info";
    if (normalized.includes("/tokenplan/personal/api/v2/subscription")) return "subscription";
    if (normalized.includes("/tokenplan/personal/api/v2/quota-config")) return "quota_config";
    if (normalized.includes("/tokenplan/personal/api/v2/reset-card/list")) return "reset_card_list";
    if (normalized.includes("/tokenplan/personal/api/v2/usage")) return "usage";
    return null;
  },
  satisfies(kind, body) {
    const tokenPlanKinds = ["subscription", "quota_config", "reset_card_list", "usage"];
    if (tokenPlanKinds.includes(kind)) return tokenPlanPayloadSatisfied(kind, body);
    const root = asObjectOrNull(parseJsonOrNull(body));
    if (root === null) return null;
    const data = asObjectOrNull(root["data"]);
    switch (kind) {
      case "freetier_list":
      case "fq_instance":
      case "settle_bill":
        return Array.isArray(data?.["Data"]) ? true : false;
      case "billing_amount":
        return typeof data?.["AvailableAmount"] === "number";
      case "cert_info":
        return typeof data?.["certified"] === "boolean";
      case "session_info": {
        const token = data?.["secToken"];
        return typeof token === "string" && token !== "";
      }
      default:
        return null;
    }
  },
  merge(kind, existing, incoming) {
    return kind === "fq_instance" ? mergeFqInstanceResponses(existing, incoming) : null;
  },
};

/** Token Plan 的额度窗口键（与 Rust `TOKEN_PLAN_QUOTA_WINDOWS` 一致）。 */
const TOKEN_PLAN_QUOTA_WINDOWS = ["five_hour", "weekly", "monthly"];

function isUsagePercentageKey(key: string): boolean {
  return key.startsWith("per") && key.endsWith("Percentage");
}

function tokenPlanPayloadSatisfied(kind: string, body: string): boolean | null {
  const root = asObjectOrNull(parseJsonOrNull(body));
  if (root === null) return null;
  const payload = asObjectOrNull(
    asObjectOrNull(asObjectOrNull(root["data"])?.["DataV2"])?.["data"],
  )?.["data"];
  switch (kind) {
    case "subscription":
      return payload !== null && payload !== undefined && typeof payload === "object";
    case "quota_config": {
      const tiers = asObjectOrNull(payload);
      if (tiers === null) return false;
      return Object.values(tiers).some((tier) => {
        const row = asObjectOrNull(tier);
        if (row === null) return false;
        return TOKEN_PLAN_QUOTA_WINDOWS.some((key) => typeof row[key] === "number");
      });
    }
    case "usage": {
      const usage = asObjectOrNull(payload);
      if (usage === null) return false;
      return Object.entries(usage).some(
        ([key, value]) => isUsagePercentageKey(key) && typeof value === "number",
      );
    }
    case "reset_card_list":
      return Array.isArray(payload) || asObjectOrNull(payload) !== null;
    default:
      return null;
  }
}

/** Rust `merge_fq_instance_responses`：按 `Template.Code` 去重并裁剪白名单字段。 */
function mergeFqInstanceResponses(existing: string, incoming: string): string | null {
  const existingRoot = asObjectOrNull(parseJsonOrNull(existing));
  const incomingRoot = asObjectOrNull(parseJsonOrNull(incoming));
  if (existingRoot === null || incomingRoot === null) return null;
  const existingItems = asObjectOrNull(existingRoot["data"])?.["Data"];
  const incomingItems = asObjectOrNull(incomingRoot["data"])?.["Data"];
  if (!Array.isArray(existingItems) || !Array.isArray(incomingItems)) return null;

  const order: string[] = [];
  const byCode = new Map<string, unknown>();
  for (const item of [...existingItems, ...incomingItems]) {
    const code = asObjectOrNull(asObjectOrNull(item)?.["Template"])?.["Code"];
    if (typeof code !== "string" || code === "") continue;
    if (!byCode.has(code)) order.push(code);
    byCode.set(code, item);
  }
  const merged: unknown[] = [];
  for (const code of order) {
    const kept = keepFqInstanceFields(byCode.get(code));
    if (kept !== undefined) merged.push(kept);
  }
  return JSON.stringify({ data: { Data: merged, TotalCount: merged.length } });
}

function keepFqInstanceFields(value: unknown): unknown {
  const record = asObjectOrNull(value);
  const template = asObjectOrNull(record?.["Template"]);
  const code = template?.["Code"];
  if (record === null || typeof code !== "string") return undefined;
  const name = typeof template?.["Name"] === "string" ? template["Name"] : "";
  const instance: JsonRow = { Template: { Code: code, Name: name } };
  for (const key of [
    "Status",
    "InitCapacity",
    "CurrCapacity",
    "CurrentCycleStartTime",
    "CurrentCycleEndTime",
    "EndTime",
  ]) {
    if (record[key] !== undefined) instance[key] = record[key];
  }
  return instance;
}

/** Z.AI / Zhipu（adapters/zhipu.rs）。 */
const ZHIPU_ADAPTER: BuiltinAdapter = {
  loginPage: { kind: "generic" },
  classify(url) {
    const normalized = normalizeUrl(url);
    if (normalized.includes("tokenaccounts/list/my")) return "token_packs_list";
    if (normalized.includes("account/query-customer-account-report")) return "account_report";
    return null;
  },
  satisfies(kind, body) {
    const root = asObjectOrNull(parseJsonOrNull(body));
    if (root === null) return null;
    const code = root["code"];
    const codeOk =
      (typeof code === "number" && code === 200) ||
      (typeof code === "string" && code.trim() === "200");
    if (kind === "token_packs_list") {
      return codeOk && Array.isArray(root["rows"]);
    }
    if (kind === "account_report") {
      return codeOk || root["success"] === true;
    }
    return null;
  },
  merge() {
    return null;
  },
};

const BUILTIN_ADAPTERS: Record<string, BuiltinAdapter> = {
  longcat: LONGCAT_ADAPTER,
  qwen: QWEN_ADAPTER,
  zhipu: ZHIPU_ADAPTER,
};

/** Rust `ConsoleScrapeAdapter`：渠道 → 资源模式 → 抓取模式键。 */
type ConsoleScrapeAdapter =
  | { kind: "none" }
  | { kind: "fixed"; modeKey: string }
  | { kind: "resource_modes"; modes: ReadonlyArray<readonly [string, string]> };

const CONSOLE_SCRAPE_ADAPTERS: Record<string, ConsoleScrapeAdapter> = {
  longcat: { kind: "fixed", modeKey: "hybrid" },
  qwen: {
    kind: "resource_modes",
    modes: [
      ["token_plan", "token_plan"],
      ["pay_as_you_go", "freetier"],
    ],
  },
  zhipu: { kind: "resource_modes", modes: [["pay_as_you_go", "paygo"]] },
};

/** Rust `channel_capability_adapter::console_scrape_mode_key`。 */
export function consoleScrapeModeKey(channelId: string, resourceMode: string | null): string | null {
  const adapter = CONSOLE_SCRAPE_ADAPTERS[channelId];
  if (adapter === undefined) return null;
  switch (adapter.kind) {
    case "none":
      return null;
    case "fixed":
      return adapter.modeKey;
    case "resource_modes":
      return adapter.modes.find(([required]) => required === resourceMode)?.[1] ?? null;
  }
}

/** Rust `scrape_console::default_resource_mode`。 */
export function defaultResourceMode(channelId: string): string {
  switch (channelId) {
    case "longcat":
      return "hybrid";
    case "qwen":
    case "zhipu":
      return "pay_as_you_go";
    default:
      return "pay_as_you_go";
  }
}

function asObjectOrNull(value: unknown): JsonRow | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRow)
    : null;
}

function toUint(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export type { CustomSlotRule, UrlMatcher };