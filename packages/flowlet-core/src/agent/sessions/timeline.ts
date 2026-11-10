// Agent 原生会话时间线读取（Rust core/agent_session_timeline*.rs 的 TS 移植）。
//
// Owner: desktop-observability。覆盖 Claude Code / Codex(CLI+Desktop) / Pi / OpenCode /
// Hermes Agent 六种 agent_type；DeepSeek Harness 的原生会话解析工作量极大（Rust 侧
// core/agent_session_adapter/adapters/deepseek_harness.rs 约 2900 行，v0–v4 四代格式），
// 本批次未移植：对 deepseek-harness 明确返回「暂不支持」，不伪造空时间线。
//
// 与 Rust 的刻意差异（交付汇报中标注）：
// - 只实现「读取时间线 / 最后一轮 / 摘要」路径，未实现增量 checkpoint（sync 也走全量解析）。
// - Rust 的 event/content 上限（历史浏览 300 条 / 8000 字符）只用于旧接口；桌面命令
//   `get_agent_session_timeline` 明确要求完整会话，因此这里统一不截断。
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonRow } from "../../types.ts";
import type { ModelPrice } from "../../storage/prices.ts";
import { resolvePrices } from "../../storage/prices.ts";
import { readDshLastInteraction, readDshTimeline } from "./deepseek-harness.ts";

const MAX_SESSION_ID_BYTES = 512;

// ─── 输出结构（Rust config.rs 的 camelCase serde 结构） ───────────────────────

export interface AgentSessionTimelineEvent {
  id: string;
  kind: string;
  source: string;
  timestamp: string | null;
  title: string | null;
  content: string | null;
  model: string | null;
  status: string | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  usage: AgentSessionNativeUsage | null;
  trace?: AgentSessionTrace | null;
}

export interface AgentSessionTrace {
  sequence: number;
  eventType: string;
  turn: number | null;
  step: number | null;
  callId: string | null;
  parentCallId: string | null;
  provider: string | null;
  requestReason: string | null;
  input: string | null;
  output: string | null;
  systemPrompt: string | null;
  tools: string | null;
  sourceKind: string | null;
  sourceForm: string | null;
  producer: string | null;
}

export interface AgentSessionNativeUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number | null;
  costCurrency: string | null;
  apiEquivalent?: AgentSessionCostEstimate | null;
}

export interface AgentSessionCostEstimate {
  amount: number | null;
  inputUncachedAmount: number | null;
  inputCachedAmount: number | null;
  inputCacheWriteAmount: number | null;
  outputAmount: number | null;
  currency: string | null;
  sourceUrl: string | null;
  priceVersion: string | null;
  pricedTurnCount: number;
  unpricedTurnCount: number;
}

export interface AgentSessionTimeline {
  sourceAvailable: boolean;
  truncated: boolean;
  turnCount: number;
  usage: AgentSessionNativeUsage | null;
  models: string[];
  events: AgentSessionTimelineEvent[];
}

export interface AgentSessionNativeSummary {
  sourceAvailable: boolean;
  truncated: boolean;
  turnCount: number;
  usage: AgentSessionNativeUsage | null;
  models: string[];
}

// ─── 基础字段读取（Rust agent_session_sources.rs / timeline.rs 同名函数） ────

export function stringField(value: JsonRow, field: string): string | null {
  const raw = value[field];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export function integerField(value: JsonRow, field: string): number {
  const raw = value[field];
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "bigint") return Number(raw);
  return 0;
}

function optionalIntegerField(value: JsonRow, field: string): number | null {
  const raw = value[field];
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "bigint") return Number(raw);
  return null;
}

function numberField(value: JsonRow, field: string): number | null {
  const raw = value[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function optionalNumberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRow(value: unknown): JsonRow | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRow)
    : null;
}

export function renderJsonValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const rendered = value
      .map((item) => {
        if (typeof item === "string") return item;
        const row = asRow(item);
        if (row !== null && typeof row.text === "string") return row.text;
        return JSON.stringify(item, null, 2);
      })
      .join("\n");
    return rendered.trim() === "" ? null : rendered;
  }
  return JSON.stringify(value, null, 2);
}

export function truncateChars(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, maxChars).join("")}\n…`;
}

// ─── 时间线构建 ─────────────────────────────────────────────────────────────

export function emptyTimeline(): AgentSessionTimeline {
  return {
    sourceAvailable: false,
    truncated: false,
    turnCount: 0,
    usage: null,
    models: [],
    events: [],
  };
}

function completeTimeline(): AgentSessionTimeline {
  return emptyTimeline();
}

function pushEvent(
  timeline: AgentSessionTimeline,
  id: string,
  kind: string,
  timestamp: string | null,
  title: string | null,
  content: string | null,
  model: string | null,
  status: string | null,
): void {
  const trimmed = content === null ? null : content.trim();
  const normalized = trimmed === null ? null : trimmed === "" ? null : trimmed;
  if (normalized === null && title === null) return;
  timeline.events.push({
    id,
    kind,
    source: "agent-native",
    timestamp,
    title,
    content: normalized,
    model,
    status,
    durationMs: null,
    timeToFirstTokenMs: null,
    usage: null,
  });
}

function roleKind(role: string): string {
  return role === "assistant" ? "assistant-message" : "user-message";
}

function rememberModel(timeline: AgentSessionTimeline, model: string): void {
  if (model !== "" && !timeline.models.includes(model)) timeline.models.push(model);
}

function emptyUsage(): AgentSessionNativeUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: null,
    costCurrency: null,
    apiEquivalent: null,
  };
}

function addUsage(target: { usage: AgentSessionNativeUsage | null }, usage: AgentSessionNativeUsage): void {
  if (target.usage === null) target.usage = emptyUsage();
  const summary = target.usage;
  summary.inputTokens += usage.inputTokens;
  summary.cachedInputTokens += usage.cachedInputTokens;
  summary.cacheWriteInputTokens += usage.cacheWriteInputTokens;
  summary.outputTokens += usage.outputTokens;
  summary.reasoningTokens += usage.reasoningTokens;
  summary.totalTokens += usage.totalTokens;
  if (summary.cost !== null && usage.cost !== null) {
    summary.cost += usage.cost;
  } else if (summary.cost === null) {
    summary.cost = usage.cost;
  }
}

function attachUsageToFirstEvent(
  timeline: AgentSessionTimeline,
  eventStart: number,
  usage: AgentSessionNativeUsage | null,
): void {
  if (usage === null) return;
  const event = timeline.events[eventStart];
  if (event !== undefined) event.usage = usage;
}

function messageModel(value: JsonRow): string | null {
  const direct = stringField(value, "modelID");
  if (direct !== null) return direct;
  const model = asRow(value.model);
  if (model === null) return null;
  return stringField(model, "modelID") ?? stringField(model, "id");
}

// ─── 用量解析 ───────────────────────────────────────────────────────────────

function usageFromClaudeMessage(message: JsonRow): AgentSessionNativeUsage | null {
  const usage = asRow(message.usage);
  if (usage === null) return null;
  const inputTokens = integerField(usage, "input_tokens");
  const cachedInputTokens = integerField(usage, "cache_read_input_tokens");
  const cacheWriteInputTokens = integerField(usage, "cache_creation_input_tokens");
  const outputTokens = integerField(usage, "output_tokens");
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + cachedInputTokens + cacheWriteInputTokens + outputTokens,
    cost: null,
    costCurrency: null,
    apiEquivalent: null,
  };
}

function usageFromCodexTokenValue(value: JsonRow): AgentSessionNativeUsage {
  return {
    inputTokens: integerField(value, "input_tokens"),
    cachedInputTokens: integerField(value, "cached_input_tokens"),
    cacheWriteInputTokens: integerField(value, "cache_write_input_tokens"),
    outputTokens: integerField(value, "output_tokens"),
    reasoningTokens: integerField(value, "reasoning_output_tokens"),
    totalTokens: integerField(value, "total_tokens"),
    cost: null,
    costCurrency: null,
    apiEquivalent: null,
  };
}

function usageFromPiMessage(message: JsonRow): AgentSessionNativeUsage | null {
  const usage = asRow(message.usage);
  if (usage === null) return null;
  const cost = asRow(usage.cost);
  return {
    inputTokens: integerField(usage, "input"),
    cachedInputTokens: integerField(usage, "cacheRead"),
    cacheWriteInputTokens: integerField(usage, "cacheWrite"),
    outputTokens: integerField(usage, "output"),
    reasoningTokens: integerField(usage, "reasoning"),
    totalTokens: integerField(usage, "totalTokens"),
    cost: cost === null ? null : optionalNumberField(cost.total),
    costCurrency: null,
    apiEquivalent: null,
  };
}

// ─── JSONL 读取 ─────────────────────────────────────────────────────────────

type JsonlParser = (
  value: JsonRow,
  index: number,
  timeline: AgentSessionTimeline,
  seenUsageIds: Set<string>,
) => void;

function readJsonlLines(filePath: string): JsonRow[] {
  const raw = readFileSync(filePath, "utf8");
  const rows: JsonRow[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const row = asRow(parsed);
      if (row !== null) rows.push(row);
    } catch {
      /* 与 Rust 一致：坏行跳过 */
    }
  }
  return rows;
}

function readJsonlTimeline(filePath: string, parser: JsonlParser): AgentSessionTimeline {
  const timeline = completeTimeline();
  timeline.sourceAvailable = true;
  const seenUsageIds = new Set<string>();
  readJsonlLines(filePath).forEach((value, index) => {
    parser(value, index, timeline, seenUsageIds);
  });
  return timeline;
}

function readJsonlLastInteraction(filePath: string, parser: JsonlParser): AgentSessionTimeline {
  const timeline = completeTimeline();
  timeline.sourceAvailable = true;
  const seenUsageIds = new Set<string>();
  readJsonlLines(filePath).forEach((value, index) => {
    const eventStart = timeline.events.length;
    parser(value, index, timeline, seenUsageIds);
    const slice = timeline.events.slice(eventStart);
    if (!slice.some((event) => event.kind === "user-message")) return;
    const activeTurn = timeline.events
      .slice(0, eventStart)
      .reverse()
      .find((event) => event.kind === "turn");
    const latest = timeline.events.slice(eventStart);
    if (activeTurn !== undefined) latest.unshift(activeTurn);
    timeline.events = latest;
  });
  return timeline;
}

// ─── 文件发现 ───────────────────────────────────────────────────────────────

export function collectJsonlFiles(directory: string, matches: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(full, matches);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
      matches.push(full);
    }
  }
}

function findJsonlByStem(root: string, sessionId: string): string | null {
  const paths: string[] = [];
  collectJsonlFiles(root, paths);
  return paths.find((file) => path.basename(file, path.extname(file)) === sessionId) ?? null;
}

function readFirstJsonLine(filePath: string): JsonRow | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? "";
    const parsed: unknown = JSON.parse(line);
    return asRow(parsed);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 忽略关闭失败 */
      }
    }
  }
}

export function homeDir(): string | null {
  // 权威语义仍是 `dirs::home_dir()`（POSIX 取 HOME，Windows 取 USERPROFILE）。
  // 只有在「Windows 上显式设置了 HOME」时才让 HOME 生效：node:test 的 HOME 重定向在
  // Windows 上不会改变 `os.homedir()`（它只读 USERPROFILE），若不认 HOME，会话扫描会读到
  // 开发机上的真实数据，测试隔离失效。生产环境 Windows 用户不会设置 HOME。
  if (process.env.HOME !== undefined && process.env.HOME !== "" && process.platform === "win32") {
    return process.env.HOME;
  }
  try {
    const home = homedir();
    return home === "" ? null : home;
  } catch {
    return null;
  }
}

function xdgDataHome(): string | null {
  const override = process.env.XDG_DATA_HOME;
  if (override !== undefined && override !== "") return override;
  const home = homeDir();
  return home === null ? null : path.join(home, ".local", "share");
}

function platformDataDir(): string | null {
  if (process.platform === "win32") {
    // APPDATA 是 Windows 专有变量：POSIX 测试把「伪造的」HOME 指向临时目录时不能读它，
    // 否则会扫到开发机真实的 %APPDATA% 会话数据。仅当 HOME 未被重定向时才认 APPDATA。
    if (process.env.HOME !== undefined && process.env.HOME !== "") {
      const home = homeDir();
      return home === null ? null : path.join(home, "AppData", "Roaming");
    }
    return process.env.APPDATA ?? (homeDir() === null ? null : path.join(homeDir() as string, "AppData", "Roaming"));
  }
  if (process.platform === "darwin") {
    const home = homeDir();
    return home === null ? null : path.join(home, "Library", "Application Support");
  }
  return xdgDataHome();
}

function platformConfigDir(): string | null {
  if (process.platform === "win32") {
    if (process.env.HOME !== undefined && process.env.HOME !== "") return platformDataDir();
    return process.env.APPDATA ?? platformDataDir();
  }
  if (process.platform === "darwin") {
    const home = homeDir();
    return home === null ? null : path.join(home, "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME ?? (homeDir() === null ? null : path.join(homeDir() as string, ".config"));
}

export function codexHome(): string {
  const override = process.env.CODEX_HOME;
  if (override !== undefined && override !== "") return override;
  const home = homeDir();
  return home === null ? path.join(".codex") : path.join(home, ".codex");
}

export function opencodeDatabaseCandidates(): string[] {
  const candidates: string[] = [];
  const home = homeDir();
  if (home !== null) {
    candidates.push(path.join(home, ".local", "share", "opencode", "opencode.db"));
  }
  const data = platformDataDir();
  if (data !== null) {
    candidates.push(path.join(data, "opencode", "opencode.db"));
    candidates.push(path.join(data, "ai.opencode.desktop", "opencode.db"));
  }
  const config = platformConfigDir();
  if (config !== null) candidates.push(path.join(config, "ai.opencode.desktop", "opencode.db"));
  return [...new Set(candidates)];
}

export function hermesDatabaseCandidates(): string[] {
  const homes: string[] = [];
  const override = process.env.HERMES_HOME;
  if (override !== undefined && override !== "") homes.push(override);
  // 只有当 HOME 没被重定向时才读平台目录：本机 Hermes 写在 %LOCALAPPDATA%/hermes，
  // 而 POSIX 测试会伪造 HOME 来隔离，Windows 上伪造 HOME 后 os.homedir() 仍返回真实目录，
  // 若不在这里拦一下，测试会扫到开发机的真实 Hermes 会话。
  const home = homeDir();
  if (home !== null) homes.push(path.join(home, ".hermes"));
  const candidates: string[] = [];
  for (const base of homes) {
    candidates.push(path.join(base, "state.db"));
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(path.join(base, "profiles"), { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(path.join(base, "profiles", entry.name, "state.db"));
    }
  }
  return [...new Set(candidates)];
}

export function formatUnixMillis(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function formatUnixSeconds(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return formatUnixMillis(Math.round(value * 1000));
}

export function readOnlyDatabase(filePath: string): DatabaseSync | null {
  try {
    return new DatabaseSync(filePath, { readOnly: true });
  } catch {
    return null;
  }
}

// ─── Claude Code ────────────────────────────────────────────────────────────

function claudeProjectsRoot(): string | null {
  const home = homeDir();
  return home === null ? null : path.join(home, ".claude", "projects");
}

export function claudeSessionFile(sessionId: string): string | null {
  const root = claudeProjectsRoot();
  return root === null ? null : findJsonlByStem(root, sessionId);
}

function parseClaudeLine(
  value: JsonRow,
  index: number,
  timeline: AgentSessionTimeline,
  seenUsageIds: Set<string>,
): void {
  const outerType = typeof value.type === "string" ? value.type : "";
  if (outerType !== "user" && outerType !== "assistant") return;
  if (value.isMeta === true) return;
  const message = asRow(value.message);
  if (message === null) return;
  const timestamp = stringField(value, "timestamp");
  const baseId = stringField(value, "uuid") ?? `line-${index}`;
  const model = stringField(message, "model");
  if (model !== null) rememberModel(timeline, model);
  const eventStart = timeline.events.length;
  const content = message.content;
  if (typeof content === "string") {
    pushEvent(timeline, baseId, roleKind(outerType), timestamp, null, content, model, null);
  } else if (Array.isArray(content)) {
    content.forEach((item, contentIndex) => {
      const row = asRow(item);
      if (row === null) return;
      const eventId = `${baseId}:${contentIndex}`;
      switch (row.type) {
        case "text":
          pushEvent(timeline, eventId, roleKind(outerType), timestamp, null, stringField(row, "text"), model, null);
          break;
        case "thinking":
          pushEvent(timeline, eventId, "reasoning", timestamp, "思考摘要", stringField(row, "thinking"), model, null);
          break;
        case "tool_use":
          pushEvent(
            timeline,
            eventId,
            "tool-call",
            timestamp,
            stringField(row, "name"),
            renderJsonValue(row.input),
            model,
            null,
          );
          break;
        case "tool_result": {
          const isError = row.is_error === true;
          pushEvent(
            timeline,
            eventId,
            isError ? "error" : "tool-result",
            timestamp,
            "Tool result",
            renderJsonValue(row.content),
            model,
            null,
          );
          break;
        }
        default:
          break;
      }
    });
  }
  if (outerType === "assistant") {
    const usageId = stringField(message, "id") ?? baseId;
    if (!seenUsageIds.has(usageId)) {
      seenUsageIds.add(usageId);
      timeline.turnCount += 1;
      const usage = usageFromClaudeMessage(message);
      attachUsageToFirstEvent(timeline, eventStart, usage);
      if (usage !== null) addUsage(timeline, usage);
    }
  }
}

function readClaudeTimeline(sessionId: string): AgentSessionTimeline {
  const file = claudeSessionFile(sessionId);
  if (file === null) return emptyTimeline();
  return readJsonlTimeline(file, parseClaudeLine);
}

function readClaudeLastInteraction(sessionId: string): AgentSessionTimeline | null {
  const file = claudeSessionFile(sessionId);
  if (file === null) return null;
  return readJsonlLastInteraction(file, parseClaudeLine);
}

// ─── Codex ──────────────────────────────────────────────────────────────────

function codexSessionFile(agentType: string, sessionId: string): string | null {
  const paths: string[] = [];
  collectJsonlFiles(path.join(codexHome(), "sessions"), paths);
  for (const file of paths) {
    const first = readFirstJsonLine(file);
    if (first === null) continue;
    const payload = asRow(first.payload);
    if (payload === null) continue;
    const originator = typeof payload.originator === "string" ? payload.originator : null;
    const matchesAgent =
      agentType === "codex-desktop"
        ? originator === "Codex Desktop"
        : agentType === "codex-cli"
          ? originator === "codex_exec" ||
            originator === "codex_cli_rs" ||
            originator === "Codex CLI" ||
            originator === "codex-cli"
          : false;
    if (matchesAgent && stringField(payload, "id") === sessionId) return file;
  }
  return null;
}

function parseCodexLine(
  value: JsonRow,
  index: number,
  timeline: AgentSessionTimeline,
  _seenUsageIds: Set<string>,
): void {
  const topType = typeof value.type === "string" ? value.type : null;
  const payload = asRow(value.payload);
  if (topType === "turn_context" && payload !== null) {
    const model = stringField(payload, "model");
    if (model !== null) {
      rememberModel(timeline, model);
      const running = timeline.events
        .slice()
        .reverse()
        .find((event) => event.kind === "turn" && event.status === "running");
      if (running !== undefined) running.model = model;
    }
    return;
  }
  if (topType === "event_msg" && payload !== null) {
    switch (payload.type) {
      case "task_started": {
        timeline.turnCount += 1;
        const turnId = stringField(payload, "turn_id") ?? `turn-${index}`;
        pushEvent(
          timeline,
          turnId,
          "turn",
          stringField(value, "timestamp"),
          "Agent 轮次",
          null,
          null,
          "running",
        );
        break;
      }
      case "task_complete": {
        const turnId = stringField(payload, "turn_id");
        const event = timeline.events
          .slice()
          .reverse()
          .find((item) => item.kind === "turn" && (turnId === null || item.id === turnId));
        if (event !== undefined) {
          event.status = "completed";
          event.durationMs = optionalIntegerField(payload, "duration_ms");
          event.timeToFirstTokenMs = optionalIntegerField(payload, "time_to_first_token_ms");
        }
        break;
      }
      case "task_aborted":
      case "turn_aborted": {
        const event = timeline.events
          .slice()
          .reverse()
          .find((item) => item.kind === "turn" && item.status === "running");
        if (event !== undefined) event.status = "cancelled";
        break;
      }
      case "token_count": {
        const info = asRow(payload.info);
        if (info === null) break;
        const lastUsage = asRow(info.last_token_usage);
        if (lastUsage !== null) {
          const usage = usageFromCodexTokenValue(lastUsage);
          const event = timeline.events
            .slice()
            .reverse()
            .find((item) => item.kind === "turn" && item.status === "running");
          if (event !== undefined) {
            if (event.usage === null) event.usage = emptyUsage();
            addUsageToUsage(event.usage, usage);
          }
        }
        const totalUsage = asRow(info.total_token_usage);
        if (totalUsage !== null) timeline.usage = usageFromCodexTokenValue(totalUsage);
        break;
      }
      default:
        break;
    }
    return;
  }
  if (topType !== "response_item" || payload === null) return;

  const timestamp = stringField(value, "timestamp");
  const baseId = stringField(payload, "id") ?? `line-${index}`;
  switch (payload.type) {
    case "message": {
      const role = typeof payload.role === "string" ? payload.role : "";
      if (role !== "user" && role !== "assistant") return;
      const content = Array.isArray(payload.content) ? payload.content : [];
      content.forEach((item, contentIndex) => {
        const row = asRow(item);
        if (row === null) return;
        if (row.type === "input_text" || row.type === "output_text") {
          pushEvent(
            timeline,
            `${baseId}:${contentIndex}`,
            roleKind(role),
            timestamp,
            null,
            stringField(row, "text"),
            null,
            null,
          );
        }
      });
      break;
    }
    case "function_call":
    case "custom_tool_call": {
      const callId = stringField(payload, "call_id") ?? baseId;
      pushEvent(
        timeline,
        callId,
        "tool-call",
        timestamp,
        stringField(payload, "name"),
        renderJsonValue(payload.arguments ?? payload.input),
        null,
        stringField(payload, "status"),
      );
      break;
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const callId = stringField(payload, "call_id") ?? baseId;
      const title =
        timeline.events
          .slice()
          .reverse()
          .find((event) => event.kind === "tool-call" && event.id === callId)?.title ??
        "Tool result";
      pushEvent(
        timeline,
        `${callId}:result`,
        "tool-result",
        timestamp,
        title,
        renderJsonValue(payload.output),
        null,
        stringField(payload, "status"),
      );
      break;
    }
    case "reasoning":
      pushEvent(
        timeline,
        baseId,
        "reasoning",
        timestamp,
        "思考摘要",
        renderJsonValue(payload.summary),
        null,
        null,
      );
      break;
    default:
      break;
  }
}

function addUsageToUsage(target: AgentSessionNativeUsage, usage: AgentSessionNativeUsage): void {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.cacheWriteInputTokens += usage.cacheWriteInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningTokens += usage.reasoningTokens;
  target.totalTokens += usage.totalTokens;
}

function readCodexTimeline(agentType: string, sessionId: string): AgentSessionTimeline {
  const file = codexSessionFile(agentType, sessionId);
  if (file === null) return emptyTimeline();
  return readJsonlTimeline(file, parseCodexLine);
}

function readCodexLastInteraction(agentType: string, sessionId: string): AgentSessionTimeline | null {
  const file = codexSessionFile(agentType, sessionId);
  if (file === null) return null;
  return readJsonlLastInteraction(file, parseCodexLine);
}

// ─── Pi ─────────────────────────────────────────────────────────────────────

function piSessionsRoot(): string | null {
  const home = homeDir();
  return home === null ? null : path.join(home, ".pi", "agent", "sessions");
}

function piSessionFile(sessionId: string): string | null {
  const root = piSessionsRoot();
  if (root === null) return null;
  const paths: string[] = [];
  collectJsonlFiles(root, paths);
  return (
    paths.find((file) => path.basename(file, path.extname(file)).endsWith(`_${sessionId}`)) ?? null
  );
}

function piMessageText(message: JsonRow): string | null {
  const content = message.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (!Array.isArray(content)) return null;
  const text = content
    .map((block) => {
      const row = asRow(block);
      return row !== null && row.type === "text" && typeof row.text === "string" ? row.text : null;
    })
    .filter((item): item is string => item !== null)
    .join("\n")
    .trim();
  return text === "" ? null : text;
}

function readPiTimelineFrom(file: string, latestInteractionOnly: boolean): AgentSessionTimeline {
  const entries: Array<{ index: number; value: JsonRow }> = [];
  readJsonlLines(file).forEach((value, index) => {
    if (value.type === "session") return;
    entries.push({ index, value });
  });
  const byId = new Map<string, { index: number; value: JsonRow }>();
  for (const entry of entries) {
    const id = typeof entry.value.id === "string" ? entry.value.id : null;
    if (id !== null) byId.set(id, entry);
  }
  const parented = new Set<string>();
  for (const entry of entries) {
    const parent = typeof entry.value.parentId === "string" ? entry.value.parentId : null;
    if (parent !== null) parented.add(parent);
  }
  let leaf: { index: number; value: JsonRow } | null = null;
  for (const entry of entries) {
    const id = typeof entry.value.id === "string" ? entry.value.id : null;
    if (id === null || parented.has(id)) continue;
    if (leaf === null) {
      leaf = entry;
      continue;
    }
    const candidateTime = stringField(entry.value, "timestamp") ?? "";
    const leafTime = stringField(leaf.value, "timestamp") ?? "";
    if (candidateTime > leafTime) leaf = entry;
  }
  const branchEntries: Array<{ index: number; value: JsonRow }> = [];
  const visited = new Set<string>();
  let currentId = leaf === null ? null : (typeof leaf.value.id === "string" ? leaf.value.id : null);
  while (currentId !== null) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const entry = entries.find((item) => item.value.id === currentId);
    if (entry !== undefined) branchEntries.push(entry);
    const parentId = entry !== undefined && typeof entry.value.parentId === "string" && entry.value.parentId !== ""
      ? entry.value.parentId
      : null;
    currentId = parentId !== null && byId.has(parentId) ? parentId : null;
  }
  branchEntries.reverse();

  const timeline = completeTimeline();
  timeline.sourceAvailable = true;
  const seenUsageIds = new Set<string>();
  for (const entry of branchEntries) {
    parsePiEntry(entry.value, timeline, seenUsageIds);
    if (latestInteractionOnly) {
      const userIndex = timeline.events.findLastIndex((event) => event.kind === "user-message");
      if (userIndex >= 0) timeline.events = timeline.events.slice(userIndex);
    }
  }
  return timeline;
}

function parsePiEntry(
  value: JsonRow,
  timeline: AgentSessionTimeline,
  seenUsageIds: Set<string>,
): void {
  const timestamp = stringField(value, "timestamp");
  const id = stringField(value, "id") ?? "";
  switch (value.type) {
    case "message": {
      const message = asRow(value.message);
      if (message === null) return;
      const role = typeof message.role === "string" ? message.role : "";
      const model = stringField(message, "model");
      if (model !== null) rememberModel(timeline, model);
      if (role === "user") {
        pushEvent(timeline, id, "user-message", timestamp, null, piMessageText(message), model, null);
        return;
      }
      if (role === "assistant") {
        const blocks = Array.isArray(message.content) ? message.content : [];
        const eventStart = timeline.events.length;
        if (blocks.length === 0) {
          pushEvent(timeline, id, "assistant-message", timestamp, null, null, model, null);
        }
        blocks.forEach((block, blockIndex) => {
          const row = asRow(block);
          if (row === null) return;
          const blockId = `${id}:${blockIndex}`;
          switch (row.type) {
            case "text":
              pushEvent(timeline, blockId, "assistant-message", timestamp, null, stringField(row, "text"), model, null);
              break;
            case "thinking":
              pushEvent(timeline, blockId, "reasoning", timestamp, "思考摘要", stringField(row, "thinking"), model, null);
              break;
            case "toolCall":
              pushEvent(
                timeline,
                blockId,
                "tool-call",
                timestamp,
                stringField(row, "name"),
                renderJsonValue(row.arguments),
                model,
                null,
              );
              break;
            default:
              break;
          }
        });
        if (!seenUsageIds.has(id)) {
          seenUsageIds.add(id);
          timeline.turnCount += 1;
          const usage = usageFromPiMessage(message);
          if (usage !== null) {
            attachUsageToFirstEvent(timeline, eventStart, usage);
            addUsage(timeline, usage);
          }
        }
        return;
      }
      if (role === "toolResult") {
        const isError = message.isError === true;
        pushEvent(
          timeline,
          id,
          isError ? "error" : "tool-result",
          timestamp,
          stringField(message, "toolName"),
          piMessageText(message),
          model,
          null,
        );
        return;
      }
      if (role === "bashExecution") {
        const exitCode = optionalIntegerField(message, "exitCode");
        const status = exitCode === null ? null : exitCode === 0 ? "completed" : "error";
        pushEvent(
          timeline,
          id,
          "tool-result",
          timestamp,
          stringField(message, "command"),
          stringField(message, "output"),
          model,
          status,
        );
      }
      break;
    }
    case "model_change": {
      const model = typeof value.modelId === "string" ? value.modelId : null;
      if (model !== null) rememberModel(timeline, model);
      break;
    }
    default:
      break;
  }
}

function readPiTimeline(sessionId: string): AgentSessionTimeline {
  const file = piSessionFile(sessionId);
  if (file === null) return emptyTimeline();
  return readPiTimelineFrom(file, false);
}

function readPiLastInteraction(sessionId: string): AgentSessionTimeline | null {
  const file = piSessionFile(sessionId);
  if (file === null) return null;
  return readPiTimelineFrom(file, true);
}

// ─── OpenCode ───────────────────────────────────────────────────────────────

function opencodeTimelineFrom(connection: DatabaseSync, sessionId: string, latestOnly: boolean): AgentSessionTimeline {
  const timeline = completeTimeline();
  timeline.sourceAvailable = true;
  timeline.usage = readOpencodeSessionUsage(connection, sessionId);
  timeline.models = readOpencodeSessionModels(connection, sessionId);
  const rows = connection
    .prepare(
      `SELECT m.id AS message_id, m.time_created AS message_time, m.data AS message_data,
              p.id AS part_id, p.time_created AS part_time, p.data AS part_data
       FROM message m
       LEFT JOIN part p ON p.message_id = m.id
       WHERE m.session_id = ?1
       ORDER BY COALESCE(p.time_created, m.time_created), m.id, p.id`,
    )
    .all(sessionId) as JsonRow[];
  const usageMessages = new Set<string>();
  let currentUserMessageId: string | null = null;
  for (const row of rows) {
    const messageJson = typeof row.message_data === "string" ? row.message_data : null;
    const partJson = row.part_data;
    const messageId = String(row.message_id);
    const messageTime = optionalIntegerField(row, "message_time");
    const partId = typeof row.part_id === "string" ? row.part_id : null;
    const partTimeRaw = row.part_time;
    const partTime = typeof partTimeRaw === "number" ? partTimeRaw : null;
    if (messageJson === null) continue;
    let message: JsonRow | null = null;
    try {
      message = asRow(JSON.parse(messageJson));
    } catch {
      continue;
    }
    if (message === null) continue;
    const role = typeof message.role === "string" ? message.role : "";
    const model = messageModel(message);
    if (model !== null) rememberModel(timeline, model);
    if (typeof partJson !== "string") continue;
    let part: JsonRow | null = null;
    try {
      part = asRow(JSON.parse(partJson));
    } catch {
      continue;
    }
    if (part === null) continue;
    if (latestOnly && role === "user" && currentUserMessageId !== messageId) {
      timeline.events = [];
      currentUserMessageId = messageId;
    }
    const eventId = partId ?? messageId;
    const timestamp = formatUnixMillis(partTime ?? messageTime);
    const eventStart = timeline.events.length;
    switch (part.type) {
      case "text":
        pushEvent(timeline, eventId, roleKind(role), timestamp, null, stringField(part, "text"), model, null);
        break;
      case "reasoning":
        pushEvent(timeline, eventId, "reasoning", timestamp, "思考摘要", stringField(part, "text"), model, null);
        break;
      case "tool":
        pushOpencodeToolEvents(timeline, eventId, timestamp, part);
        break;
      default:
        break;
    }
    if (role === "assistant" && !usageMessages.has(messageId)) {
      usageMessages.add(messageId);
      timeline.turnCount += 1;
      const usage = usageFromOpencodeMessage(message);
      attachUsageToFirstEvent(timeline, eventStart, usage);
    }
  }
  return timeline;
}

function readOpencodeSessionUsage(
  connection: DatabaseSync,
  sessionId: string,
): AgentSessionNativeUsage | null {
  try {
    const row = connection
      .prepare(
        `SELECT tokens_input, tokens_cache_read, tokens_cache_write,
                tokens_output, tokens_reasoning, cost
         FROM session WHERE id = ?1`,
      )
      .get(sessionId) as JsonRow | undefined;
    if (row === undefined) return null;
    const inputTokens = Number(row.tokens_input ?? 0);
    const cachedInputTokens = Number(row.tokens_cache_read ?? 0);
    const cacheWriteInputTokens = Number(row.tokens_cache_write ?? 0);
    const outputTokens = Number(row.tokens_output ?? 0);
    const reasoningTokens = Number(row.tokens_reasoning ?? 0);
    return {
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens: inputTokens + outputTokens + reasoningTokens,
      cost: optNumber(row.cost),
      costCurrency: "USD",
      apiEquivalent: null,
    };
  } catch {
    return null;
  }
}

function optNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readOpencodeSessionModels(connection: DatabaseSync, sessionId: string): string[] {
  try {
    const row = connection
      .prepare("SELECT model FROM session WHERE id = ?1")
      .get(sessionId) as JsonRow | undefined;
    const model = typeof row?.model === "string" ? row.model : null;
    if (model === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(model);
    } catch {
      return [model];
    }
    const value = asRow(parsed);
    if (value === null) return [model];
    const id = stringField(value, "id") ?? stringField(value, "modelID");
    return id === null ? [] : [id];
  } catch {
    return [];
  }
}

function usageFromOpencodeMessage(message: JsonRow): AgentSessionNativeUsage | null {
  const tokens = asRow(message.tokens);
  if (tokens === null) return null;
  const cache = asRow(tokens.cache);
  return {
    inputTokens: integerField(tokens, "input"),
    cachedInputTokens: cache === null ? 0 : integerField(cache, "read"),
    cacheWriteInputTokens: cache === null ? 0 : integerField(cache, "write"),
    outputTokens: integerField(tokens, "output"),
    reasoningTokens: integerField(tokens, "reasoning"),
    totalTokens: integerField(tokens, "total"),
    cost: numberField(message, "cost"),
    costCurrency: "USD",
    apiEquivalent: null,
  };
}

function pushOpencodeToolEvents(
  timeline: AgentSessionTimeline,
  eventId: string,
  timestamp: string | null,
  part: JsonRow,
): void {
  const tool = stringField(part, "tool") ?? "Tool";
  const state = asRow(part.state) ?? {};
  const status = stringField(state, "status");
  const input = renderJsonValue(state.input);
  if (input !== null) {
    pushEvent(timeline, `${eventId}:call`, "tool-call", timestamp, tool, input, null, status);
  }
  const result = renderJsonValue(state.output) ?? renderJsonValue(state.error);
  if (result !== null) {
    const kind = state.error !== undefined && state.error !== null ? "error" : "tool-result";
    pushEvent(timeline, `${eventId}:result`, kind, timestamp, tool, result, null, status);
  }
}

function withOpencodeDatabase<T>(
  sessionId: string,
  run: (connection: DatabaseSync) => T,
): T | null {
  for (const candidate of opencodeDatabaseCandidates()) {
    let isFile = false;
    try {
      isFile = statSync(candidate).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) continue;
    const connection = readOnlyDatabase(candidate);
    if (connection === null) continue;
    try {
      const exists = connection
        .prepare("SELECT EXISTS(SELECT 1 FROM session WHERE id = ?1) AS present")
        .get(sessionId) as JsonRow | undefined;
      if (Number(exists?.present ?? 0) === 0) continue;
      return run(connection);
    } catch {
      continue;
    } finally {
      connection.close();
    }
  }
  return null;
}

function readOpencodeTimeline(sessionId: string): AgentSessionTimeline {
  return (
    withOpencodeDatabase(sessionId, (connection) => opencodeTimelineFrom(connection, sessionId, false)) ??
    emptyTimeline()
  );
}

function readOpencodeLastInteraction(sessionId: string): AgentSessionTimeline {
  return (
    withOpencodeDatabase(sessionId, (connection) => opencodeTimelineFrom(connection, sessionId, true)) ??
    completeTimeline()
  );
}

// ─── Hermes Agent ───────────────────────────────────────────────────────────

function hermesTimelineFrom(connection: DatabaseSync, sessionId: string, latestOnly: boolean): AgentSessionTimeline {
  const timeline = completeTimeline();
  timeline.sourceAvailable = true;
  timeline.usage = readHermesSessionUsage(connection, sessionId);
  timeline.models = readHermesSessionModels(connection, sessionId);
  const rows = connection
    .prepare(
      `SELECT id, role, content, tool_name, tool_calls, timestamp, reasoning_content, token_count
       FROM messages WHERE session_id = ?1 ORDER BY id`,
    )
    .all(sessionId) as JsonRow[];
  const usageMessages = new Set<number>();
  let lastUserSeen = false;
  for (const row of rows) {
    const messageId = Number(row.id);
    const role = typeof row.role === "string" ? row.role : "";
    const content = typeof row.content === "string" ? row.content : null;
    const toolName = typeof row.tool_name === "string" ? row.tool_name : null;
    const toolCalls = typeof row.tool_calls === "string" ? row.tool_calls : null;
    const timestampRaw = typeof row.timestamp === "number" ? row.timestamp : null;
    const timestamp = formatUnixSeconds(timestampRaw);
    const reasoning = typeof row.reasoning_content === "string" ? row.reasoning_content : null;
    const tokenCount = typeof row.token_count === "number" ? row.token_count : null;
    if (latestOnly && role === "user") {
      if (lastUserSeen) {
        timeline.events = [];
        timeline.turnCount = 0;
      }
      lastUserSeen = true;
    }
    const eventStart = timeline.events.length;
    if (role === "user") {
      timeline.turnCount += 1;
      pushEvent(timeline, `m${messageId}`, "user-message", timestamp, null, content, null, null);
    } else if (role === "assistant") {
      if (reasoning !== null && reasoning.trim() !== "") {
        pushEvent(timeline, `m${messageId}:reasoning`, "reasoning", timestamp, "思考", reasoning, null, null);
      }
      const assistantText = content !== null && content.trim() !== "" ? content : null;
      if (assistantText !== null || toolCalls !== null) {
        let text = assistantText;
        if (text === null && toolCalls !== null) {
          try {
            text = renderJsonValue(JSON.parse(toolCalls));
          } catch {
            text = null;
          }
        }
        pushEvent(timeline, `m${messageId}`, "assistant-message", timestamp, null, text, null, null);
      }
      if (!usageMessages.has(messageId)) {
        usageMessages.add(messageId);
        if ((tokenCount ?? 0) > 0) {
          attachUsageToFirstEvent(timeline, eventStart, {
            ...emptyUsage(),
            totalTokens: tokenCount ?? 0,
          });
        }
      }
    } else if (role === "tool") {
      pushEvent(timeline, `m${messageId}`, "tool-result", timestamp, toolName, content, null, null);
    }
  }
  return timeline;
}

function readHermesSessionUsage(
  connection: DatabaseSync,
  sessionId: string,
): AgentSessionNativeUsage | null {
  try {
    const row = connection
      .prepare(
        `SELECT input_tokens, cache_read_tokens, cache_write_tokens,
                output_tokens, reasoning_tokens, estimated_cost_usd
         FROM sessions WHERE id = ?1`,
      )
      .get(sessionId) as JsonRow | undefined;
    if (row === undefined) return null;
    const inputTokens = Number(row.input_tokens ?? 0);
    const cachedInputTokens = Number(row.cache_read_tokens ?? 0);
    const cacheWriteInputTokens = Number(row.cache_write_tokens ?? 0);
    const outputTokens = Number(row.output_tokens ?? 0);
    const reasoningTokens = Number(row.reasoning_tokens ?? 0);
    return {
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens: inputTokens + outputTokens + reasoningTokens,
      cost: optNumber(row.estimated_cost_usd),
      costCurrency: "USD",
      apiEquivalent: null,
    };
  } catch {
    return null;
  }
}

function readHermesSessionModels(connection: DatabaseSync, sessionId: string): string[] {
  try {
    const row = connection
      .prepare("SELECT model FROM sessions WHERE id = ?1")
      .get(sessionId) as JsonRow | undefined;
    const model = typeof row?.model === "string" ? row.model.trim() : "";
    return model === "" ? [] : [model];
  } catch {
    return [];
  }
}

function readHermesFromDatabases(
  sessionId: string,
  latestOnly: boolean,
): AgentSessionTimeline | null {
  for (const candidate of hermesDatabaseCandidates()) {
    let isFile = false;
    try {
      isFile = statSync(candidate).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) continue;
    const connection = readOnlyDatabase(candidate);
    if (connection === null) continue;
    try {
      const exists = connection
        .prepare("SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1) AS present")
        .get(sessionId) as JsonRow | undefined;
      if (Number(exists?.present ?? 0) === 0) continue;
      return hermesTimelineFrom(connection, sessionId, latestOnly);
    } catch {
      continue;
    } finally {
      connection.close();
    }
  }
  return null;
}

function readHermesTimeline(sessionId: string): AgentSessionTimeline {
  return readHermesFromDatabases(sessionId, false) ?? emptyTimeline();
}

function readHermesLastInteraction(sessionId: string): AgentSessionTimeline {
  return readHermesFromDatabases(sessionId, true) ?? completeTimeline();
}

// ─── 调度 ───────────────────────────────────────────────────────────────────

/** 支持的 agent_type（与 Rust 六个会话适配器一致，DSH 除外）。 */
export const SUPPORTED_TIMELINE_AGENT_TYPES = [
  "claude-code",
  "codex-desktop",
  "codex-cli",
  "pi",
  "opencode",
  "hermes",
  "deepseek-harness",
] as const;

export function hasTimelineAdapter(agentType: string): boolean {
  return (SUPPORTED_TIMELINE_AGENT_TYPES as readonly string[]).includes(agentType);
}

function validateSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed === "" || Buffer.byteLength(trimmed, "utf8") > MAX_SESSION_ID_BYTES) {
    throw new Error("无效的 Agent 会话 ID");
  }
  return trimmed;
}

/** Rust `get_native_agent_session_timeline`。 */
export function getNativeAgentSessionTimeline(
  agentTypeInput: string,
  sessionIdInput: string,
): AgentSessionTimeline {
  const agentType = agentTypeInput.trim();
  const sessionId = validateSessionId(sessionIdInput);
  switch (agentType) {
    case "claude-code":
      return readClaudeTimeline(sessionId);
    case "codex-desktop":
    case "codex-cli":
      return readCodexTimeline(agentType, sessionId);
    case "pi":
      return readPiTimeline(sessionId);
    case "opencode":
      return readOpencodeTimeline(sessionId);
    case "hermes":
      return readHermesTimeline(sessionId);
    case "deepseek-harness":
      return readDshTimeline(sessionId);
    default:
      throw new Error(`暂不支持读取 Agent 会话时间线：${agentType}`);
  }
}

/** Rust `get_native_agent_session_last_interaction`：无 user-message 时返回 null。 */
export function getNativeAgentSessionLastInteraction(
  agentTypeInput: string,
  sessionIdInput: string,
): AgentSessionTimeline | null {
  const agentType = agentTypeInput.trim();
  const sessionId = validateSessionId(sessionIdInput);
  let timeline: AgentSessionTimeline | null;
  switch (agentType) {
    case "claude-code":
      timeline = readClaudeLastInteraction(sessionId);
      break;
    case "codex-desktop":
    case "codex-cli":
      timeline = readCodexLastInteraction(agentType, sessionId);
      break;
    case "pi":
      timeline = readPiLastInteraction(sessionId);
      break;
    case "opencode":
      timeline = readOpencodeLastInteraction(sessionId);
      break;
    case "hermes":
      timeline = readHermesLastInteraction(sessionId);
      break;
    case "deepseek-harness":
      timeline = readDshLastInteraction(sessionId);
      break;
    default:
      throw new Error(`暂不支持读取 Agent 会话最后交互：${agentType}`);
  }
  if (timeline === null) return null;
  return timeline.events.some((event) => event.kind === "user-message") ? timeline : null;
}

/** Rust `summarize_timeline`。 */
export function summarizeTimeline(timeline: AgentSessionTimeline): AgentSessionNativeSummary {
  let turnCount = timeline.turnCount;
  if (turnCount <= 0) {
    const nativeTurnCount = timeline.events.filter((event) => event.kind === "turn").length;
    const usageTurnCount = timeline.events.filter((event) => event.usage !== null).length;
    if (nativeTurnCount > 0) {
      turnCount = nativeTurnCount;
    } else if (usageTurnCount > 0) {
      turnCount = usageTurnCount;
    } else {
      turnCount = timeline.events.filter((event) => event.kind === "user-message").length;
    }
  }
  return {
    sourceAvailable: timeline.sourceAvailable,
    truncated: timeline.truncated,
    turnCount,
    usage: timeline.usage,
    models: timeline.models,
  };
}

/** Rust `get_native_agent_session_summary`。 */
export function getNativeAgentSessionSummary(
  agentType: string,
  sessionId: string,
): AgentSessionNativeSummary {
  return summarizeTimeline(getNativeAgentSessionTimeline(agentType, sessionId));
}

function parseTimelineTimestamp(value: string): number | null {
  // Rust `DateTime::parse_from_rfc3339` 要求显式时区；JS Date.parse 过宽，先做形状校验。
  if (!/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseTimelineBound(value: string | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = parseTimelineTimestamp(trimmed);
  if (parsed === null) throw new Error(`无效的会话时间线${label}：${trimmed}`);
  return parsed;
}

/**
 * Rust `slice_native_agent_session_timeline`：按 user-message 边界整组保留执行轮次，
 * 过滤后重算 turn_count / models / usage。
 */
export function sliceNativeAgentSessionTimeline(
  timeline: AgentSessionTimeline,
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): AgentSessionTimeline {
  const startedMs = parseTimelineBound(startedAt, "开始时间");
  const endedMs = parseTimelineBound(endedAt, "结束时间");
  if (startedMs !== null && endedMs !== null && endedMs < startedMs) {
    throw new Error("会话时间线结束时间早于开始时间");
  }
  if (startedMs === null && endedMs === null) return timeline;

  const interactions: AgentSessionTimelineEvent[][] = [];
  let current: AgentSessionTimelineEvent[] = [];
  for (const event of timeline.events) {
    if (event.kind === "user-message" && current.some((item) => item.kind === "user-message")) {
      interactions.push(current);
      current = [];
    }
    current.push(event);
  }
  if (current.length > 0) interactions.push(current);

  const kept = interactions
    .filter((interaction) => {
      const userEvent = interaction.find((event) => event.kind === "user-message");
      const candidate =
        userEvent?.timestamp ?? interaction.find((event) => event.timestamp !== null)?.timestamp ?? null;
      const timestamp = candidate === null ? null : parseTimelineTimestamp(candidate);
      if (timestamp === null) return false;
      return (startedMs === null || timestamp >= startedMs) && (endedMs === null || timestamp < endedMs);
    })
    .flat();

  const sliced: AgentSessionTimeline = {
    ...timeline,
    events: kept,
    turnCount: kept.filter((event) => event.kind === "user-message").length,
    models: [],
    usage: null,
  };
  for (const event of kept) {
    if (event.model !== null && event.model !== "" && !sliced.models.includes(event.model)) {
      sliced.models.push(event.model);
    }
    if (event.usage !== null) addUsage(sliced, event.usage);
  }
  return sliced;
}

// ─── Codex 的 API 等价费用估算 ──────────────────────────────────────────────

function unpricedEstimate(turnCount: number): AgentSessionCostEstimate {
  return {
    amount: null,
    inputUncachedAmount: null,
    inputCachedAmount: null,
    inputCacheWriteAmount: null,
    outputAmount: null,
    currency: null,
    sourceUrl: null,
    priceVersion: null,
    pricedTurnCount: 0,
    unpricedTurnCount: turnCount,
  };
}

function estimateUsageCost(
  usage: AgentSessionNativeUsage,
  model: string,
  prices: ModelPrice[],
  priceNamespace: string,
  turnCount: number,
): AgentSessionCostEstimate {
  const price = prices.find(
    (item) =>
      item.channel_id === priceNamespace &&
      item.upstream_model.toLowerCase() === model.trim().toLowerCase(),
  );
  if (price === undefined) return unpricedEstimate(turnCount);
  const [uncachedPrice, cachedPrice, cacheWritePrice, outputPrice] = resolvePrices(price, null);
  const uncachedInput = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens,
  );
  const inputUncachedAmount = (uncachedInput * uncachedPrice) / 1_000_000;
  const inputCachedAmount = (usage.cachedInputTokens * cachedPrice) / 1_000_000;
  const inputCacheWriteAmount =
    (usage.cacheWriteInputTokens * (cacheWritePrice ?? uncachedPrice)) / 1_000_000;
  const outputAmount = (usage.outputTokens * outputPrice) / 1_000_000;
  return {
    amount: inputUncachedAmount + inputCachedAmount + inputCacheWriteAmount + outputAmount,
    inputUncachedAmount,
    inputCachedAmount,
    inputCacheWriteAmount,
    outputAmount,
    currency: price.currency,
    sourceUrl: price.source_url,
    priceVersion: price.price_version,
    pricedTurnCount: turnCount,
    unpricedTurnCount: 0,
  };
}

function aggregateEstimates(estimates: AgentSessionCostEstimate[]): AgentSessionCostEstimate | null {
  if (estimates.length === 0) return null;
  const first = estimates[0] as AgentSessionCostEstimate;
  const pricedTurnCount = estimates.reduce((sum, item) => sum + item.pricedTurnCount, 0);
  const unpricedTurnCount = estimates.reduce((sum, item) => sum + item.unpricedTurnCount, 0);
  const sameCurrency = estimates.every((item) => item.currency === first.currency);
  const fullyPriced = unpricedTurnCount === 0 && sameCurrency;
  const sumComponent = (
    value: (item: AgentSessionCostEstimate) => number | null,
  ): number | null => (fullyPriced ? estimates.reduce((sum, item) => sum + (value(item) ?? 0), 0) : null);
  return {
    amount: sumComponent((item) => item.amount),
    inputUncachedAmount: sumComponent((item) => item.inputUncachedAmount),
    inputCachedAmount: sumComponent((item) => item.inputCachedAmount),
    inputCacheWriteAmount: sumComponent((item) => item.inputCacheWriteAmount),
    outputAmount: sumComponent((item) => item.outputAmount),
    currency: sameCurrency ? first.currency : null,
    sourceUrl: first.sourceUrl,
    priceVersion: first.priceVersion,
    pricedTurnCount,
    unpricedTurnCount,
  };
}

/** Rust `apply_native_cost_estimate_to_timeline`（只对 codex-* 生效）。 */
export function applyNativeCostEstimateToTimeline(
  agentType: string,
  timeline: AgentSessionTimeline,
  prices: ModelPrice[],
): void {
  if (agentType !== "codex-desktop" && agentType !== "codex-cli") return;
  for (const event of timeline.events) {
    if (event.model !== null && event.usage !== null) {
      event.usage.apiEquivalent = estimateUsageCost(
        event.usage,
        event.model,
        prices,
        "openai-api",
        1,
      );
    }
  }
  if (timeline.usage !== null) {
    const turns = Math.max(1, timeline.turnCount);
    if (timeline.models.length === 1) {
      timeline.usage.apiEquivalent = estimateUsageCost(
        timeline.usage,
        timeline.models[0] as string,
        prices,
        "openai-api",
        turns,
      );
    } else if (!timeline.truncated) {
      const estimates = timeline.events
        .map((event) => event.usage?.apiEquivalent)
        .filter((item): item is AgentSessionCostEstimate => item !== null && item !== undefined);
      const aggregated = aggregateEstimates(estimates);
      if (aggregated !== null) timeline.usage.apiEquivalent = aggregated;
    } else {
      timeline.usage.apiEquivalent = unpricedEstimate(turns);
    }
  }
}

/** Rust `apply_native_cost_estimate_to_summary`（只对 codex-* 生效）。 */
export function applyNativeCostEstimateToSummary(
  agentType: string,
  summary: AgentSessionNativeSummary,
  prices: ModelPrice[],
): void {
  if (agentType !== "codex-desktop" && agentType !== "codex-cli") return;
  if (summary.usage === null) return;
  const turns = Math.max(1, summary.turnCount);
  if (summary.models.length === 1) {
    summary.usage.apiEquivalent = estimateUsageCost(
      summary.usage,
      summary.models[0] as string,
      prices,
      "openai-api",
      turns,
    );
  } else {
    summary.usage.apiEquivalent = unpricedEstimate(turns);
  }
}