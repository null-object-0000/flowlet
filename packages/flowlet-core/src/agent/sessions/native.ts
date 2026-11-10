// Agent 原生会话目录（Rust core/agent_session_metadata.rs 的桌面读路径）。
//
// Owner: desktop-observability。职责：
// - 扫描本机 Claude Code / Codex(CLI+Desktop) / Pi / OpenCode / Hermes Agent 原生会话；
// - 用 agent_session_snapshots 补齐 nativeSummary / nativeSyncedAt，并追加已归档会话；
// - 与 request_logs 观测会话合并（Rust merge_agent_session_catalog）；
// - 根会话运行态聚合、OpenCode 待确认优先、未关联 Flowlet 请求标记；
// - 列表筛选 / 搜索 / 项目路径追溯 / 分页（Rust agent_sessions_page）。
//
// 字段命名严格用 Rust `AgentSessionRow` 的 camelCase serde 输出。DeepSeek Harness
// 的原生目录由 `./deepseek-harness.ts` 提供（v4/v3 已支持，缺代际返回明确错误）。
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { JsonRow } from "../../types.ts";
import type { ModelPrice } from "../../storage/prices.ts";
import {
  listAgentSnapshotDetails,
  sessionTimeMillis,
  type AgentSessionNativeSummary as StoredNativeSummary,
} from "../../storage/agent-native.ts";
import type { AgentSessionNativeSummary } from "./timeline.ts";
import {
  applyNativeCostEstimateToSummary,
  codexHome,
  collectJsonlFiles,
  formatUnixMillis,
  formatUnixSeconds,
  hermesDatabaseCandidates,
  homeDir,
  opencodeDatabaseCandidates,
  readOnlyDatabase,
  stringField,
  truncateChars,
} from "./timeline.ts";
import { dshNativeSessions, dshSessionsRootExists } from "./deepseek-harness.ts";

const MAX_CLAUDE_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_RUNTIME_STATUS_BYTES = 256 * 1024;
const CLAUDE_RUNNING_FRESHNESS_MS = 30 * 60 * 1000;
const CLAUDE_WAITING_USER_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const CODEX_RUNNING_FRESHNESS_MS = 30 * 60 * 1000;
const CODEX_WAITING_USER_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const OPENCODE_EMPTY_ASSISTANT_GRACE_MILLIS = 30_000;
const EMPTY_SESSION_TIME = "1970-01-01T00:00:00Z";
const MAX_PI_SESSION_SUMMARY_BYTES = 64 * 1024;

// 列表扫描只需要文件头/尾，避免把超大 JSONL 整体读入内存。
function readJsonlHead(filePath: string, maxBytes = MAX_CLAUDE_TRANSCRIPT_BYTES): JsonRow[] {
  const text = readFileRange(filePath, 0, maxBytes);
  if (text === null) return [];
  return parseJsonlText(text);
}

function readJsonlTail(filePath: string): JsonRow[] {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return [];
  }
  const start = Math.max(0, size - MAX_RUNTIME_STATUS_BYTES);
  const text = readFileRange(filePath, start, MAX_RUNTIME_STATUS_BYTES);
  if (text === null) return [];
  const trimmed = start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  return parseJsonlText(trimmed);
}

function readFileRange(filePath: string, start: number, length: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString("utf8");
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

function parseJsonlText(text: string): JsonRow[] {
  const rows: JsonRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        rows.push(parsed as JsonRow);
      }
    } catch {
      /* 跳过坏行 */
    }
  }
  return rows;
}

function readJsonlLines(filePath: string): JsonRow[] {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return [];
  }
  const text = readFileRange(filePath, 0, size);
  return text === null ? [] : parseJsonlText(text);
}

function modifiedIso(filePath: string): string | null {
  const millis = modifiedMs(filePath);
  return millis === null ? null : new Date(millis).toISOString();
}

function parentDirectory(filePath: string): string | null {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return slash <= 0 ? null : filePath.slice(0, slash);
}

function laterSessionTime(left: string, right: string): string {
  return sessionTimeMillis(right) > sessionTimeMillis(left) ? right : left;
}

// ─── 行构造（Rust native_row） ───────────────────────────────────────────────

export interface NativeSessionRowInput {
  agentType: string;
  sessionId: string;
  parentSessionId?: string | null;
  runtimeStatus: string;
  title?: string | null;
  projectPath?: string | null;
  nativeSessionDir?: string | null;
  nativeStartedAt?: string | null;
  nativeUpdatedAt?: string | null;
  nativeSource?: string | null;
  nativeProfile?: string | null;
}

/** 构造与 Rust `AgentSessionRow`（camelCase）同形的原生会话行。 */
export function nativeSessionRow(input: NativeSessionRowInput): JsonRow {
  const activityAt = input.nativeUpdatedAt ?? input.nativeStartedAt ?? EMPTY_SESSION_TIME;
  const row: JsonRow = {
    agentType: input.agentType,
    sessionId: input.sessionId,
    runtimeStatus: input.runtimeStatus,
    title: input.title ?? null,
    projectPath: input.projectPath ?? null,
    parentSessionId: input.parentSessionId ?? null,
    clientId: null,
    clientName: null,
    nativeStartedAt: input.nativeStartedAt ?? null,
    nativeUpdatedAt: input.nativeUpdatedAt ?? null,
    activityAt,
    flowletObserved: false,
    startedAt: activityAt,
    updatedAt: activityAt,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    knownTokens: 0,
    inputTokens: 0,
    inputCachedTokens: 0,
    inputUncachedTokens: 0,
    cacheMeasuredInputTokens: 0,
    outputTokens: 0,
    unknownUsageCount: 0,
    estimatedCost: 0,
    estimatedInputUncachedCost: 0,
    estimatedInputCachedCost: 0,
    estimatedInputCacheWriteCost: 0,
    estimatedOutputCost: 0,
    nativeSummary: null,
    nativeSyncedAt: null,
    hasFlowletRequests: false,
  };
  // Rust 侧 native_source / native_profile / native_session_dir 是
  // `skip_serializing_if = "Option::is_none"`，缺失时不输出。
  if (input.nativeSource !== undefined && input.nativeSource !== null) {
    row.nativeSource = input.nativeSource;
  }
  if (input.nativeProfile !== undefined && input.nativeProfile !== null) {
    row.nativeProfile = input.nativeProfile;
  }
  if (input.nativeSessionDir !== undefined && input.nativeSessionDir !== null) {
    row.nativeSessionDir = input.nativeSessionDir;
  }
  return row;
}

// ─── Claude Code ────────────────────────────────────────────────────────────

function classifyClaudePath(
  projectsRoot: string,
  filePath: string,
): { sessionId: string; parent: string | null } | null {
  const relative = filePath.slice(projectsRoot.length).replace(/^[\\/]+/, "");
  const parts = relative.split(/[\\/]/);
  if (parts.length === 2) {
    const file = parts[1] as string;
    const dot = file.lastIndexOf(".");
    const stem = dot >= 0 ? file.slice(0, dot) : file;
    return stem === "" ? null : { sessionId: stem, parent: null };
  }
  if (parts.length === 4 && parts[2] === "subagents") {
    const file = parts[3] as string;
    const dot = file.lastIndexOf(".");
    const stem = dot >= 0 ? file.slice(0, dot) : file;
    return stem === "" ? null : { sessionId: stem, parent: parts[1] as string };
  }
  return null;
}

function claudeRawRuntimeStatus(filePath: string): string {
  let status = "idle";
  for (const value of readJsonlTail(filePath)) {
    switch (value.type) {
      case "user":
        if (value.isMeta !== true) status = "running";
        break;
      case "assistant": {
        const message = (value.message ?? {}) as JsonRow;
        const blocks = Array.isArray(message.content) ? message.content : [];
        const waitingForUser = blocks.some((block) => {
          const row = block as JsonRow;
          return (
            row.type === "tool_use" &&
            (row.name === "AskUserQuestion" || row.name === "ExitPlanMode")
          );
        });
        status = waitingForUser
          ? "waiting_user"
          : message.stop_reason === "tool_use"
            ? "running"
            : "idle";
        break;
      }
      case "system":
        if (
          value.subtype === "turn_duration" ||
          value.subtype === "away_summary" ||
          value.subtype === "local_command"
        ) {
          status = "idle";
        }
        break;
      default:
        break;
    }
  }
  return status;
}

/** Claude 运行态新鲜度（Rust `apply_claude_runtime_freshness`）。 */
function applyClaudeFreshness(status: string, modified: number | null): string {
  const maxAgeMs =
    status === "running"
      ? CLAUDE_RUNNING_FRESHNESS_MS
      : status === "waiting_user"
        ? CLAUDE_WAITING_USER_FRESHNESS_MS
        : null;
  if (maxAgeMs === null || modified === null) return status;
  return Date.now() - modified > maxAgeMs ? "idle" : status;
}

function claudeRuntimeStatus(filePath: string): string {
  return applyClaudeFreshness(claudeRawRuntimeStatus(filePath), modifiedMs(filePath));
}

interface CachedClaudeSession {
  size: number;
  modified: number;
  title: string | null;
  projectPath: string | null;
  nativeStartedAt: string | null;
  rawRuntimeStatus: string;
}

/** 与 Rust `CLAUDE_SESSION_CACHE` 一致：文件长度/mtime 未变时复用头部解析结果。 */
const claudeSessionCache = new Map<string, CachedClaudeSession>();

function cachedClaudeSession(filePath: string): CachedClaudeSession | null {
  let size: number;
  let modified: number;
  try {
    const metadata = statSync(filePath);
    size = metadata.size;
    modified = metadata.mtimeMs;
  } catch {
    return null;
  }
  const cached = claudeSessionCache.get(filePath);
  if (cached !== undefined && cached.size === size && cached.modified === modified) {
    return cached;
  }
  let projectPath: string | null = null;
  let nativeStartedAt: string | null = null;
  let title: string | null = null;
  for (const value of readJsonlHead(filePath)) {
    if (projectPath === null) projectPath = stringField(value, "cwd");
    if (nativeStartedAt === null) nativeStartedAt = stringField(value, "timestamp");
    if (value.type === "custom-title") {
      title = stringField(value, "customTitle") ?? stringField(value, "title") ?? title;
    } else if (value.type === "ai-title" && title === null) {
      title = stringField(value, "aiTitle") ?? stringField(value, "title");
    }
  }
  const entry: CachedClaudeSession = {
    size,
    modified,
    title,
    projectPath,
    nativeStartedAt,
    rawRuntimeStatus: claudeRawRuntimeStatus(filePath),
  };
  claudeSessionCache.set(filePath, entry);
  return entry;
}

function claudeSessions(): JsonRow[] {
  const home = homeDir();
  if (home === null) return [];
  const root = `${home}/.claude/projects`;
  if (!isDirectory(root)) return [];
  const paths: string[] = [];
  collectJsonlFiles(root, paths);
  const currentPaths = new Set(paths);
  for (const cachedPath of claudeSessionCache.keys()) {
    if (!currentPaths.has(cachedPath)) claudeSessionCache.delete(cachedPath);
  }
  const rows: JsonRow[] = [];
  for (const filePath of paths) {
    const classified = classifyClaudePath(root, filePath);
    if (classified === null) continue;
    const cached = cachedClaudeSession(filePath);
    if (cached === null) continue;
    rows.push(
      nativeSessionRow({
        agentType: "claude-code",
        sessionId: classified.sessionId,
        parentSessionId: classified.parent,
        runtimeStatus: applyClaudeFreshness(cached.rawRuntimeStatus, cached.modified),
        title: cached.title,
        projectPath: cached.projectPath,
        nativeSessionDir: parentDirectory(filePath),
        nativeStartedAt: cached.nativeStartedAt,
        nativeUpdatedAt: modifiedIso(filePath),
      }),
    );
  }
  return rows;
}

// ─── Codex ──────────────────────────────────────────────────────────────────

function codexSessionIndex(): Map<string, { title: string | null; updatedAt: string | null }> {
  const index = new Map<string, { title: string | null; updatedAt: string | null }>();
  const indexPath = `${codexHome()}/session_index.jsonl`;
  if (!isFile(indexPath)) return index;
  for (const value of readJsonlLines(indexPath)) {
    const sessionId = stringField(value, "id");
    if (sessionId === null) continue;
    index.set(sessionId, {
      title: stringField(value, "thread_name"),
      updatedAt: stringField(value, "updated_at"),
    });
  }
  return index;
}

function codexRuntimeStatus(filePath: string): string {
  let status = "idle";
  let turnRunning = false;
  const pendingUserInput = new Set<string>();
  for (const value of readJsonlTail(filePath)) {
    const topType = value.type;
    const payload = (value.payload ?? {}) as JsonRow;
    if (topType === "event_msg") {
      switch (payload.type) {
        case "task_started":
        case "turn_started":
          turnRunning = true;
          pendingUserInput.clear();
          status = "running";
          break;
        case "task_complete":
        case "turn_complete":
        case "task_aborted":
        case "turn_aborted":
          turnRunning = false;
          pendingUserInput.clear();
          status = "idle";
          break;
        case "exec_approval_request":
        case "apply_patch_approval_request":
        case "request_user_input":
          if (turnRunning) status = "waiting_user";
          break;
        default:
          break;
      }
      continue;
    }
    if (topType !== "response_item") continue;
    switch (payload.type) {
      case "function_call":
        if (stringField(payload, "name") === "request_user_input") {
          const callId = stringField(payload, "call_id");
          if (callId !== null) pendingUserInput.add(callId);
          status = "waiting_user";
        } else {
          status = pendingUserInput.size === 0 ? "running" : "waiting_user";
        }
        break;
      case "function_call_output":
      case "custom_tool_call_output": {
        const callId = stringField(payload, "call_id");
        if (callId !== null) pendingUserInput.delete(callId);
        status = pendingUserInput.size === 0 ? "running" : "waiting_user";
        break;
      }
      case "custom_tool_call":
        status = pendingUserInput.size === 0 ? "running" : "waiting_user";
        break;
      default:
        break;
    }
  }
  return applyCodexFreshness(status, modifiedMs(filePath));
}

/** Codex 运行态新鲜度（Rust `apply_codex_runtime_freshness`）。 */
function applyCodexFreshness(status: string, modified: number | null): string {
  const maxAgeMs =
    status === "running"
      ? CODEX_RUNNING_FRESHNESS_MS
      : status === "waiting_user"
        ? CODEX_WAITING_USER_FRESHNESS_MS
        : null;
  if (maxAgeMs === null || modified === null) return status;
  return Date.now() - modified > maxAgeMs ? "idle" : status;
}

function codexSessions(): JsonRow[] {
  const root = `${codexHome()}/sessions`;
  if (!isDirectory(root)) return [];
  const index = codexSessionIndex();
  const paths: string[] = [];
  collectJsonlFiles(root, paths);
  const rows: JsonRow[] = [];
  for (const filePath of paths) {
    const head = readJsonlHead(filePath, 64 * 1024)[0];
    if (head === undefined || head.type !== "session_meta") continue;
    const payload = (head.payload ?? {}) as JsonRow;
    const originator = stringField(payload, "originator");
    const agentType =
      originator === "Codex Desktop"
        ? "codex-desktop"
        : originator === "codex_exec" ||
            originator === "codex_cli_rs" ||
            originator === "Codex CLI" ||
            originator === "codex-cli"
          ? "codex-cli"
          : null;
    if (agentType === null) continue;
    const sessionId = stringField(payload, "id");
    if (sessionId === null) continue;
    const spawn = asNestedRow(asNestedRow(payload.source, "subagent"), "thread_spawn");
    const parentSessionId =
      stringField(payload, "parent_thread_id") ??
      (spawn === null ? null : stringField(spawn, "parent_thread_id"));
    const indexed = index.get(sessionId);
    const title =
      indexed?.title ??
      (spawn === null
        ? null
        : (stringField(spawn, "agent_nickname") ?? stringField(spawn, "agent_path")));
    const fileUpdatedAt = modifiedIso(filePath);
    const nativeUpdatedAt =
      indexed?.updatedAt !== undefined && indexed?.updatedAt !== null
        ? fileUpdatedAt === null
          ? indexed.updatedAt
          : laterSessionTime(indexed.updatedAt, fileUpdatedAt)
        : fileUpdatedAt;
    rows.push(
      nativeSessionRow({
        agentType,
        sessionId,
        parentSessionId,
        runtimeStatus: codexRuntimeStatus(filePath),
        title,
        projectPath: stringField(payload, "cwd"),
        nativeSessionDir: parentDirectory(filePath),
        nativeStartedAt: stringField(payload, "timestamp") ?? stringField(head, "timestamp"),
        nativeUpdatedAt,
      }),
    );
  }
  return rows;
}

function asNestedRow(value: unknown, field: string): JsonRow | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = (value as JsonRow)[field];
  return nested !== null && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as JsonRow)
    : null;
}

// ─── Pi ─────────────────────────────────────────────────────────────────────

function piSessions(): JsonRow[] {
  const home = homeDir();
  if (home === null) return [];
  const root = `${home}/.pi/agent/sessions`;
  if (!isDirectory(root)) return [];
  const paths: string[] = [];
  collectJsonlFiles(root, paths);
  const rows: JsonRow[] = [];
  for (const filePath of paths) {
    const row = readPiSessionSummary(filePath);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function readPiSessionSummary(filePath: string): JsonRow | null {
  const text = readFileRange(filePath, 0, MAX_PI_SESSION_SUMMARY_BYTES);
  if (text === null) return null;
  let sessionId: string | null = null;
  let parentSessionId: string | null = null;
  let projectPath: string | null = null;
  let nativeStartedAt: string | null = null;
  let nativeUpdatedAt: string | null = null;
  let title: string | null = null;
  let firstUserText: string | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: JsonRow;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      value = parsed as JsonRow;
    } catch {
      continue;
    }
    switch (value.type) {
      case "session":
        if (sessionId === null) sessionId = stringField(value, "id");
        if (projectPath === null) projectPath = stringField(value, "cwd");
        if (nativeStartedAt === null) nativeStartedAt = stringField(value, "timestamp");
        if (parentSessionId === null) {
          const parent = stringField(value, "parentSession");
          parentSessionId = parent === null ? null : piParentSessionId(parent);
        }
        break;
      case "session_info": {
        const name = stringField(value, "name");
        if (name !== null) title = name;
        break;
      }
      case "message": {
        const message = value.message;
        if (
          firstUserText === null &&
          message !== null &&
          typeof message === "object" &&
          !Array.isArray(message) &&
          (message as JsonRow).role === "user"
        ) {
          firstUserText = piFirstUserText(message as JsonRow);
        }
        break;
      }
      default:
        break;
    }
    const timestamp = stringField(value, "timestamp");
    if (timestamp !== null) nativeUpdatedAt = timestamp;
  }
  if (nativeUpdatedAt === null) nativeUpdatedAt = modifiedIso(filePath);
  if (sessionId === null) return null;
  if (title === null) title = firstUserText;
  return nativeSessionRow({
    agentType: "pi",
    sessionId,
    parentSessionId,
    runtimeStatus: piRuntimeStatus(filePath),
    title,
    projectPath,
    nativeSessionDir: parentDirectory(filePath),
    nativeStartedAt,
    nativeUpdatedAt,
  });
}

function piRuntimeStatus(filePath: string): string {
  let status = "idle";
  for (const value of readJsonlTail(filePath)) {
    if (value.type !== "message") continue;
    const message = (value.message ?? {}) as JsonRow;
    switch (message.role) {
      case "user":
      case "toolResult":
        status = "running";
        break;
      case "assistant":
        status = message.stopReason === "toolUse" ? "running" : "idle";
        break;
      default:
        break;
    }
  }
  return status;
}

function piParentSessionId(parentSession: string): string | null {
  const base = parentSession.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  const separator = stem.lastIndexOf("_");
  if (separator < 0) return null;
  const uuid = stem.slice(separator + 1);
  return uuid === "" ? null : uuid;
}

function piFirstUserText(message: JsonRow): string | null {
  const content = message.content;
  let text = "";
  if (typeof content === "string") text = content.trim();
  else if (Array.isArray(content)) {
    text = content
      .map((block) => {
        const row = block as JsonRow;
        return row.type === "text" && typeof row.text === "string" ? row.text : null;
      })
      .filter((item): item is string => item !== null)
      .join(" ")
      .trim();
  }
  return text === "" ? null : truncateSessionTitle(text, 80);
}

function truncateSessionTitle(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : text;
}

// ─── OpenCode ───────────────────────────────────────────────────────────────

function opencodeSessions(): JsonRow[] {
  const rows = new Map<string, JsonRow>();
  const now = Date.now();
  for (const candidate of opencodeDatabaseCandidates()) {
    if (!isFile(candidate)) continue;
    const connection = readOnlyDatabase(candidate);
    if (connection === null) continue;
    try {
      const records = connection
        .prepare(
          `SELECT
              s.id, s.title, s.directory, s.parent_id, s.time_created, s.time_updated,
              lm.data AS latest_message,
              lm.time_updated AS latest_message_updated_at,
              EXISTS(SELECT 1 FROM part p WHERE p.message_id = lm.id) AS latest_message_has_parts
           FROM session s
           LEFT JOIN message lm ON lm.id = (
             SELECT latest.id FROM message latest
             WHERE latest.session_id = s.id
             ORDER BY latest.time_created DESC LIMIT 1
           )`,
        )
        .all() as JsonRow[];
      for (const record of records) {
        const sessionId = typeof record.id === "string" ? record.id : null;
        if (sessionId === null) continue;
        const key = `opencode\0${sessionId}`;
        if (rows.has(key)) continue;
        let latestMessage: JsonRow | null = null;
        if (typeof record.latest_message === "string") {
          try {
            const parsed: unknown = JSON.parse(record.latest_message);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
              latestMessage = parsed as JsonRow;
            }
          } catch {
            latestMessage = null;
          }
        }
        const runtimeStatus =
          latestMessage === null
            ? "idle"
            : inferOpencodeRuntimeStatus(
                latestMessage,
                Number(record.latest_message_has_parts ?? 0) !== 0,
                typeof record.latest_message_updated_at === "number"
                  ? record.latest_message_updated_at
                  : null,
                now,
              );
        const created =
          typeof record.time_created === "number" ? formatUnixMillis(record.time_created) : null;
        const updated =
          typeof record.time_updated === "number" ? formatUnixMillis(record.time_updated) : null;
        rows.set(
          key,
          nativeSessionRow({
            agentType: "opencode",
            sessionId,
            parentSessionId: typeof record.parent_id === "string" ? record.parent_id : null,
            runtimeStatus,
            title:
              typeof record.title === "string" && record.title.trim() !== "" ? record.title : null,
            projectPath:
              typeof record.directory === "string" && record.directory.trim() !== ""
                ? record.directory
                : null,
            nativeSessionDir: parentDirectory(candidate),
            nativeStartedAt: created,
            nativeUpdatedAt: updated,
          }),
        );
      }
    } catch {
      /* 结构不兼容的库直接跳过 */
    } finally {
      connection.close();
    }
  }
  return [...rows.values()];
}

function inferOpencodeRuntimeStatus(
  message: JsonRow,
  hasParts: boolean,
  updatedAt: number | null,
  nowMillis: number,
): string {
  if (message.role === "user") return "running";
  if (message.role === "assistant") {
    const time = message.time;
    const completed =
      time !== null && typeof time === "object" ? (time as JsonRow).completed : undefined;
    if (completed === undefined && message.error === undefined) {
      const recent =
        updatedAt !== null && nowMillis - updatedAt <= OPENCODE_EMPTY_ASSISTANT_GRACE_MILLIS;
      return hasParts || recent ? "running" : "idle";
    }
    return "idle";
  }
  return "unknown";
}

// ─── Hermes Agent ───────────────────────────────────────────────────────────

function hermesSessions(): JsonRow[] {
  const rows = new Map<string, JsonRow>();
  for (const candidate of hermesDatabaseCandidates()) {
    if (!isFile(candidate)) continue;
    const connection = readOnlyDatabase(candidate);
    if (connection === null) continue;
    try {
      const records = connection
        .prepare(
          `SELECT s.id, s.title, s.cwd, s.parent_session_id, s.started_at, s.ended_at,
                  s.source, s.profile_name,
                  (SELECT m.role FROM messages m
                    WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1) AS last_role
           FROM sessions s`,
        )
        .all() as JsonRow[];
      for (const record of records) {
        const sessionId = typeof record.id === "string" ? record.id : null;
        if (sessionId === null) continue;
        const key = `hermes\0${sessionId}`;
        if (rows.has(key)) continue;
        const started =
          typeof record.started_at === "number" ? formatUnixSeconds(record.started_at) : null;
        const ended = typeof record.ended_at === "number" ? formatUnixSeconds(record.ended_at) : null;
        const lastRole = typeof record.last_role === "string" ? record.last_role : null;
        const runtimeStatus =
          typeof record.ended_at === "number"
            ? "idle"
            : lastRole === "user"
              ? "running"
              : lastRole === "assistant"
                ? "idle"
                : "unknown";
        const source = typeof record.source === "string" ? record.source.trim() : "";
        const profile = typeof record.profile_name === "string" ? record.profile_name.trim() : "";
        rows.set(
          key,
          nativeSessionRow({
            agentType: "hermes",
            sessionId,
            parentSessionId:
              typeof record.parent_session_id === "string" ? record.parent_session_id : null,
            runtimeStatus,
            title:
              typeof record.title === "string" && record.title.trim() !== "" ? record.title : null,
            projectPath:
              typeof record.cwd === "string" && record.cwd.trim() !== "" ? record.cwd : null,
            nativeSessionDir: parentDirectory(candidate),
            nativeStartedAt: started,
            nativeUpdatedAt: ended ?? started,
            nativeSource: source === "" ? null : source,
            nativeProfile: profile === "" ? null : profile,
          }),
        );
      }
    } catch {
      /* 结构不兼容的库直接跳过 */
    } finally {
      connection.close();
    }
  }
  return [...rows.values()];
}

// ─── 原生目录 ───────────────────────────────────────────────────────────────

/** Rust `list_native_agent_sessions`：全部适配器结果按 (agent_type, session_id) 去重。 */
export function listNativeAgentSessions(): JsonRow[] {
  const rows = new Map<string, JsonRow>();
  for (const row of [
    ...claudeSessions(),
    ...codexSessions(),
    ...piSessions(),
    ...opencodeSessions(),
    ...hermesSessions(),
    ...dshNativeSessions(),
  ]) {
    const key = `${String(row.agentType)}\0${String(row.sessionId)}`;
    if (!rows.has(key)) rows.set(key, row);
  }
  return [...rows.values()];
}

/** 本机存在原生来源的 agent_type（Rust `available_native_agent_types`）。 */
export function availableNativeAgentTypes(): Set<string> {
  const types = new Set<string>();
  const home = homeDir();
  if (home !== null) {
    if (isDirectory(`${home}/.claude/projects`)) types.add("claude-code");
    if (isDirectory(`${home}/.pi/agent/sessions`)) types.add("pi");
  }
  if (isDirectory(`${codexHome()}/sessions`)) {
    types.add("codex-cli");
    types.add("codex-desktop");
  }
  if (opencodeDatabaseCandidates().some(isFile)) types.add("opencode");
  if (hermesDatabaseCandidates().some(isFile)) types.add("hermes");
  if (dshSessionsRootExists()) types.add("deepseek-harness");
  return types;
}

// ─── 快照补齐（Rust enrich_native_agent_sessions） ──────────────────────────

/**
 * 用 `agent_session_snapshots` 补齐原生会话的 nativeSummary/nativeSyncedAt，
 * 并把「源文件已删除」的归档快照追加回目录（Rust enrich_native_agent_sessions）。
 */
export function enrichNativeAgentSessions(
  rows: JsonRow[],
  snapshots: ReturnType<typeof listAgentSnapshotDetails>,
  prices: ModelPrice[],
): JsonRow[] {
  const byKey = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) {
    byKey.set(`${snapshot.agentType}\0${snapshot.sessionId}`, snapshot);
  }
  const enriched = rows.slice();
  const liveKeys = new Set<string>();
  for (const row of enriched) {
    const key = `${String(row.agentType)}\0${String(row.sessionId)}`;
    liveKeys.add(key);
    const snapshot = byKey.get(key);
    if (snapshot === undefined) continue;
    const stored = snapshot.summary;
    if (stored === null) continue;
    const summary = toTimelineSummary(stored);
    applyNativeCostEstimateToSummary(String(row.agentType), summary, prices);
    row.nativeSummary = summary;
    row.nativeSyncedAt = snapshot.syncedAt;
  }
  for (const snapshot of snapshots) {
    const key = `${snapshot.agentType}\0${snapshot.sessionId}`;
    if (liveKeys.has(key)) continue;
    const stored = snapshot.summary;
    if (stored === null || stored.sourceAvailable) continue;
    const row: JsonRow =
      snapshot.session === null
        ? archivedSessionRow(snapshot.agentType, snapshot.sessionId)
        : { ...snapshot.session };
    row.runtimeStatus = "unknown";
    row.nativeSummary = toTimelineSummary(stored);
    row.nativeSyncedAt = snapshot.syncedAt;
    enriched.push(row);
  }
  return enriched;
}

/** 存储层的摘要结构 → 时间线模块的摘要结构（可选字段归一成 null）。 */
function toTimelineSummary(summary: StoredNativeSummary): AgentSessionNativeSummary {
  const usage = summary.usage;
  return {
    sourceAvailable: summary.sourceAvailable,
    truncated: summary.truncated,
    turnCount: summary.turnCount,
    usage:
      usage === null
        ? null
        : {
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
            totalTokens: usage.totalTokens,
            cost: usage.cost,
            costCurrency: usage.costCurrency,
            apiEquivalent: null,
          },
    models: [...summary.models],
  };
}

function archivedSessionRow(agentType: string, sessionId: string): JsonRow {
  return nativeSessionRow({ agentType, sessionId, runtimeStatus: "unknown" });
}

// ─── 合并 / 运行态 / 标记 ───────────────────────────────────────────────────

export function sessionKey(row: JsonRow): string {
  return `${String(row.agentType)}\0${String(row.sessionId)}`;
}

/** Rust `merge_agent_session_catalog`。 */
export function mergeAgentSessionCatalog(observed: JsonRow[], native: JsonRow[]): JsonRow[] {
  const merged = new Map<string, JsonRow>();
  for (const row of native) merged.set(sessionKey(row), row);
  for (const observedRow of observed) {
    const key = sessionKey(observedRow);
    const nativeRow = merged.get(key);
    if (nativeRow === undefined) {
      merged.set(key, observedRow);
      continue;
    }
    nativeRow.title = nativeRow.title ?? observedRow.title ?? null;
    nativeRow.projectPath = nativeRow.projectPath ?? observedRow.projectPath ?? null;
    nativeRow.nativeSessionDir =
      nativeRow.nativeSessionDir ?? observedRow.nativeSessionDir ?? null;
    nativeRow.parentSessionId = nativeRow.parentSessionId ?? observedRow.parentSessionId ?? null;
    nativeRow.clientId = observedRow.clientId ?? null;
    nativeRow.clientName = observedRow.clientName ?? null;
    nativeRow.startedAt = observedRow.startedAt;
    nativeRow.updatedAt = observedRow.updatedAt;
    nativeRow.activityAt = laterSessionTime(
      String(nativeRow.activityAt),
      String(observedRow.activityAt),
    );
    nativeRow.requestCount = observedRow.requestCount;
    nativeRow.successCount = observedRow.successCount;
    nativeRow.errorCount = observedRow.errorCount;
    nativeRow.knownTokens = observedRow.knownTokens;
    nativeRow.inputTokens = observedRow.inputTokens;
    nativeRow.inputCachedTokens = observedRow.inputCachedTokens;
    nativeRow.inputUncachedTokens = observedRow.inputUncachedTokens;
    nativeRow.cacheMeasuredInputTokens = observedRow.cacheMeasuredInputTokens;
    nativeRow.outputTokens = observedRow.outputTokens;
    nativeRow.unknownUsageCount = observedRow.unknownUsageCount;
    nativeRow.estimatedCost = observedRow.estimatedCost;
    nativeRow.estimatedInputUncachedCost = observedRow.estimatedInputUncachedCost;
    nativeRow.estimatedInputCachedCost = observedRow.estimatedInputCachedCost;
    nativeRow.estimatedInputCacheWriteCost = observedRow.estimatedInputCacheWriteCost;
    nativeRow.estimatedOutputCost = observedRow.estimatedOutputCost;
    nativeRow.flowletObserved = true;
  }
  const catalog = [...merged.values()];
  aggregateDescendantRuntimeStatus(catalog);
  return catalog;
}

function runtimeStatusPriority(status: string): number {
  if (status === "waiting_user") return 2;
  if (status === "running") return 1;
  return 0;
}

/** Rust `aggregate_descendant_runtime_status`：子会话活跃状态覆盖祖先。 */
export function aggregateDescendantRuntimeStatus(catalog: JsonRow[]): void {
  const indexByKey = new Map<string, number>();
  catalog.forEach((row, index) => indexByKey.set(sessionKey(row), index));
  const parentByKey = new Map<string, string>();
  for (const row of catalog) {
    if (row.parentSessionId) {
      parentByKey.set(sessionKey(row), `${String(row.agentType)}\0${String(row.parentSessionId)}`);
    }
  }
  const activeDescendants: Array<[string, string]> = [];
  catalog.forEach((row, index) => {
    if (runtimeStatusPriority(String(row.runtimeStatus)) > 0) {
      activeDescendants.push([keyAt(index), String(row.runtimeStatus)]);
    }
  });
  function keyAt(index: number): string {
    const row = catalog[index] as JsonRow;
    return sessionKey(row);
  }
  for (const [descendantKey, descendantStatus] of activeDescendants) {
    let current = descendantKey;
    const visited = new Set<string>();
    while (!visited.has(current)) {
      visited.add(current);
      const parentKey = parentByKey.get(current);
      if (parentKey === undefined) break;
      const parentIndex = indexByKey.get(parentKey);
      if (parentIndex === undefined) break;
      const parent = catalog[parentIndex] as JsonRow;
      if (runtimeStatusPriority(descendantStatus) > runtimeStatusPriority(String(parent.runtimeStatus))) {
        parent.runtimeStatus = descendantStatus;
      }
      current = parentKey;
    }
  }
}

/** Rust `apply_opencode_pending_sessions`。 */
export function applyOpencodePendingSessions(
  catalog: JsonRow[],
  pendingSessions: Set<string>,
): void {
  if (pendingSessions.size === 0) return;
  for (const row of catalog) {
    if (row.agentType === "opencode" && pendingSessions.has(String(row.sessionId))) {
      row.runtimeStatus = "waiting_user";
    }
  }
  aggregateDescendantRuntimeStatus(catalog);
}

/** Rust `mark_unassociated_flowlet_requests`。 */
export function markUnassociatedFlowletRequests(catalog: JsonRow[], clients: Set<string>): void {
  for (const row of catalog) {
    if (!row.flowletObserved && clients.has(String(row.agentType))) {
      row.hasFlowletRequests = true;
    }
  }
}

/** 有未关联会话标识的客户端集合（Rust mark_unassociated_flowlet_requests 的 SQL）。 */
export function unassociatedFlowletClients(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT client_id FROM request_logs
       WHERE is_last_attempt = 1
         AND agent_session_id IS NULL
         AND client_id IS NOT NULL
         AND client_id <> ''`,
    )
    .all() as JsonRow[];
  return new Set(rows.map((row) => String(row.client_id)));
}

// ─── 列表筛选 / 分页（Rust agent_sessions_page） ────────────────────────────

export interface AgentSessionsFilter {
  page: number;
  pageSize: number;
  search: string;
  agentType: string;
  runtimeStatus: string;
  projectPath: string;
}

export function sessionMatchesSearch(row: JsonRow, search: string): boolean {
  const lower = search.toLowerCase();
  return (
    String(row.sessionId).toLowerCase().includes(lower) ||
    (row.title !== null && String(row.title).toLowerCase().includes(lower)) ||
    (row.projectPath !== null && String(row.projectPath).toLowerCase().includes(lower))
  );
}

function sessionMatchesProjectPath(row: JsonRow, projectPath: string): boolean {
  const normalize = (value: string): string =>
    value.trim().replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  if (projectPath.trim() === "") return true;
  if (row.projectPath === null || row.projectPath === undefined) return false;
  const project = normalize(projectPath);
  const session = normalize(String(row.projectPath));
  return session === project || session.startsWith(`${project}/`);
}

function matchingRootSessionKeys(
  catalog: JsonRow[],
  matches: (row: JsonRow) => boolean,
): Set<string> {
  const parentByKey = new Map<string, string>();
  for (const row of catalog) {
    if (row.parentSessionId) {
      parentByKey.set(sessionKey(row), `${String(row.agentType)}\0${String(row.parentSessionId)}`);
    }
  }
  const knownKeys = new Set(catalog.map(sessionKey));
  const roots = new Set<string>();
  for (const row of catalog) {
    if (!matches(row)) continue;
    let current = sessionKey(row);
    const visited = new Set<string>();
    while (!visited.has(current)) {
      visited.add(current);
      const parent = parentByKey.get(current);
      if (parent === undefined) {
        if (knownKeys.has(current)) roots.add(current);
        break;
      }
      current = parent;
    }
  }
  return roots;
}

export function sortByActivity(catalog: JsonRow[]): JsonRow[] {
  return catalog.sort((left, right) => {
    const byActivity =
      sessionTimeMillis(String(right.activityAt)) - sessionTimeMillis(String(left.activityAt));
    if (byActivity !== 0) return byActivity;
    // Rust `String::cmp` 是 UTF-8 字节序；用码点比较而不是 localeCompare。
    const leftId = String(right.sessionId);
    const rightId = String(left.sessionId);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

export function agentSessionsPage(
  catalog: JsonRow[],
  filter: AgentSessionsFilter,
): JsonRow {
  const page = Math.max(1, filter.page);
  const pageSize = Math.min(500, Math.max(1, filter.pageSize));
  const offset = (page - 1) * pageSize;
  const search = filter.search.trim().toLowerCase();
  const agentType = filter.agentType.trim();
  const runtimeStatus = filter.runtimeStatus.trim();
  const projectPath = filter.projectPath.trim();
  const matchingRoots =
    search === ""
      ? new Set(catalog.filter((row) => !row.parentSessionId).map(sessionKey))
      : matchingRootSessionKeys(catalog, (row) => sessionMatchesSearch(row, search));
  const projectRoots = matchingRootSessionKeys(catalog, (row) =>
    sessionMatchesProjectPath(row, projectPath),
  );
  const retained = catalog.filter(
    (row) =>
      !row.parentSessionId &&
      matchingRoots.has(sessionKey(row)) &&
      projectRoots.has(sessionKey(row)) &&
      (agentType === "" || row.agentType === agentType) &&
      (runtimeStatus === "" || row.runtimeStatus === runtimeStatus),
  );
  const sorted = sortByActivity(retained);
  return {
    rows: sorted.slice(offset, offset + pageSize),
    total: sorted.length,
    page,
    pageSize,
  };
}

// ─── 小工具 ─────────────────────────────────────────────────────────────────

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function modifiedMs(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

export type { AgentSessionNativeSummary };
