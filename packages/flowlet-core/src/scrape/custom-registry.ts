// 自定义渠道抓取描述符（文件夹发现机制）的 Node 等价实现。
//
// 权威行为：src-tauri/src/core/custom_scrape.rs（v1 schema，见
// docs/custom-scrape-discovery.md）。用途：
// - `resolve_custom_scrape_mode`：为 custom 渠道账号解析抓取模式（多阶段 URL /
//   interceptor / extractor / slot 规则 / 登录页规则）；
// - `reload_custom_scrape_registry`：重扫发现目录并替换进程内注册表；
// - `list_custom_scrape_channels`：Web 侧缓存与前端能力查询使用的去敏清单。
//
// 与 Rust 的差异（已知且有意）：
// - Rust 的发现根是「exe 同级目录」；Node/Electron 里用「进程脚本目录」与
//   「Electron 可执行文件目录」两者近似，另加 ~/.flowlet/custom-scrape（与 Rust 一致）。
// - 描述符只读本地目录，不进 SQLite、不进设备同步。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { JsonRow } from "../types.ts";

// ─── 运行时类型 ─────────────────────────────────────────────────────────────

export type UrlMatcher =
  | { kind: "substring"; value: string; caseInsensitive: boolean }
  | { kind: "prefix"; value: string }
  | { kind: "exact"; value: string }
  | { kind: "regex"; pattern: string; regex: RegExp }
  | { kind: "fallback" };

export type JsonExpect =
  | "present"
  | "number"
  | "boolean"
  | "string"
  | "array"
  | "object"
  | "nonempty_string"
  | "positive_number";

export type SlotSatisfies =
  | { kind: "json_valid" }
  | { kind: "json_path"; path: string; expect: JsonExpect }
  | { kind: "none" };

export type SlotMerge =
  | { kind: "last_write_wins" }
  | { kind: "merge_arrays"; path: string; dedupBy: string[]; keepFields: string[] };

export interface CustomSlotRule {
  key: string;
  /** null 表示 fallback：未命中任何显式 matcher 的响应归入此槽位。 */
  match: UrlMatcher | null;
  satisfies: SlotSatisfies;
  merge: SlotMerge;
}

export type LoginKind =
  | { kind: "none" }
  | { kind: "generic" }
  | { kind: "generic_or_host"; host: string };

export interface CustomSummary {
  plan: string | null;
}

export interface CustomValidatedMode {
  consoleUrl: string;
  consoleUrlSecondary: string | null;
  consoleUrlTertiary: string | null;
  interceptorJs: string;
  extractorJs: string;
  aggregate: boolean;
  requiredSlots: string[];
  slots: CustomSlotRule[];
}

export interface CustomDescriptor {
  channelId: string;
  accountName: string | null;
  fallback: boolean;
  resourceModes: Array<[string, string]>;
  login: LoginKind;
  modes: Map<string, CustomValidatedMode>;
  summary: CustomSummary;
}

export interface CustomScrapeRegistry {
  descriptors: CustomDescriptor[];
  errors: string[];
}

/** Rust `custom_scrape::CustomScrapeChannelInfo`（camelCase）。 */
export interface CustomScrapeChannelInfo {
  channelId: string;
  accountName: string | null;
}

/** Rust `custom_scrape::CustomScrapeResolved`。 */
export interface CustomScrapeResolved {
  consoleUrl: string;
  consoleUrlSecondary: string | null;
  consoleUrlTertiary: string | null;
  interceptorJs: string;
  extractorJs: string;
  aggregate: boolean;
  requiredSlots: string[];
  slots: CustomSlotRule[];
  login: LoginKind;
  summary: CustomSummary;
}

// ─── 发现目录 ───────────────────────────────────────────────────────────────

/**
 * Rust `custom_scrape::discovery_roots`：exe 同级目录优先，其次 ~/.flowlet。
 *
 * Node/Electron 适配（与 Rust 的差异，文档见 docs/custom-scrape-discovery.md）：
 * - Electron main 的 `process.execPath` 是 Flowlet 可执行文件，与 Rust 的 current_exe 同义；
 * - Node Host 没有「exe 同级目录」，退化为进程脚本目录；
 * - `FLOWLET_CUSTOM_SCRAPE_DIRS`（path.delimiter 分隔）可显式追加/前置发现目录，
 *   用于单测与自定义部署；设置后完全替换默认根，避免测试误读用户本机描述符。
 */
export function discoveryRoots(): string[] {
  const override = process.env["FLOWLET_CUSTOM_SCRAPE_DIRS"];
  if (typeof override === "string" && override.trim() !== "") {
    return override
      .split(path.delimiter)
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  const roots: string[] = [];
  const add = (dir: string): void => {
    if (dir !== "" && !roots.includes(dir)) roots.push(dir);
  };
  // Electron main：process.execPath 是 Flowlet 可执行文件；Node Host：脚本目录。
  add(path.join(path.dirname(process.execPath), "custom-scrape"));
  const script = process.argv[1];
  if (typeof script === "string" && script !== "") {
    add(path.join(path.dirname(path.resolve(script)), "custom-scrape"));
  }
  add(path.join(homedir(), ".flowlet", "custom-scrape"));
  return roots;
}

// ─── 加载与校验（Rust load_registry / scan_root / load_descriptor） ──────────

function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function asObject(value: unknown): JsonRow | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRow)
    : null;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function loadCustomScrapeRegistry(roots: string[] = discoveryRoots()): CustomScrapeRegistry {
  const registry: CustomScrapeRegistry = { descriptors: [], errors: [] };
  const seen = new Set<string>();
  for (const root of roots) scanRoot(root, registry, seen);
  return registry;
}

function scanRoot(root: string, registry: CustomScrapeRegistry, seen: Set<string>): void {
  let names: string[];
  try {
    if (!isDir(root)) {
      // Rust：NotFound 静默返回；其它读取错误记 error。
      if (existsSync(root)) registry.errors.push(`读取自定义抓取目录 ${root} 失败: 不是目录`);
      return;
    }
    names = readdirSync(root);
  } catch (error) {
    registry.errors.push(`读取自定义抓取目录 ${root} 失败: ${errorText(error)}`);
    return;
  }
  for (const name of names.sort()) {
    const dir = path.join(root, name);
    if (!isDir(dir)) continue;
    const manifestPath = path.join(dir, "manifest.json");
    const dirName = name.toLowerCase();
    if (!seen.add(dirName)) {
      registry.errors.push(`忽略重复的自定义抓取描述符目录：${dirName}`);
      continue;
    }
    const result = loadDescriptor(dir);
    if (result.ok) registry.descriptors.push(result.descriptor);
    else registry.errors.push(`${manifestPath}: ${result.error}`);
  }
}

function loadDescriptor(dir: string): { ok: true; descriptor: CustomDescriptor } | { ok: false; error: string } {
  const rawText = readTextOrNull(path.join(dir, "manifest.json"));
  if (rawText === null) return { ok: false, error: "读取 manifest.json 失败" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return { ok: false, error: `解析 manifest.json 失败: ${errorText(error)}` };
  }
  const raw = asObject(parsed);
  if (raw === null) return { ok: false, error: "manifest.json 必须是对象" };
  return validateAndBuild(raw, dir);
}

function validateAndBuild(
  raw: JsonRow,
  dir: string,
): { ok: true; descriptor: CustomDescriptor } | { ok: false; error: string } {
  if (raw.schemaVersion !== 1) {
    return { ok: false, error: `不支持的 schemaVersion：${String(raw.schemaVersion)}` };
  }
  const channelId = trimmed(raw.channelId);
  if (channelId === "") return { ok: false, error: "channelId 不能为空" };
  const rawAccountName = trimmed(raw.accountName);
  const accountName = rawAccountName === "" ? null : rawAccountName;
  const fallback = raw.fallback === true;
  if (channelId === "custom" && accountName === null && !fallback) {
    return {
      ok: false,
      error: "custom 渠道的描述符必须声明 accountName，或显式设置 fallback=true",
    };
  }

  const rawModes = asObject(raw.modes);
  if (rawModes === null) return { ok: false, error: "modes 必须是对象" };
  const rawResourceModes = Array.isArray(raw.resourceModes) ? raw.resourceModes : [];
  if (rawResourceModes.length === 0) return { ok: false, error: "resourceModes 不能为空" };
  const resourceModes: Array<[string, string]> = [];
  for (const entry of rawResourceModes) {
    const row = asObject(entry);
    if (row === null) return { ok: false, error: "resourceModes 的每一项必须是对象" };
    const resourceMode = trimmed(row.resourceMode);
    const modeKey = trimmed(row.modeKey);
    if (resourceMode === "" || modeKey === "") {
      return { ok: false, error: "resourceModes 的 resourceMode / modeKey 不能为空" };
    }
    if (Object.prototype.hasOwnProperty.call(rawModes, modeKey) === false) {
      return { ok: false, error: `resourceMode ${resourceMode} 引用了缺失的 mode：${modeKey}` };
    }
    resourceModes.push([resourceMode, modeKey]);
  }

  const login = validateLogin(raw.login);
  if (!login.ok) return { ok: false, error: login.error };

  const modes = new Map<string, CustomValidatedMode>();
  for (const [modeKey, modeValue] of Object.entries(rawModes)) {
    const mode = asObject(modeValue);
    if (mode === null) return { ok: false, error: `mode ${modeKey} 必须是对象` };
    const result = validateMode(modeKey, mode, dir);
    if (!result.ok) return { ok: false, error: result.error };
    modes.set(modeKey, result.mode);
  }

  const rawSummary = asObject(raw.summary);
  const summaryPlan = trimmed(rawSummary?.plan);
  return {
    ok: true,
    descriptor: {
      channelId,
      accountName,
      fallback,
      resourceModes,
      login: login.login,
      modes,
      summary: { plan: summaryPlan === "" ? null : summaryPlan },
    },
  };
}

function validateLogin(value: unknown): { ok: true; login: LoginKind } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, login: { kind: "none" } };
  const row = asObject(value);
  if (row === null) return { ok: false, error: "login 必须是对象" };
  const kind = trimmed(row.kind);
  if (kind === "none") return { ok: true, login: { kind: "none" } };
  if (kind === "generic") return { ok: true, login: { kind: "generic" } };
  if (kind === "generic_or_host") {
    const host = trimmed(row.host).toLowerCase();
    if (host === "") return { ok: false, error: "login.generic_or_host 的 host 不能为空" };
    return { ok: true, login: { kind: "generic_or_host", host } };
  }
  return { ok: false, error: `login.kind 不支持：${kind}` };
}

function validateMode(
  modeKey: string,
  mode: JsonRow,
  dir: string,
): { ok: true; mode: CustomValidatedMode } | { ok: false; error: string } {
  const consoleUrl = trimmed(mode.consoleUrl);
  if (consoleUrl === "") return { ok: false, error: `mode ${modeKey} 缺少 consoleUrl` };

  const rawSlots = mode.slots === undefined || mode.slots === null ? {} : asObject(mode.slots);
  if (rawSlots === null) return { ok: false, error: `mode ${modeKey} 的 slots 必须是对象` };
  const slots: CustomSlotRule[] = [];
  for (const [rawKey, rawSlot] of Object.entries(rawSlots)) {
    const slotKey = rawKey.trim();
    if (slotKey === "") return { ok: false, error: `mode ${modeKey} 存在空槽位名` };
    const slot = asObject(rawSlot);
    if (slot === null) return { ok: false, error: `mode ${modeKey} 槽位 ${slotKey}：必须是对象` };
    const match = slot.match === undefined || slot.match === null ? null : validateMatcher(slot.match);
    if (match !== null && !match.ok) {
      return { ok: false, error: `mode ${modeKey} 槽位 ${slotKey}：${match.error}` };
    }
    const satisfies = validateSatisfies(slot.satisfies);
    if (!satisfies.ok) return { ok: false, error: `mode ${modeKey} 槽位 ${slotKey}：${satisfies.error}` };
    const merge = validateMerge(slot.merge);
    if (!merge.ok) return { ok: false, error: `mode ${modeKey} 槽位 ${slotKey}：${merge.error}` };
    slots.push({
      key: slotKey,
      match: match === null ? null : match.matcher,
      satisfies: satisfies.satisfies,
      merge: merge.merge,
    });
  }

  const aggregate = mode.aggregate === true;
  const requiredSlots = (Array.isArray(mode.requiredSlots) ? mode.requiredSlots : [])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim());
  if (aggregate) {
    if (requiredSlots.length === 0) {
      return { ok: false, error: `mode ${modeKey} 聚合抓取缺少 requiredSlots` };
    }
    const declared = new Set(Object.keys(rawSlots).map((key) => key.trim()));
    for (const required of requiredSlots) {
      if (!declared.has(required)) {
        return {
          ok: false,
          error: `mode ${modeKey} 的 requiredSlots 引用了未声明的槽位：${required}`,
        };
      }
    }
  }

  const extractorJs = readScript(dir, "extractor.js");
  if (!extractorJs.ok) return { ok: false, error: extractorJs.error };
  if (extractorJs.text.trim() === "") {
    return { ok: false, error: `mode ${modeKey} 的 extractor.js 不能为空` };
  }
  const interceptorJs = readScript(dir, "interceptor.js");
  if (!interceptorJs.ok) return { ok: false, error: interceptorJs.error };

  const optionalUrl = (value: unknown): string | null => {
    const text = trimmed(value);
    return text === "" ? null : text;
  };
  return {
    ok: true,
    mode: {
      consoleUrl,
      consoleUrlSecondary: optionalUrl(mode.consoleUrlSecondary),
      consoleUrlTertiary: optionalUrl(mode.consoleUrlTertiary),
      interceptorJs: interceptorJs.text,
      extractorJs: extractorJs.text,
      aggregate,
      requiredSlots,
      slots,
    },
  };
}

function readScript(dir: string, fileName: string): { ok: true; text: string } | { ok: false; error: string } {
  const file = path.join(dir, fileName);
  if (!existsSync(file)) return { ok: true, text: "" };
  try {
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch (error) {
    return { ok: false, error: `读取 ${fileName} 失败: ${errorText(error)}` };
  }
}

function validateMatcher(
  value: unknown,
): { ok: true; matcher: UrlMatcher } | { ok: false; error: string } {
  const row = asObject(value);
  if (row === null) return { ok: false, error: "match 必须是对象" };
  const kind = trimmed(row.kind);
  switch (kind) {
    case "url_substring": {
      const text = trimmed(row.value);
      if (text === "") return { ok: false, error: "url_substring 的 value 不能为空" };
      return {
        ok: true,
        matcher: { kind: "substring", value: text, caseInsensitive: row.caseInsensitive !== false },
      };
    }
    case "url_prefix": {
      const text = trimmed(row.value);
      if (text === "") return { ok: false, error: "url_prefix 的 value 不能为空" };
      return { ok: true, matcher: { kind: "prefix", value: text } };
    }
    case "url_exact": {
      const text = trimmed(row.value);
      if (text === "") return { ok: false, error: "url_exact 的 value 不能为空" };
      return { ok: true, matcher: { kind: "exact", value: text } };
    }
    case "url_regex": {
      const pattern = typeof row.pattern === "string" ? row.pattern : "";
      if (pattern === "") return { ok: false, error: "url_regex 的 pattern 不能为空" };
      try {
        return { ok: true, matcher: { kind: "regex", pattern, regex: new RegExp(pattern) } };
      } catch (error) {
        return { ok: false, error: `url_regex 编译失败: ${errorText(error)}` };
      }
    }
    case "fallback":
      return { ok: true, matcher: { kind: "fallback" } };
    default:
      return { ok: false, error: `未知的 match.kind：${kind}` };
  }
}

const JSON_EXPECTS: ReadonlySet<string> = new Set([
  "present",
  "number",
  "boolean",
  "string",
  "array",
  "object",
  "nonempty_string",
  "positive_number",
]);

function validateSatisfies(
  value: unknown,
): { ok: true; satisfies: SlotSatisfies } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, satisfies: { kind: "json_valid" } };
  const row = asObject(value);
  if (row === null) return { ok: false, error: "satisfies 必须是对象" };
  const kind = trimmed(row.kind);
  if (kind === "json_valid") return { ok: true, satisfies: { kind: "json_valid" } };
  if (kind === "none") return { ok: true, satisfies: { kind: "none" } };
  if (kind === "json_path") {
    const path = trimmed(row.path);
    if (path === "") return { ok: false, error: "json_path 的 path 不能为空" };
    const expect = trimmed(row.expect) === "" ? "present" : trimmed(row.expect);
    if (!JSON_EXPECTS.has(expect)) return { ok: false, error: `未知的 json_path.expect：${expect}` };
    return { ok: true, satisfies: { kind: "json_path", path, expect: expect as JsonExpect } };
  }
  return { ok: false, error: `未知的 satisfies.kind：${kind}` };
}

function validateMerge(
  value: unknown,
): { ok: true; merge: SlotMerge } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, merge: { kind: "last_write_wins" } };
  const row = asObject(value);
  if (row === null) return { ok: false, error: "merge 必须是对象" };
  const kind = trimmed(row.kind);
  if (kind === "last_write_wins") return { ok: true, merge: { kind: "last_write_wins" } };
  if (kind === "merge_arrays") {
    const path = trimmed(row.path);
    if (path === "") return { ok: false, error: "merge_arrays 的 path 不能为空" };
    const strings = (value: unknown): string[] =>
      (Array.isArray(value) ? value : [])
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item !== "");
    return {
      ok: true,
      merge: {
        kind: "merge_arrays",
        path,
        dedupBy: strings(row.dedupBy),
        keepFields: strings(row.keepFields),
      },
    };
  }
  return { ok: false, error: `未知的 merge.kind：${kind}` };
}

// ─── 进程内注册表（Rust OnceLock + RwLock 语义） ────────────────────────────

let cachedRegistry: CustomScrapeRegistry | null = null;

/** Rust `custom_scrape::snapshot`：首次调用时扫描目录，之后读缓存。 */
export function customScrapeRegistry(): CustomScrapeRegistry {
  if (cachedRegistry === null) cachedRegistry = loadCustomScrapeRegistry();
  return cachedRegistry;
}

/** Rust `custom_scrape::reload`：重新扫描并替换注册表。 */
export function reloadCustomScrapeRegistry(): CustomScrapeRegistry {
  cachedRegistry = loadCustomScrapeRegistry();
  return cachedRegistry;
}

/** 测试用：丢弃缓存，下次访问重新扫描。 */
export function resetCustomScrapeRegistryForTests(): void {
  cachedRegistry = null;
}

export function listCustomScrapeChannelInfos(
  registry: CustomScrapeRegistry = customScrapeRegistry(),
): CustomScrapeChannelInfo[] {
  return registry.descriptors.map((descriptor) => ({
    channelId: descriptor.channelId,
    accountName: descriptor.accountName,
  }));
}

// ─── 解析与匹配（Rust resolve / account_name_matches / url_matches ...） ─────

/** Rust `custom_scrape::resolve`：把账号解析到自定义抓取模式。 */
export function resolveCustomScrapeMode(
  channelId: string,
  accountName: string | null,
  resourceMode: string | null,
  registry: CustomScrapeRegistry = customScrapeRegistry(),
): CustomScrapeResolved | null {
  const modeHint = resourceMode ?? "pay_as_you_go";
  for (const descriptor of registry.descriptors) {
    if (descriptor.channelId !== channelId) continue;
    if (channelId === "custom") {
      const expected = descriptor.accountName;
      if (expected !== null && accountName !== null) {
        if (!accountNameMatches(expected, accountName)) continue;
      } else if (!(expected === null && descriptor.fallback)) {
        continue;
      }
    }
    const modeKey =
      descriptor.resourceModes.find(([rm]) => rm === modeHint)?.[1] ??
      descriptor.resourceModes.find(([rm]) => rm === "pay_as_you_go")?.[1];
    if (modeKey === undefined) continue;
    const mode = descriptor.modes.get(modeKey);
    if (mode === undefined) continue;
    return {
      consoleUrl: mode.consoleUrl,
      consoleUrlSecondary: mode.consoleUrlSecondary,
      consoleUrlTertiary: mode.consoleUrlTertiary,
      interceptorJs: mode.interceptorJs,
      extractorJs: mode.extractorJs,
      aggregate: mode.aggregate,
      requiredSlots: mode.requiredSlots,
      slots: mode.slots,
      login: descriptor.login,
      summary: descriptor.summary,
    };
  }
  return null;
}

/** Rust `custom_scrape::account_name_matches`：trim + 小写后先精确后子串。 */
export function accountNameMatches(expected: string, actual: string): boolean {
  const left = expected.trim().toLowerCase();
  const right = actual.trim().toLowerCase();
  if (left === "" || right === "") return false;
  return left === right || right.includes(left) || left.includes(right);
}

/** Rust `custom_scrape::url_matches`。 */
export function urlMatches(matcher: UrlMatcher, url: string): boolean {
  switch (matcher.kind) {
    case "substring":
      return matcher.caseInsensitive
        ? url.toLowerCase().includes(matcher.value.toLowerCase())
        : url.includes(matcher.value);
    case "prefix":
      return url.toLowerCase().startsWith(matcher.value.toLowerCase());
    case "exact": {
      const withoutQuery = url.split("?")[0] ?? url;
      return stripTrailingSlash(withoutQuery) === stripTrailingSlash(matcher.value);
    }
    case "regex":
      return matcher.regex.test(url);
    case "fallback":
      return false;
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Rust `custom_scrape::slot_satisfies`。 */
export function slotSatisfies(satisfies: SlotSatisfies, body: string): boolean {
  switch (satisfies.kind) {
    case "none":
      return true;
    case "json_valid":
      return parseJsonOrNull(body) !== null;
    case "json_path": {
      const root = parseJsonOrNull(body);
      if (root === null) return false;
      const pointer = jsonPointer(satisfies.path);
      if (pointer === null) return false;
      const value = pointerGet(root, pointer);
      return value !== undefined && expectMatches(satisfies.expect, value);
    }
  }
}

function expectMatches(expect: JsonExpect, value: unknown): boolean {
  switch (expect) {
    case "present":
      return value !== null && value !== undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "nonempty_string":
      return typeof value === "string" && value !== "";
    case "positive_number":
      return typeof value === "number" && value > 0;
  }
}

/** Rust `custom_scrape::merge_arrays`：按 dedupBy 去重（后到覆盖先到）并裁剪字段。 */
export function mergeArrays(
  path: string,
  dedupBy: string[],
  keepFields: string[],
  existing: string,
  incoming: string,
): string | null {
  const existingRoot = parseJsonOrNull(existing);
  const incomingRoot = parseJsonOrNull(incoming);
  if (existingRoot === null || incomingRoot === null) return null;
  const pointer = jsonPointer(path);
  if (pointer === null) return null;
  const existingItems = pointerGet(existingRoot, pointer);
  const incomingItems = pointerGet(incomingRoot, pointer);
  if (!Array.isArray(existingItems) || !Array.isArray(incomingItems)) return null;

  const order: string[] = [];
  const byKey = new Map<string, unknown>();
  for (const item of [...existingItems, ...incomingItems]) {
    const key = identityKey(item, dedupBy);
    if (key === "") continue;
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, item);
  }
  const merged: unknown[] = [];
  for (const key of order) {
    const kept = keepDeclaredFields(byKey.get(key), keepFields);
    if (kept !== undefined) merged.push(kept);
  }
  const root = cloneJson(existingRoot);
  if (!pointerSet(root, pointer, merged)) return null;
  return JSON.stringify(root);
}

function identityKey(item: unknown, dedupBy: string[]): string {
  if (dedupBy.length === 0) return JSON.stringify(item) ?? "";
  return dedupBy
    .map((path) => {
      const pointer = jsonPointer(path);
      if (pointer === null) return "";
      const value = pointerGet(item, pointer);
      return scalarKey(value);
    })
    .join("\u001f");
}

function scalarKey(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function keepDeclaredFields(item: unknown, keepFields: string[]): unknown {
  if (keepFields.length === 0) return item;
  const source = asObject(item);
  if (source === null) return undefined;
  const target: JsonRow = {};
  for (const field of keepFields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) target[field] = source[field];
  }
  return target;
}

/** Rust `custom_scrape::login_matches`。 */
export function loginMatches(login: LoginKind, pageUrl: string): boolean {
  switch (login.kind) {
    case "none":
      return false;
    case "generic":
      return hasLoginPath(pageUrl);
    case "generic_or_host":
      return hasLoginPath(pageUrl) || pageUrl.toLowerCase().includes(login.host);
  }
}

export function hasLoginPath(pageUrl: string): boolean {
  const url = pageUrl.toLowerCase();
  return (
    url.includes("/login") ||
    url.includes("/signin") ||
    url.includes("/sign-in") ||
    url.includes("passport") ||
    url.includes("oauth")
  );
}

// ─── JSON Pointer 小工具 ────────────────────────────────────────────────────

/** Rust `custom_scrape::json_pointer`：`$.a.b[0]` 或 `/a/b/0` → `/a/b/0`。 */
export function jsonPointer(pathText: string): string | null {
  const text = pathText.trim();
  if (text === "") return null;
  if (text.startsWith("/")) return text;
  if (!text.startsWith("$")) return null;
  const rest = text.slice(1);
  let pointer = "";
  let segment = "";
  let index = 0;
  while (index < rest.length) {
    const ch = rest[index];
    if (ch === ".") {
      pointer = pushSegmentResult(pointer, segment);
      segment = "";
      index += 1;
      continue;
    }
    if (ch === "[") {
      pointer = pushSegmentResult(pointer, segment);
      segment = "";
      let inner = "";
      index += 1;
      while (index < rest.length && rest[index] !== "]") {
        inner += rest[index];
        index += 1;
      }
      index += 1; // skip ]
      if (inner === "") return null;
      pointer += `/${inner}`;
      continue;
    }
    segment += ch;
    index += 1;
  }
  pointer = pushSegmentResult(pointer, segment);
  return pointer === "" ? null : pointer;
}

function pushSegmentResult(pointer: string, segment: string): string {
  if (segment === "") return pointer;
  return `${pointer}/${segment}`;
}

export function pointerGet(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let current: unknown = value;
  for (const rawToken of pointer.split("/").slice(1)) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (current !== null && typeof current === "object") {
      current = (current as JsonRow)[token];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

function pointerSet(root: unknown, pointer: string, value: unknown): boolean {
  const tokens = pointer.split("/").slice(1).map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (tokens.length === 0) return false;
  let current: unknown = root;
  for (const token of tokens.slice(0, -1)) {
    if (current === null || typeof current !== "object") return false;
    current = (current as JsonRow)[token];
  }
  if (current === null || typeof current !== "object") return false;
  (current as JsonRow)[tokens[tokens.length - 1] as string] = value;
  return true;
}

export function parseJsonOrNull(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}