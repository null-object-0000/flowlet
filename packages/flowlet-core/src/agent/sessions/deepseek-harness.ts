// DeepSeek Harness 原生会话解析（Rust core/agent_session_adapter/adapters/deepseek_harness.rs 的移植）。
//
// Owner: desktop-observability。支持 `sessions/**/session[.vN].jsonl[.zstd]` 的
// v0–v4 代际（v4 与 v3 的记录形状只差 `tool/result`，统一按两种形状解析）：
// - 会话列表（标题/项目/父子/运行态/原生用量摘要）；
// - 完整时间线（turn / step / tool / approval / compaction / request 事件 + trace）；
// - 最后一轮交互；
// - 缺失文件 / 未知代际 / 不完整 header 返回与 Rust 一致的明确错误，不返回伪造空数据。
//
// 平台能力：zstd 解压使用 Node 内建 `node:zlib`（zstdDecompressSync，Node 26 可用）。
// 撕裂尾部（torn tail）与 Rust 一样只保留「已完整提交的前缀」，不会因尾部损坏隐藏整份会话。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { JsonRow } from "../../types.ts";
import type {
  AgentSessionNativeSummary,
  AgentSessionNativeUsage,
  AgentSessionTimeline,
  AgentSessionTimelineEvent,
  AgentSessionTrace,
} from "./timeline.ts";

const DSH_CURRENT_FORMAT_VERSION = 4;
const RUNNING_FRESHNESS_MS = 30 * 60 * 1000;
const MAX_RUNTIME_STATUS_BYTES = 256 * 1024;

// ─── 文件发现 ───────────────────────────────────────────────────────────────

function dshSessionsRoot(): string | null {
  // Rust `dsh_sessions_root`：DSH_HOME 已是 harness 根目录；未设置时回退 ~/.dsh。
  const override = process.env.DSH_HOME;
  if (override !== undefined && override !== "") return path.join(override, "sessions");
  const home = homeDir();
  return home === null ? null : path.join(home, ".dsh", "sessions");
}

function homeDir(): string | null {
  const override = process.env.HOME;
  if (override !== undefined && override !== "") return override;
  try {
    const home = homedir();
    return home === "" ? null : home;
  } catch {
    return null;
  }
}

interface CandidateSessionFile {
  filePath: string;
  version: number;
}

/** 官方 `parseSessionFormatLogFilename`：只接纳小写、无前导零的规范名。 */
export function parseSessionLogFilename(filename: string): number | null {
  const stem = filename.endsWith(".zstd") ? filename.slice(0, -5) : filename;
  if (!stem.endsWith(".jsonl")) return null;
  const base = stem.slice(0, -6);
  if (base === "session") return 0;
  if (!base.startsWith("session.v")) return null;
  const raw = base.slice("session.v".length);
  if (raw === "" || !/^[0-9]+$/.test(raw) || raw.startsWith("0")) return null;
  return Number(raw);
}

function sessionFiles(): string[] {
  const root = dshSessionsRoot();
  if (root === null || !isDirectory(root)) return [];
  const pending = [root];
  const candidates: CandidateSessionFile[] = [];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries;
    try {
      entries = readDir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(filePath);
      } else {
        const version = parseSessionLogFilename(entry.name);
        if (version !== null) candidates.push({ filePath, version });
      }
    }
  }
  return selectGenerationFiles(candidates);
}

/** 同一会话目录只保留「不超过支持版本的最新代」，若只有更早代际则取最新一份。 */
function selectGenerationFiles(candidates: CandidateSessionFile[]): string[] {
  const groups = new Map<string, CandidateSessionFile[]>();
  for (const candidate of candidates) {
    const key = path.dirname(candidate.filePath);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const selected: string[] = [];
  for (const group of groups.values()) {
    group.sort((left, right) => {
      if (left.version !== right.version) return left.version - right.version;
      return left.filePath.localeCompare(right.filePath);
    });
    const supported = group.filter((item) => item.version <= DSH_CURRENT_FORMAT_VERSION);
    const pick = supported.length > 0 ? supported[supported.length - 1] : group[group.length - 1];
    if (pick !== undefined) selected.push(pick.filePath);
  }
  return selected.sort();
}

// ─── 会话头 ─────────────────────────────────────────────────────────────────

export interface DshSessionHeader {
  version: number;
  sessionId: string;
  createdAtMillis: number;
  cwd: string | null;
  parentSessionId: string | null;
  isSeeded: boolean;
}

/** Rust `parse_session_header`。 */
export function parseSessionHeader(header: JsonRow): DshSessionHeader {
  if (header.type !== "session") throw new Error("DSH 会话缺少 session 头");
  const version = typeof header.version === "number" ? header.version : null;
  if (version === null) throw new Error("DSH 会话 header 缺少 version");
  if (!(version >= 0 && version <= DSH_CURRENT_FORMAT_VERSION)) {
    throw new Error(
      `DSH 会话格式 v${version} 尚未支持（Flowlet 当前支持 v0-v${DSH_CURRENT_FORMAT_VERSION}）`,
    );
  }
  const id = typeof header.id === "string" ? header.id : null;
  if (id === null) throw new Error("DSH 会话 header 缺少 id");
  return {
    version,
    sessionId: id,
    createdAtMillis: typeof header.createdAt === "number" ? header.createdAt : 0,
    cwd: typeof header.cwd === "string" && header.cwd.trim() !== "" ? header.cwd : null,
    parentSessionId:
      typeof header.parentSession === "string" && header.parentSession.trim() !== ""
        ? header.parentSession
        : null,
    isSeeded:
      header.isSeeded === true ||
      (typeof header.seedLength === "number" && header.seedLength > 0),
  };
}

/** 裁掉 seeded 会话继承自父会话的前缀（最后一条 session/end-seed 之后为本地正文）。 */
function localEventRecords(
  records: JsonRow[],
  header: DshSessionHeader,
): { header: DshSessionHeader; records: JsonRow[] } {
  if (!header.isSeeded) return { header, records };
  let cut: number | null = null;
  records.forEach((value, index) => {
    if (value.type === "session/end-seed") cut = index;
  });
  if (cut === null) return { header, records };
  return {
    header: { ...header, isSeeded: false },
    records: records.slice(cut),
  };
}

/** Rust `read_session`：解压读取并返回本地正文记录。 */
export function readDshSession(filePath: string): { header: DshSessionHeader; records: JsonRow[] } {
  const records = readDshRecords(filePath);
  const headerValue = records[0];
  if (headerValue === undefined) throw new Error("DSH 会话缺少 header");
  const header = parseSessionHeader(headerValue);
  return localEventRecords(records, header);
}

// ─── zstd / JSONL 读取 ──────────────────────────────────────────────────────

function readFileBytes(filePath: string): Buffer {
  return readFileSync(filePath);
}

/** Rust `read_records`：正常整流解码；失败时逐完整分帧解码并尽力恢复撕裂尾部。 */
export function readDshRecords(filePath: string): JsonRow[] {
  let bytes: Buffer;
  try {
    bytes = readFileBytes(filePath);
  } catch (error) {
    throw new Error(`读取 DSH 会话 ${filePath} 失败：${errorMessage(error)}`);
  }
  const text = filePath.endsWith(".zstd")
    ? decompressZstdLenient(bytes)
    : bytes.toString("utf8");
  const records: JsonRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as JsonRow);
      }
    } catch {
      /* 只读视角：跳过解析失败的行，保留其余已提交记录 */
    }
  }
  return records;
}

function decompressZstdLenient(bytes: Buffer): string {
  try {
    return zstdDecompressSync(bytes).toString("utf8");
  } catch {
    /* 进入逐帧恢复 */
  }
  const { frames, tornStart } = zstdFrameRanges(bytes);
  let recovered = "";
  for (const [start, end] of frames) {
    try {
      recovered += zstdDecompressSync(bytes.subarray(start, end)).toString("utf8");
    } catch {
      /* 丢弃坏帧 */
    }
  }
  if (tornStart !== null) {
    try {
      const partial = zstdDecompressSync(bytes.subarray(tornStart)).toString("utf8");
      const lastNewline = partial.lastIndexOf("\n");
      if (lastNewline >= 0) recovered += partial.slice(0, lastNewline + 1);
    } catch {
      /* 撕裂帧无法恢复，丢弃 */
    }
  }
  return recovered;
}

/** 官方 `scanZstdFrames` 的结构遍历：不解压，只定位完整分帧与撕裂起点。 */
export function zstdFrameRanges(bytes: Buffer): { frames: Array<[number, number]>; tornStart: number | null } {
  const MAGIC = 0xfd2fb528;
  const frames: Array<[number, number]> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const start = offset;
    if (bytes.length - offset < 4) return { frames, tornStart: start };
    const magic = bytes.readUInt32LE(offset);
    if (magic !== MAGIC) return { frames, tornStart: start };
    offset += 4;
    if (offset === bytes.length) return { frames, tornStart: start };
    const descriptor = bytes[offset] as number;
    offset += 1;
    const contentSizeFlag = descriptor >> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes =
      (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (bytes.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (bytes.length - offset < 3) return { frames, tornStart: start };
      const header =
        (bytes[offset] as number) |
        ((bytes[offset + 1] as number) << 8) |
        ((bytes[offset + 2] as number) << 16);
      offset += 3;
      const lastBlock = (header & 1) !== 0;
      const blockType = (header >> 1) & 3;
      const blockSize = header >>> 3;
      if (blockType === 3) return { frames, tornStart: start };
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (bytes.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (bytes.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push([start, offset]);
  }
  return { frames, tornStart: null };
}

/** 会话根目录存在时，DSH 才被视为可用原生来源（Rust `source_watches`）。 */
export function dshSessionsRootExists(): boolean {
  const root = dshSessionsRoot();
  return root !== null && isDirectory(root);
}

/** 读取物理第一行（header）。zstd 时只解压第一个完整分帧。 */
function readHeaderRecord(filePath: string): JsonRow {
  let bytes: Buffer;
  try {
    bytes = readFileBytes(filePath);
  } catch (error) {
    throw new Error(`读取 DSH 会话 ${filePath} 失败：${errorMessage(error)}`);
  }
  if (filePath.endsWith(".zstd")) {
    const { frames } = zstdFrameRanges(bytes);
    for (const [start, end] of frames) {
      let text: string;
      try {
        text = zstdDecompressSync(bytes.subarray(start, end)).toString("utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as JsonRow;
          }
          throw new Error("DSH 会话头不是 JSON 对象");
        } catch (error) {
          throw new Error(`解析 DSH 会话头失败：${errorMessage(error)}`);
        }
      }
    }
    throw new Error("DSH 会话缺少可解压的 header");
  }
  for (const line of bytes.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JsonRow;
      }
      throw new Error("DSH 会话头不是 JSON 对象");
    } catch (error) {
      throw new Error(`解析 DSH 会话头失败：${errorMessage(error)}`);
    }
  }
  throw new Error("DSH 会话缺少 header");
}

function sessionHeader(filePath: string): DshSessionHeader | null {
  try {
    return parseSessionHeader(readHeaderRecord(filePath));
  } catch {
    return null;
  }
}

/** 按会话 id 查找当前代际文件。 */
export function findDshSessionFile(sessionId: string): string | null {
  for (const filePath of sessionFiles()) {
    const header = sessionHeader(filePath);
    if (header !== null && header.sessionId === sessionId) return filePath;
  }
  return null;
}

// ─── 会话列表 ───────────────────────────────────────────────────────────────

function millisTime(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function hasOpenTurn(records: JsonRow[]): boolean {
  let lastStart = -1;
  let lastEnd = -1;
  records.forEach((value, index) => {
    if (value.type === "turn/start") lastStart = index;
    if (value.type === "turn/end") lastEnd = index;
  });
  return lastStart >= 0 && (lastEnd < 0 || lastStart > lastEnd);
}

function runtimeStatusFromOpenTurn(openTurn: boolean, modifiedMs: number | null): string {
  const recentlyModified = modifiedMs !== null && Date.now() - modifiedMs <= RUNNING_FRESHNESS_MS;
  return openTurn && recentlyModified ? "running" : "idle";
}

function firstUserText(records: JsonRow[]): string | null {
  for (const value of records) {
    if (value.type !== "user/message") continue;
    const data = asRow(value.data);
    if (data === null) continue;
    const text = messageText(data);
    if (text !== null) return Array.from(text).slice(0, 120).join("");
  }
  return null;
}

function nativeSessionTitle(records: JsonRow[]): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const value = records[index] as JsonRow;
    if (value.type !== "session/title") continue;
    const title = pointer(value, "/data/title");
    if (typeof title === "string" && title.trim() !== "") return title.trim();
  }
  return null;
}

function dshSessionRow(filePath: string): { row: JsonRow; openTurn: boolean } | null {
  let session: { header: DshSessionHeader; records: JsonRow[] };
  try {
    session = readDshSession(filePath);
  } catch {
    return null;
  }
  const { header, records } = session;
  const created = millisTime(header.createdAtMillis);
  let modifiedMs: number | null = null;
  try {
    modifiedMs = statSync(filePath).mtimeMs;
  } catch {
    modifiedMs = null;
  }
  const updated = modifiedMs === null ? created : new Date(modifiedMs).toISOString();
  let timeline: AgentSessionTimeline;
  try {
    timeline = readTimelineRecords(records);
  } catch {
    return null;
  }
  const openTurn = hasOpenTurn(records);
  const row: JsonRow = {
    agentType: "deepseek-harness",
    sessionId: header.sessionId,
    runtimeStatus: runtimeStatusFromOpenTurn(openTurn, modifiedMs),
    title: nativeSessionTitle(records) ?? firstUserText(records),
    projectPath: header.cwd,
    parentSessionId: header.parentSessionId,
    clientId: null,
    clientName: "DeepSeek Harness",
    nativeStartedAt: created,
    nativeUpdatedAt: updated,
    activityAt: updated,
    flowletObserved: false,
    startedAt: created,
    updatedAt: updated,
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
    nativeSummary: {
      sourceAvailable: true,
      truncated: false,
      turnCount: timeline.turnCount,
      usage: timeline.usage,
      models: timeline.models,
    } satisfies AgentSessionNativeSummary,
    nativeSyncedAt: null,
    nativeSessionDir: path.dirname(filePath),
    hasFlowletRequests: false,
  };
  return { row, openTurn };
}

interface CachedDshSession {
  size: number;
  modified: number;
  row: JsonRow;
  openTurn: boolean;
}

/** 与 Rust `DSH_SESSION_CACHE` 一致：文件长度/mtime 未变时复用解析结果。 */
const dshSessionCache = new Map<string, CachedDshSession>();

function cachedDshSessionRow(filePath: string): JsonRow | null {
  let size: number;
  let modified: number;
  try {
    const metadata = statSync(filePath);
    size = metadata.size;
    modified = metadata.mtimeMs;
  } catch {
    return null;
  }
  const cached = dshSessionCache.get(filePath);
  if (cached !== undefined && cached.size === size && cached.modified === modified) {
    // 运行态按当前时间重新收敛，避免缓存把「运行中」永久钉住。
    return {
      ...cached.row,
      runtimeStatus: runtimeStatusFromOpenTurn(cached.openTurn, modified),
    };
  }
  const parsed = dshSessionRow(filePath);
  if (parsed === null) {
    dshSessionCache.delete(filePath);
    return null;
  }
  dshSessionCache.set(filePath, {
    size,
    modified,
    row: parsed.row,
    openTurn: parsed.openTurn,
  });
  return parsed.row;
}

/** Rust adapter `list_sessions`：按 activityAt 字符串倒序。 */
export function dshNativeSessions(): JsonRow[] {
  const files = sessionFiles();
  const current = new Set(files);
  for (const cachedPath of dshSessionCache.keys()) {
    if (!current.has(cachedPath)) dshSessionCache.delete(cachedPath);
  }
  const rows: JsonRow[] = [];
  for (const filePath of files) {
    const row = cachedDshSessionRow(filePath);
    if (row !== null) rows.push(row);
  }
  rows.sort((left, right) =>
    String(right.activityAt).localeCompare(String(left.activityAt)),
  );
  return rows;
}

// ─── 时间线 ─────────────────────────────────────────────────────────────────

/** Rust `timeline`：找不到会话文件时返回明确错误。 */
export function readDshTimeline(sessionId: string): AgentSessionTimeline {
  const filePath = findDshSessionFile(sessionId);
  if (filePath === null) throw new Error(`未找到 DeepSeek Harness 会话 ${sessionId}`);
  const { records } = readDshSession(filePath);
  return readTimelineRecords(records);
}

/** Rust `last_interaction`：无会话文件返回 null，否则保留最后一条 user-message 起的事件。 */
export function readDshLastInteraction(sessionId: string): AgentSessionTimeline | null {
  const filePath = findDshSessionFile(sessionId);
  if (filePath === null) return null;
  const { records } = readDshSession(filePath);
  const timeline = readTimelineRecords(records);
  let index = -1;
  for (let cursor = timeline.events.length - 1; cursor >= 0; cursor -= 1) {
    if (timeline.events[cursor]?.kind === "user-message") {
      index = cursor;
      break;
    }
  }
  if (index >= 0) timeline.events = timeline.events.slice(index);
  return timeline;
}

// ─── 时间线投影 ─────────────────────────────────────────────────────────────

function emptyTimeline(): AgentSessionTimeline {
  return {
    sourceAvailable: true,
    truncated: false,
    turnCount: 0,
    usage: null,
    models: [],
    events: [],
  };
}

function isSurfaceType(kind: string): boolean {
  return (
    kind === "system/message" ||
    kind === "user/message" ||
    kind === "assistant/message" ||
    kind === "tool/result"
  );
}

/** Rust `shadowed_event_seqs`：收集被 surfaceOp 覆盖的闭区间序号。 */
function shadowedEventSeqs(events: JsonRow[]): Set<number> {
  const shadowed = new Set<number>();
  for (const value of events) {
    const surfaceOp = asRow(value.surfaceOp);
    if (surfaceOp === null) continue;
    const start = asNumber(surfaceOp.startSeq) ?? asNumber(surfaceOp.start);
    const end = asNumber(surfaceOp.endSeq) ?? asNumber(surfaceOp.end);
    if (start === null || end === null) continue;
    for (let seq = start; seq <= end; seq += 1) shadowed.add(seq);
  }
  return shadowed;
}

/** Rust `surface_survivor_seqs`。 */
function surfaceSurvivorSeqs(events: JsonRow[], shadowed: Set<number>): Set<number> {
  const survivors = new Set<number>();
  for (const value of events) {
    const kind = typeof value.type === "string" ? value.type : "";
    if (!isSurfaceType(kind)) continue;
    const seq = asNumber(value.seq) ?? 0;
    if (shadowed.has(seq) && kind !== "assistant/message") continue;
    survivors.add(seq);
  }
  for (const value of events) {
    if (!Array.isArray(value.sourceEventSeqs)) continue;
    for (const item of value.sourceEventSeqs as unknown[]) {
      if (Array.isArray(item)) {
        const start = asNumber(item[0]);
        const end = asNumber(item[1]);
        if (start === null || end === null) continue;
        for (let seq = start; seq <= end; seq += 1) survivors.add(seq);
      } else {
        const seq = asNumber(item);
        if (seq !== null) survivors.add(seq);
      }
    }
  }
  return survivors;
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

function addUsageToTotal(total: AgentSessionNativeUsage, value: AgentSessionNativeUsage): void {
  total.inputTokens += value.inputTokens;
  total.cachedInputTokens += value.cachedInputTokens;
  total.cacheWriteInputTokens += value.cacheWriteInputTokens;
  total.outputTokens += value.outputTokens;
  total.reasoningTokens += value.reasoningTokens;
  total.totalTokens += value.totalTokens;
}

function emptyTrace(sequence: number, eventType: string): AgentSessionTrace {
  return {
    sequence,
    eventType,
    turn: null,
    step: null,
    callId: null,
    parentCallId: null,
    provider: null,
    requestReason: null,
    input: null,
    output: null,
    systemPrompt: null,
    tools: null,
    sourceKind: null,
    sourceForm: null,
    producer: null,
  };
}

function traceFrom(sequence: number, eventType: string, data: JsonRow): AgentSessionTrace {
  const trace = emptyTrace(sequence, eventType);
  trace.turn = asNumber(data.turn);
  trace.step = asNumber(data.step);
  trace.callId =
    stringOrNull(data.callId) ??
    stringOrNull(pointer(asRow(data.message), "/source/callId")) ??
    stringOrNull(pointer(asRow(data.message), "/content/0/toolCallId"));
  trace.parentCallId = stringOrNull(data.parentCallId);
  trace.requestReason = stringOrNull(data.reason);
  return trace;
}

function pushDshEvent(
  timeline: AgentSessionTimeline,
  seq: number,
  kind: string,
  timestamp: string | null,
  title: string | null,
  content: string | null,
  model: string | null,
  usage: AgentSessionNativeUsage | null,
  durationMs: number | null,
  timeToFirstTokenMs: number | null,
  trace: AgentSessionTrace | null,
  status: string | null,
): void {
  const event: AgentSessionTimelineEvent = {
    id: `dsh-${seq}-${kind}`,
    kind,
    source: "agent-native",
    timestamp,
    title,
    content,
    model,
    status,
    durationMs,
    timeToFirstTokenMs,
    usage,
    trace,
  };
  timeline.events.push(event);
}

function closeInterruptedTools(
  timeline: AgentSessionTimeline,
  openTools: Map<string, [number, number]>,
  toolNames: Map<string, string>,
  toolStartedAt: Map<string, number>,
  atSeq: number,
  atTime: number | null,
  within: [number, number] | null,
): void {
  const pending: string[] = [];
  for (const [callId, coordinate] of openTools) {
    if (within !== null) {
      if (within[0] !== coordinate[0] || coordinate[1] > within[1]) continue;
    }
    pending.push(callId);
  }
  for (const callId of pending) {
    openTools.delete(callId);
    const started = toolStartedAt.get(callId);
    const name = toolNames.get(callId) ?? "Tool";
    const trace = emptyTrace(atSeq, "tool/result");
    trace.callId = callId;
    trace.requestReason = "interrupted";
    trace.output = "Interrupted";
    if (within !== null) {
      if (within[1] !== Number.MAX_SAFE_INTEGER) {
        trace.turn = within[0];
        trace.step = within[1];
      } else {
        trace.turn = within[0];
      }
    }
    pushDshEvent(
      timeline,
      atSeq,
      "tool-result",
      atTime === null ? null : millisTime(atTime),
      name,
      null,
      null,
      null,
      started !== undefined && atTime !== null ? Math.max(0, atTime - started) : null,
      null,
      trace,
      "error",
    );
  }
}

function compactionSummaryText(data: JsonRow): string | null {
  if (!Array.isArray(data.summary)) return null;
  const text = (data.summary as unknown[])
    .map((block) => asRow(block))
    .filter((block): block is JsonRow => block !== null && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : null))
    .filter((item): item is string => item !== null)
    .join("\n");
  return text === "" ? null : text;
}

function jsonText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function toolResultIsError(data: JsonRow): boolean {
  const message = asRow(data.message);
  const fromMessage = message === null ? null : message.isError;
  const firstContent = message === null ? null : pointer(message, "/content/0/isError");
  const flag = fromMessage === true || firstContent === true;
  return flag || data.error !== undefined;
}

function messageBlockText(value: JsonRow, blockType: string): string | null {
  if (!Array.isArray(value.content)) return null;
  const text = (value.content as unknown[])
    .map((block) => asRow(block))
    .filter((block): block is JsonRow => block !== null && block.type === blockType)
    .map((block) => (typeof block.text === "string" ? block.text : null))
    .filter((item): item is string => item !== null)
    .join("\n");
  return text === "" ? null : text;
}

function messageText(value: JsonRow): string | null {
  if (!Array.isArray(value.content)) return null;
  const text = (value.content as unknown[])
    .map((block) => contentBlockText(block))
    .filter((item): item is string => item !== null)
    .join("\n");
  return text === "" ? null : text;
}

function contentBlockText(value: unknown): string | null {
  const block = asRow(value);
  if (block === null) return null;
  if (typeof block.text === "string") return block.text;
  if (block.content === undefined) return null;
  if (typeof block.content === "string") return block.content === "" ? null : block.content;
  if (Array.isArray(block.content)) {
    const text = (block.content as unknown[])
      .map((nested) => contentBlockText(nested))
      .filter((item): item is string => item !== null)
      .join("\n");
    return text === "" ? null : text;
  }
  return null;
}

function nativeUsage(value: unknown): AgentSessionNativeUsage | null {
  const row = asRow(value);
  if (row === null) return null;
  const input = asNumber(row.inputTokens) ?? asNumber(row.input) ?? 0;
  const cached = asNumber(row.cacheReadTokens) ?? asNumber(row.cacheRead) ?? 0;
  const write = asNumber(row.cacheWriteTokens) ?? asNumber(row.cacheWrite) ?? 0;
  const output = asNumber(row.outputTokens) ?? asNumber(row.output) ?? 0;
  const reasoning = asNumber(row.reasoningTokens) ?? asNumber(row.reasoning) ?? 0;
  const total = input + cached + write + output;
  if (!(total > 0 || cached > 0 || write > 0)) return null;
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: write,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: total,
    cost: null,
    costCurrency: null,
    apiEquivalent: null,
  };
}

/** Rust `read_timeline_records`（v0–v4 统一投影）。 */
export function readTimelineRecords(records: JsonRow[]): AgentSessionTimeline {
  const headerRecord = records.find((value) => value.type === "session");
  if (headerRecord !== undefined) parseSessionHeader(headerRecord);
  const events = records.filter(
    (value) => value.type !== "session" && value.type !== "session/end-seed",
  );
  const timeline = emptyTimeline();
  const total = emptyUsage();

  // 预扫描轮次状态。
  const turnStatus = new Map<number, string>();
  const turnEndedAt = new Map<number, number>();
  const turnErrorMessage = new Map<number, string>();
  for (const value of events) {
    if (value.type !== "turn/end") continue;
    const turn = asNumber(pointer(value, "/data/turn"));
    if (turn === null) continue;
    turnEndedAt.set(turn, asNumber(value.time) ?? 0);
    const reasonKind = stringOrNull(pointer(value, "/data/reason/kind"));
    const status =
      reasonKind === "completed"
        ? "completed"
        : reasonKind === "error"
          ? "error"
          : reasonKind === "max-tokens"
            ? "max-tokens"
            : "cancelled";
    turnStatus.set(turn, status);
    if (status === "error") {
      turnErrorMessage.set(
        turn,
        stringOrNull(pointer(value, "/data/reason/error/message")) ?? "Unknown error",
      );
    }
  }

  // 预扫描 steering。
  const steeredMessageIds = new Set<string>();
  {
    let pending: string[] = [];
    for (const value of events) {
      if (value.type !== "agent/inbox/spliced") continue;
      const data = asRow(value.data);
      if (data === null || data.target !== "next-step") continue;
      const start = Math.max(0, asNumber(data.start) ?? 0);
      const removedCount = Math.max(0, asNumber(data.removedCount) ?? 0);
      const inserted = Array.isArray(data.inserted)
        ? (data.inserted as unknown[])
            .map((item) => stringOrNull(pointer(asRow(item), "/id")))
            .filter((item): item is string => item !== null)
        : [];
      if (start > pending.length) continue;
      const removed = pending.slice(start, start + removedCount);
      pending = [
        ...pending.slice(0, start),
        ...inserted,
        ...pending.slice(start + removedCount),
      ];
      for (const identity of inserted) steeredMessageIds.delete(identity);
      if (data.outcome !== "canceled") {
        for (const identity of removed) steeredMessageIds.add(identity);
      }
    }
  }

  const shadowedSeqs = shadowedEventSeqs(events);
  const survivorSeqs = surfaceSurvivorSeqs(events, shadowedSeqs);

  const turnStartedAt = new Map<number, number>();
  const toolNames = new Map<string, string>();
  const toolStartedAt = new Map<string, number>();
  const stepStartedAt = new Map<string, number>();
  const firstTokenAt = new Map<string, number>();
  const openTools = new Map<string, [number, number]>();
  const compactionStartedAt = new Map<string, number>();
  const compactionTurn = new Map<string, number | null>();
  const visibleTurns = new Set<number>();
  let currentTurn: number | null = null;
  let currentStep: number | null = null;
  let lastSystemPrompt: string | null = null;
  let unlocatedAssistantCount = 0;

  const coordinateKey = (turn: number, step: number): string => `${turn}:${step}`;
  const dataOf = (value: JsonRow): JsonRow => asRow(value.data) ?? {};

  events.forEach((value, recordIndex) => {
    const kind = typeof value.type === "string" ? value.type : "";
    const seq = asNumber(value.seq) ?? 0;
    const eventTime = asNumber(value.time);
    const timestamp = eventTime === null ? null : millisTime(eventTime);
    const nextTime = asNumber(events[recordIndex + 1]?.time);
    const fallbackDurationMs =
      eventTime !== null && nextTime !== null ? Math.max(0, nextTime - eventTime) : null;
    const data = dataOf(value);

    if (isSurfaceType(kind) && !survivorSeqs.has(seq)) return;

    if (kind === "turn/start") {
      currentTurn = asNumber(data.turn);
      currentStep = null;
      if (currentTurn !== null) {
        const turn = currentTurn;
        visibleTurns.add(turn);
        turnStartedAt.set(turn, eventTime ?? 0);
        const trace = traceFrom(seq, "turn/start", data);
        trace.turn = turn;
        const errorMessage = turnErrorMessage.get(turn) ?? "";
        const started = turnStartedAt.get(turn);
        const ended = turnEndedAt.get(turn);
        pushDshEvent(
          timeline,
          seq,
          "turn",
          timestamp,
          null,
          errorMessage === "" ? null : errorMessage,
          null,
          null,
          started !== undefined && ended !== undefined ? Math.max(0, ended - started) : null,
          null,
          trace,
          turnStatus.get(turn) ?? "running",
        );
      }
      return;
    }
    if (kind === "step/start") {
      currentTurn = asNumber(data.turn) ?? currentTurn;
      currentStep = asNumber(data.step);
      if (currentTurn !== null && currentStep !== null && eventTime !== null) {
        stepStartedAt.set(coordinateKey(currentTurn, currentStep), eventTime);
      }
      return;
    }
    if (kind === "step/end") {
      closeInterruptedTools(
        timeline,
        openTools,
        toolNames,
        toolStartedAt,
        seq,
        eventTime,
        currentTurn !== null && currentStep !== null ? [currentTurn, currentStep] : null,
      );
      return;
    }
    if (kind === "turn/end") {
      closeInterruptedTools(
        timeline,
        openTools,
        toolNames,
        toolStartedAt,
        seq,
        eventTime,
        currentTurn === null ? null : [currentTurn, Number.MAX_SAFE_INTEGER],
      );
      return;
    }
    if (kind === "assistant/chunk") {
      const chunkType = stringOrNull(pointer(data, "/chunk/type"));
      if (currentTurn !== null && currentStep !== null && eventTime !== null) {
        const key = coordinateKey(currentTurn, currentStep);
        if (
          (chunkType === "text-delta" ||
            chunkType === "reasoning-delta" ||
            chunkType === "tool-call-delta") &&
          !firstTokenAt.has(key)
        ) {
          firstTokenAt.set(key, eventTime);
        }
      }
      return;
    }
    if (kind === "text-chunks" || kind === "reasoning-chunks" || kind === "tool-call-chunks") {
      const turn = asNumber(data.turn) ?? currentTurn;
      const step = asNumber(data.step) ?? currentStep;
      const packedTime = asNumber(value.time0);
      if (turn !== null && step !== null && packedTime !== null) {
        const key = coordinateKey(turn, step);
        if (!firstTokenAt.has(key)) firstTokenAt.set(key, packedTime);
      }
      return;
    }
    if (kind === "compaction/start") {
      const id = stringOrNull(data.compactionId);
      if (id !== null) {
        compactionStartedAt.set(id, eventTime ?? 0);
        compactionTurn.set(id, asNumber(data.turn));
      }
      return;
    }
    if (kind === "compaction/summary") {
      const id = stringOrNull(data.compactionId);
      const text = compactionSummaryText(data);
      const startTime =
        id === null ? eventTime : (compactionStartedAt.get(id) ?? eventTime ?? null);
      const trace = traceFrom(seq, "compaction/summary", data);
      trace.turn = id === null ? null : (compactionTurn.get(id) ?? null);
      trace.input = null;
      trace.output = text;
      trace.provider = stringOrNull(data.provider);
      pushDshEvent(
        timeline,
        seq,
        "compacted",
        timestamp,
        null,
        text,
        stringOrNull(data.model),
        nativeUsage(data.usage),
        startTime !== null && eventTime !== null ? Math.max(0, eventTime - startTime) : null,
        null,
        trace,
        null,
      );
      return;
    }
    if (kind === "compaction/end" || kind === "compaction/prune") return;
    if (kind === "approval/asked") {
      const approvalId = stringOrNull(data.id);
      const trace = traceFrom(seq, "approval/asked", data);
      trace.turn = currentTurn;
      trace.step = currentStep;
      trace.requestReason = approvalId;
      pushDshEvent(
        timeline,
        seq,
        "approval",
        timestamp,
        stringOrNull(data.toolName),
        stringOrNull(data.reason),
        null,
        null,
        null,
        null,
        trace,
        "pending",
      );
      return;
    }
    if (kind === "approval/decided") {
      const outcome = stringOrNull(data.outcome) ?? "";
      const approvalId = stringOrNull(data.id);
      if (approvalId !== null) {
        const existing = timeline.events.find(
          (event) =>
            event.kind === "approval" && event.trace?.requestReason === approvalId,
        );
        if (existing !== undefined) {
          existing.status = outcome;
          return;
        }
      }
      const trace = traceFrom(seq, "approval/decided", data);
      trace.turn = currentTurn;
      trace.step = currentStep;
      trace.requestReason = stringOrNull(data.id);
      pushDshEvent(
        timeline,
        seq,
        "approval",
        timestamp,
        null,
        null,
        null,
        null,
        null,
        null,
        trace,
        outcome,
      );
      return;
    }
    if (kind === "llm/retry") {
      const retry = asNumber(data.retry) ?? 0;
      const maxRetries = asNumber(data.maxRetries);
      const delayMs = Math.round(asNumber(data.delayMs) ?? 0);
      const failure = jsonText(data.failure);
      const trace = traceFrom(seq, "llm/retry", data);
      trace.turn = asNumber(data.turn) ?? currentTurn;
      trace.step = asNumber(data.step) ?? currentStep;
      trace.provider = stringOrNull(data.provider);
      trace.output = failure;
      pushDshEvent(
        timeline,
        seq,
        "model-retry",
        timestamp,
        `retry ${retry}/${maxRetries === null ? "?" : maxRetries} · ${delayMs} ms`,
        failure,
        null,
        null,
        null,
        null,
        trace,
        null,
      );
      return;
    }

    const trace = traceFrom(seq, kind, data);
    trace.turn = trace.turn ?? currentTurn;
    trace.step = trace.step ?? currentStep;
    switch (kind) {
      case "user/message": {
        if (stringOrNull(pointer(data, "/source/plugin")) === "compact") return;
        const content = messageText(data);
        trace.input = content;
        const sourceKind = stringOrNull(pointer(data, "/source/kind"));
        trace.sourceKind = sourceKind;
        trace.sourceForm = stringOrNull(pointer(data, "/source/form"));
        trace.producer =
          stringOrNull(pointer(data, "/source/plugin")) ??
          (Array.isArray(pointer(data, "/source/changes"))
            ? (pointer(data, "/source/changes") as unknown[])
                .map((change) => stringOrNull(pointer(asRow(change), "/path")))
                .filter((item): item is string => item !== null)
                .join(", ")
            : null);
        const messageId = stringOrNull(data.id);
        const isUser = sourceKind === null || sourceKind === "user";
        const isSteering = messageId !== null && steeredMessageIds.has(messageId);
        if (isSteering) trace.requestReason = "steering";
        pushDshEvent(
          timeline,
          seq,
          isUser || isSteering ? "user-message" : "context",
          timestamp,
          !isUser && !isSteering ? "Context" : null,
          content,
          null,
          null,
          0,
          null,
          trace,
          null,
        );
        return;
      }
      case "assistant/message": {
        const message = asRow(data.message) ?? data;
        const model =
          stringOrNull(pointer(message, "/source/model")) ??
          stringOrNull(pointer(message, "/provenance/model")) ??
          stringOrNull(pointer(data, "/provenance/model"));
        if (model !== null && !timeline.models.includes(model)) timeline.models.push(model);
        const usage = nativeUsage(data.usage ?? pointer(message, "/message/usage"));
        if (usage !== null) addUsageToTotal(total, usage);
        const coordinate =
          trace.turn !== null && trace.step !== null
            ? coordinateKey(trace.turn, trace.step)
            : null;
        const stepStarted = coordinate === null ? undefined : stepStartedAt.get(coordinate);
        const durationMs =
          stepStarted !== undefined && eventTime !== null
            ? Math.max(0, eventTime - stepStarted)
            : fallbackDurationMs;
        const firstToken = coordinate === null ? undefined : firstTokenAt.get(coordinate);
        const timeToFirstTokenMs =
          firstToken !== undefined && stepStarted !== undefined
            ? Math.max(0, firstToken - stepStarted)
            : null;
        const reasoning = messageBlockText(message, "reasoning");
        if (reasoning !== null) {
          const reasoningTrace = { ...trace, output: reasoning };
          pushDshEvent(
            timeline,
            seq,
            "reasoning",
            timestamp,
            "Thinking",
            reasoning,
            model,
            null,
            durationMs,
            null,
            reasoningTrace,
            null,
          );
        }
        const content = messageBlockText(message, "text") ?? messageText(message);
        trace.output = content;
        if (trace.turn !== null) visibleTurns.add(trace.turn);
        else unlocatedAssistantCount += 1;
        pushDshEvent(
          timeline,
          seq,
          "assistant-message",
          timestamp,
          null,
          content,
          model,
          usage,
          durationMs,
          timeToFirstTokenMs,
          trace,
          null,
        );
        return;
      }
      case "system/message": {
        const message = asRow(data.message) ?? data;
        const prompt = messageBlockText(message, "text") ?? messageText(message);
        const changed = prompt !== null && lastSystemPrompt !== prompt;
        if (!changed) {
          lastSystemPrompt = prompt;
          return;
        }
        const initialPrompt = lastSystemPrompt === null;
        trace.systemPrompt = prompt;
        lastSystemPrompt = prompt;
        pushDshEvent(
          timeline,
          seq,
          "request",
          timestamp,
          initialPrompt ? "Initial System Prompt" : "System Prompt Updated",
          null,
          null,
          null,
          0,
          null,
          trace,
          null,
        );
        return;
      }
      case "tool/call": {
        const input = typeof data.arguments === "string" ? data.arguments : null;
        trace.input = input;
        const callId = trace.callId;
        const name = stringOrNull(data.name);
        if (callId !== null && name !== null) {
          toolNames.set(callId, name);
          const coordinate: [number, number] =
            trace.turn !== null && trace.step !== null
              ? [trace.turn, trace.step]
              : [0, 0];
          openTools.set(callId, coordinate);
        }
        if (callId !== null && eventTime !== null) toolStartedAt.set(callId, eventTime);
        pushDshEvent(
          timeline,
          seq,
          "tool-call",
          timestamp,
          name,
          input,
          null,
          null,
          null,
          null,
          trace,
          null,
        );
        return;
      }
      case "tool/result": {
        const message = asRow(data.message);
        const output = message === null ? null : messageText(message);
        trace.output = output;
        const status = toolResultIsError(data) ? "error" : null;
        const callId = trace.callId;
        const title =
          (callId === null ? null : toolNames.get(callId) ?? null) ??
          stringOrNull(pointer(message, "/toolName"));
        if (callId !== null) openTools.delete(callId);
        const started = callId === null ? undefined : toolStartedAt.get(callId);
        const durationMs =
          started !== undefined && eventTime !== null
            ? Math.max(0, eventTime - started)
            : fallbackDurationMs;
        pushDshEvent(
          timeline,
          seq,
          "tool-result",
          timestamp,
          title,
          output,
          null,
          null,
          durationMs,
          null,
          trace,
          status,
        );
        return;
      }
      case "tool/code-dispatch-start":
      case "tool/ptc-dispatch-start": {
        const callId = stringOrNull(data.subCallId);
        const parentCallId = stringOrNull(data.parentCallId);
        const input = jsonText(data.arguments);
        if (callId !== null) {
          const name = stringOrNull(data.name);
          if (name !== null) {
            toolNames.set(callId, name);
            const coordinate: [number, number] =
              trace.turn !== null && trace.step !== null
                ? [trace.turn, trace.step]
                : [0, 0];
            openTools.set(callId, coordinate);
          }
          if (eventTime !== null) toolStartedAt.set(callId, eventTime);
        }
        trace.callId = callId;
        trace.parentCallId = parentCallId;
        trace.input = input;
        pushDshEvent(
          timeline,
          seq,
          "tool-call",
          timestamp,
          stringOrNull(data.name),
          input,
          null,
          null,
          null,
          null,
          trace,
          null,
        );
        return;
      }
      case "tool/code-dispatch":
      case "tool/ptc-dispatch": {
        const callId = stringOrNull(data.subCallId);
        const parentCallId = stringOrNull(data.parentCallId);
        const blocks = Array.isArray(data.content) ? (data.content as unknown[]) : [];
        const output = blocks
          .map((block) => contentBlockText(block))
          .filter((item): item is string => item !== null)
          .join("\n");
        const isError = data.isError === true;
        if (callId !== null) openTools.delete(callId);
        const started = callId === null ? undefined : toolStartedAt.get(callId);
        const durationMs =
          started !== undefined && eventTime !== null
            ? Math.max(0, eventTime - started)
            : fallbackDurationMs;
        trace.callId = callId;
        trace.parentCallId = parentCallId;
        trace.output = output === "" ? null : output;
        pushDshEvent(
          timeline,
          seq,
          "tool-result",
          timestamp,
          callId === null ? null : (toolNames.get(callId) ?? null),
          output === "" ? null : output,
          null,
          null,
          durationMs,
          null,
          trace,
          isError ? "error" : null,
        );
        return;
      }
      case "assistant/attempt": {
        const attemptUsage =
          nativeUsage(pointer(data, "/stream/0/chunk/usage")) ??
          (Array.isArray(data.stream)
            ? (data.stream as unknown[])
                .map((item) => nativeUsage(pointer(asRow(item), "/chunk/usage")))
                .find((item): item is AgentSessionNativeUsage => item !== null) ?? null
            : null);
        if (attemptUsage !== null) addUsageToTotal(total, attemptUsage);
        const failure = Array.isArray(data.stream)
          ? (data.stream as unknown[])
              .map((item) => jsonText(pointer(asRow(item), "/chunk/reason/failure")))
              .find((item): item is string => item !== null) ?? null
          : null;
        const interrupted = data.interrupted === true;
        pushDshEvent(
          timeline,
          seq,
          "error",
          timestamp,
          interrupted ? "Attempt cancelled" : "Attempt failed",
          failure,
          null,
          attemptUsage,
          null,
          null,
          trace,
          interrupted ? "cancelled" : "error",
        );
        return;
      }
      case "request/header": {
        const header = asRow(data.header) ?? {};
        trace.provider = stringOrNull(pointer(header, "/config/provider"));
        trace.systemPrompt = stringOrNull(header.system);
        trace.tools = jsonText(header.tools);
        const model = stringOrNull(pointer(header, "/config/model"));
        trace.input = jsonText(header.config);
        const promptChanged =
          trace.systemPrompt !== null && lastSystemPrompt !== trace.systemPrompt;
        if (!promptChanged) return;
        const initialPrompt = lastSystemPrompt === null;
        lastSystemPrompt = trace.systemPrompt;
        pushDshEvent(
          timeline,
          seq,
          "request",
          timestamp,
          initialPrompt ? "Initial System Prompt" : "System Prompt Updated",
          null,
          model,
          null,
          0,
          null,
          trace,
          null,
        );
        return;
      }
      case "request/context":
      case "agent/inbox/spliced":
        return;
      default:
        return;
    }
  });

  // 收尾：仍未闭合的工具调用。
  let lastSeq = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const seq = asNumber((records[index] as JsonRow).seq);
    if (seq !== null) {
      lastSeq = seq;
      break;
    }
  }
  let lastTime: number | null = null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const time = asNumber((records[index] as JsonRow).time);
    if (time !== null) {
      lastTime = time;
      break;
    }
  }
  closeInterruptedTools(timeline, openTools, toolNames, toolStartedAt, lastSeq, lastTime, null);

  timeline.turnCount = visibleTurns.size + unlocatedAssistantCount;
  if (total.totalTokens > 0) timeline.usage = total;
  return timeline;
}

// ─── 小工具 ─────────────────────────────────────────────────────────────────

function asRow(value: unknown): JsonRow | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRow)
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** JSON pointer 子集：支持 `/a/b/0/c`（缺省返回 undefined）。 */
function pointer(value: JsonRow | null, path: string): unknown {
  if (value === null) return undefined;
  let current: unknown = value;
  for (const segment of path.split("/").slice(1)) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else {
      current = (current as JsonRow)[segment];
    }
  }
  return current;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectory(dirPath: string): boolean {
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readDir(dirPath: string): Array<{ name: string; isDirectory(): boolean }> {
  return readdirSync(dirPath, { withFileTypes: true });
}