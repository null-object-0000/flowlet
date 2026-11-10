// TOML 解析与注释保留编辑（Codex `~/.codex/config.toml`）。
//
// Rust 侧使用 `toml_edit::DocumentMut`（保留注释/格式的文档级编辑）。Node 没有
// 等价的成熟文档编辑器，因此这里采用「smol-toml 只读解析 + 行级外科手术」：
// - 解析用 `smol-toml`（TOML 1.0，只读；最小依赖）；
// - 写入只改动 Flowlet 受管的 5 个顶层键与 `[model_providers.flowlet]` 表，
//   其余行（注释、顺序、其它表）逐字保留；
// - 顶层键替换时保留行尾注释；删除表时保留表外的注释与空行分隔。
//
// 已知限制：`model_providers` 若被写成顶层行内表（`model_providers = { ... }`），
// 行级编辑无法安全合并，这里显式报错而不是破坏文件。
import { parse as parseTomlText, TomlDate, TomlError } from "smol-toml";

import type { JsonRow } from "../types.ts";
import { errorText, readText, readTextOrNull } from "./fs.ts";
import { displayPath } from "./paths.ts";

/** 供备份使用的普通 JSON 值（TomlDate → RFC3339 字符串，bigint → number）。 */
export type TomlJson = string | number | boolean | null | TomlJson[] | { [key: string]: TomlJson };

/** 读取 TOML 文档；文件不存在返回空对象（Rust `read_codex_document`）。 */
export function readTomlValue(file: string): JsonRow {
  if (readTextOrNull(file) === null) return {};
  return parseToml(readText(file), displayPath(file));
}

export function parseToml(text: string, label: string): JsonRow {
  if (text.trim() === "") return {};
  try {
    const parsed = parseTomlText(text);
    return tomlToJson(parsed) as JsonRow;
  } catch (error) {
    if (error instanceof TomlError) {
      throw new Error(`解析 ${label} 失败：${error.message}`);
    }
    throw new Error(`解析 ${label} 失败：${errorText(error)}`);
  }
}

/** smol-toml 值 → 普通 JSON（用于备份快照）。 */
export function tomlToJson(value: unknown): TomlJson {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return Number(value);
  if (value instanceof TomlDate) return value.toISOString();
  if (Array.isArray(value)) return value.map(tomlToJson);
  if (typeof value === "object") {
    const result: { [key: string]: TomlJson } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = tomlToJson(item);
    }
    return result;
  }
  return null;
}

/** 顶层键读取（Rust `codex_top_level_value`）。 */
export function tomlTopLevelValue(root: JsonRow, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(root, key) ? root[key] : undefined;
}

/** `[model_providers.<id>]` 表读取（Rust `codex_flowlet_provider_table`）。 */
export function tomlProviderTable(root: JsonRow, providerId: string): JsonRow | undefined {
  const providers = root.model_providers;
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
    return undefined;
  }
  const table = (providers as JsonRow)[providerId];
  return table !== null && typeof table === "object" && !Array.isArray(table)
    ? (table as JsonRow)
    : undefined;
}

// ─── 行级编辑 ───────────────────────────────────────────────────────────────

interface TextLines {
  lines: string[];
  newline: string;
}

function splitLines(text: string): TextLines {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return { lines: text.replace(/\r\n/gu, "\n").split("\n"), newline };
}

function joinLines(value: TextLines): string {
  const output = value.lines.join(value.newline);
  return output;
}

function isTableHeader(line: string): boolean {
  return /^\s*\[\[?.+?\]\]?\s*(?:#.*)?$/u.test(line);
}

function topLevelKeyRegex(key: string): RegExp {
  return new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=\\s*(.*)$`, "u");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** 把 `a = value # comment` 的右侧拆成值与注释（引号内的 `#` 不算注释）。 */
function splitTomlValueAndComment(rest: string): { value: string; comment: string } {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < rest.length; index += 1) {
    const character = rest[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") {
      return { value: rest.slice(0, index).trimEnd(), comment: rest.slice(index) };
    }
  }
  return { value: rest.trimEnd(), comment: "" };
}

/** 统计行内方括号/花括号未闭合深度（忽略字符串与注释）。 */
function bracketDelta(value: string): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") break;
    if (character === "[" || character === "{") depth += 1;
    if (character === "]" || character === "}") depth -= 1;
  }
  return depth;
}

/** 找到顶层键所在行；`start` 限定扫描范围，跳过表内键。 */
function findTopLevelKeyLine(
  lines: ReadonlyArray<string>,
  key: string,
  start = 0,
): number | null {
  const pattern = topLevelKeyRegex(key);
  let inTable = false;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (isTableHeader(line)) {
      inTable = true;
      continue;
    }
    if (inTable) continue;
    if (pattern.test(line)) return index;
  }
  return null;
}

function serializeTomlLiteral(value: TomlJson): string {
  if (value === null) return '""';
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "0";
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(serializeTomlLiteral).join(", ")}]`;
  const entries = Object.entries(value).map(
    ([key, item]) => `${serializeTomlKey(key)} = ${serializeTomlLiteral(item)}`,
  );
  return `{ ${entries.join(", ")} }`;
}

function serializeTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(key) ? key : JSON.stringify(key);
}

/**
 * 设置/替换顶层键的值，保留行首缩进与行尾注释；不存在时插入到第一个表头之前
 * （无表头时追加到文件末尾）。
 */
export function setTomlTopLevelValue(text: string, key: string, value: TomlJson): string {
  const parsed = splitLines(text);
  const literal = serializeTomlLiteral(value);
  const hadTrailingNewline = text.endsWith("\n");
  const index = findTopLevelKeyLine(parsed.lines, key);
  if (index !== null) {
    const line = parsed.lines[index];
    const match = topLevelKeyRegex(key).exec(line);
    if (match !== null) {
      const { comment } = splitTomlValueAndComment(match[2]);
      parsed.lines[index] = `${match[1]}${key} = ${literal}${comment === "" ? "" : ` ${comment}`}`;
    }
    return withTrailingNewline(joinLines(parsed), hadTrailingNewline);
  }
  const firstTable = parsed.lines.findIndex((line) => isTableHeader(line));
  const insertion = firstTable < 0 ? parsed.lines.length : firstTable;
  // 在插入点之前保留一个空行分隔（文件本身为空时不加）。
  const hasContent = parsed.lines.some((line) => line.trim() !== "");
  if (hasContent && insertion > 0 && parsed.lines[insertion - 1].trim() !== "") {
    parsed.lines.splice(insertion, 0, `${key} = ${literal}`, "");
  } else {
    parsed.lines.splice(insertion, 0, `${key} = ${literal}`);
  }
  return withTrailingNewline(joinLines(parsed), hadTrailingNewline);
}

function withTrailingNewline(value: string, expected: boolean): string {
  if (!expected) return value;
  return value.endsWith("\n") ? value : `${value}\n`;
}

/** 删除顶层键；多行值会整段删除。 */
export function removeTomlTopLevelValue(text: string, key: string): string {
  const parsed = splitLines(text);
  const index = findTopLevelKeyLine(parsed.lines, key);
  if (index === null) return text;
  let end = index + 1;
  const rest = splitTomlValueAndComment(
    topLevelKeyRegex(key).exec(parsed.lines[index])?.[2] ?? "",
  ).value;
  let depth = bracketDelta(rest);
  while (depth > 0 && end < parsed.lines.length) {
    depth += bracketDelta(parsed.lines[end]);
    end += 1;
  }
  const hadTrailingNewline = text.endsWith("\n");
  parsed.lines.splice(index, end - index);
  return withTrailingNewline(joinLines(parsed), hadTrailingNewline);
}

function providerTableHeaderRegex(providerId: string): RegExp {
  const id = escapeRegExp(providerId);
  return new RegExp(`^\\s*\\[\\s*(?:model_providers\\s*\\.\\s*(?:${id}|"${id}"))\\s*\\]\\s*(?:#.*)?$`, "u");
}

function modelProvidersHeaderRegex(): RegExp {
  return /^\s*\[\s*model_providers\s*\]\s*(?:#.*)?$/u;
}

/** `[model_providers.flowlet]` 块的文本（不含尾部空行）。 */
export function renderProviderTable(
  providerId: string,
  table: Readonly<Record<string, TomlJson>>,
): string[] {
  const lines = [`[model_providers.${serializeTomlKey(providerId)}]`];
  for (const [key, value] of Object.entries(table)) {
    lines.push(`${serializeTomlKey(key)} = ${serializeTomlLiteral(value)}`);
  }
  return lines;
}

/** 设置/替换 `[model_providers.<id>]` 表；其余内容逐字保留。 */
export function setTomlProviderTable(
  text: string,
  providerId: string,
  table: Readonly<Record<string, TomlJson>>,
): string {
  const parsed = splitLines(text);
  if (parsed.lines.some((line) => /^\s*model_providers\s*=\s*\{/u.test(line))) {
    throw new Error(
      "Codex 配置中的 model_providers 使用了行内表写法，无法安全改写；请改为 [model_providers.*] 表",
    );
  }
  const header = providerTableHeaderRegex(providerId);
  const headerIndex = parsed.lines.findIndex((line) => header.test(line));
  const rendered = renderProviderTable(providerId, table);
  if (headerIndex >= 0) {
    let end = headerIndex + 1;
    while (end < parsed.lines.length && !isTableHeader(parsed.lines[end])) end += 1;
    let bodyEnd = end;
    while (bodyEnd > headerIndex + 1 && parsed.lines[bodyEnd - 1].trim() === "") bodyEnd -= 1;
    parsed.lines.splice(headerIndex, bodyEnd - headerIndex, ...rendered);
    return withTrailingNewline(joinLines(parsed), text.endsWith("\n"));
  }
  // 追加到文件末尾（Rust 新增子表同样渲染在文档尾部）。
  const prefix: string[] = [];
  if (parsed.lines.length > 0 && parsed.lines[parsed.lines.length - 1].trim() !== "") {
    prefix.push("");
  }
  parsed.lines.push(...prefix, ...rendered);
  return withTrailingNewline(joinLines(parsed), text.endsWith("\n"));
}

/** 删除 `[model_providers.<id>]` 表；父表因此变空时一并删除。 */
export function removeTomlProviderTable(text: string, providerId: string): string {
  const parsed = splitLines(text);
  const header = providerTableHeaderRegex(providerId);
  const headerIndex = parsed.lines.findIndex((line) => header.test(line));
  if (headerIndex < 0) return text;
  let end = headerIndex + 1;
  while (end < parsed.lines.length && !isTableHeader(parsed.lines[end])) end += 1;
  let bodyEnd = end;
  while (bodyEnd > headerIndex + 1 && parsed.lines[bodyEnd - 1].trim() === "") bodyEnd -= 1;
  parsed.lines.splice(headerIndex, bodyEnd - headerIndex);
  // 删除块前由 Flowlet 追加的分隔空行（块位于文件末尾或紧邻下一个表头时）。
  if (
    headerIndex > 0 &&
    parsed.lines[headerIndex - 1].trim() === "" &&
    (headerIndex >= parsed.lines.length - 1 || isTableHeader(parsed.lines[headerIndex]))
  ) {
    parsed.lines.splice(headerIndex - 1, 1);
  }
  // 父表 `[model_providers]` 若已无键且无注释，一并移除。
  const parentIndex = parsed.lines.findIndex((line) => modelProvidersHeaderRegex().test(line));
  if (parentIndex >= 0) {
    let parentEnd = parentIndex + 1;
    while (parentEnd < parsed.lines.length && !isTableHeader(parsed.lines[parentEnd])) {
      parentEnd += 1;
    }
    const body = parsed.lines.slice(parentIndex + 1, parentEnd);
    const hasContent = body.some((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    if (!hasContent) {
      let removeEnd = parentEnd;
      while (removeEnd > parentIndex + 1 && parsed.lines[removeEnd - 1].trim() === "") removeEnd -= 1;
      parsed.lines.splice(parentIndex, removeEnd - parentIndex);
    }
  }
  const output = joinLines(parsed).replace(/\n{3,}/gu, "\n\n");
  return withTrailingNewline(output, text.endsWith("\n"));
}

/** 返回按表头解析后的顶层键集合（供 inspect 使用）。 */
export function tomlTopLevelKeys(text: string): Set<string> {
  const parsed = splitLines(text);
  const keys = new Set<string>();
  let inTable = false;
  for (const line of parsed.lines) {
    if (isTableHeader(line)) {
      inTable = true;
      continue;
    }
    if (inTable) continue;
    const match = /^\s*([A-Za-z0-9_-]+)\s*=/u.exec(line);
    if (match !== null) keys.add(match[1]);
  }
  return keys;
}