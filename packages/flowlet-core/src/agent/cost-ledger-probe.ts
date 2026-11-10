// 成本账本数据源探测（Rust core/cost_ledger_source_probe.rs 的 TS 等价实现）。
//
// Owner: desktop-observability。返回结构与前端 `src/domains/cost-ledger/types.ts`
// 逐字段一致（camelCase）。
//
// 数据源：
// - Flowlet 网关：request_logs + usage_records（真实 SQL 采样，最多 5 条）；
// - 原生会话：Codex / Claude Code / OpenCode 的已同步快照
//   （`agent_session_snapshots`）。Rust 会实时解析本机原生会话并采样逐轮用量；
//   这里只读后台同步写入的快照，因此「逐轮用量」只有会话级 rollup，且未同步的会话
//   不会出现——这个差异在交付汇报中标注，不伪造逐轮观测。
import type { JsonRow } from "../types.ts";
import type { SqliteStorage } from "../storage/index.ts";
import {
  costLedgerGatewayProbeSnapshot,
  listAgentSnapshotDetails,
  type AgentSessionNativeSummary,
} from "../storage/agent-native.ts";

const MAX_SAMPLE_SESSIONS = 3;
const MAX_SAMPLE_USAGE = 5;

export interface SourceIdentity {
  id: string;
  sourceType: string;
  adapter: string;
  displayName: string;
}

export interface Evidence {
  sourceKind: string;
  locator: string;
  rawRecordId: string | null;
  schemaFingerprint: string;
  observedAt: string;
}

export interface CostLedgerSessionObservation {
  source: SourceIdentity;
  agentType: string;
  sessionId: string;
  parentSessionId: string | null;
  projectPath: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  evidence: Evidence;
}

export interface CostLedgerTokenObservation {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  uncachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}

export interface CostLedgerUsageObservation {
  source: SourceIdentity;
  sourceEventId: string;
  granularity: string;
  isRollup: boolean;
  agentType: string | null;
  sessionId: string | null;
  parentSessionId: string | null;
  requestId: string | null;
  clientId: string | null;
  accountId: string | null;
  projectPath: string | null;
  repository: string | null;
  gitBranch: string | null;
  model: string | null;
  occurredAt: string | null;
  tokens: CostLedgerTokenObservation;
  cost: number | null;
  costCurrency: string | null;
  credits: number | null;
  operationCount: number | null;
  status: string | null;
  confidence: string;
  evidence: Evidence;
}

export interface CostLedgerSourceProbeReport {
  source: SourceIdentity;
  available: boolean;
  authorized: boolean;
  requiresAuthorization: boolean;
  recordCount: number;
  timeRangeStart: string | null;
  timeRangeEnd: string | null;
  granularities: string[];
  capabilities: string[];
  missingFields: string[];
  dedupeKey: string;
  incrementalCursor: string;
  incrementalSyncSupported: boolean;
  schemaFingerprint: string;
  confidence: string;
  sampledSessionCount: number;
  sampledUsageCount: number;
  errors: string[];
}

export interface CostLedgerSourceProbeResult {
  generatedAt: string;
  reports: CostLedgerSourceProbeReport[];
  sessions: CostLedgerSessionObservation[];
  usage: CostLedgerUsageObservation[];
  entitlements: unknown[];
  balances: unknown[];
}

type NativeSourceKind = "codex" | "claude-code" | "opencode";

function nativeIdentity(kind: NativeSourceKind): SourceIdentity {
  switch (kind) {
    case "codex":
      return {
        id: "codex-local",
        sourceType: "agent_native",
        adapter: "codex-local-jsonl",
        displayName: "Codex 本地会话",
      };
    case "claude-code":
      return {
        id: "claude-code-local",
        sourceType: "agent_native",
        adapter: "claude-code-jsonl",
        displayName: "Claude Code 本地会话",
      };
    case "opencode":
      return {
        id: "opencode-local",
        sourceType: "agent_native",
        adapter: "opencode-sqlite",
        displayName: "OpenCode 本地会话",
      };
  }
}

function nativeSchema(kind: NativeSourceKind): string {
  switch (kind) {
    case "codex":
      return "codex-jsonl:session_meta,response_item,token_count:v1";
    case "claude-code":
      return "claude-jsonl:user,assistant,usage:v1";
    case "opencode":
      return "opencode-sqlite:session,message,part:v1";
  }
}

function nativeDedupeKey(kind: NativeSourceKind): string {
  switch (kind) {
    case "codex":
      return "agent_type + session_id + response_item.id/turn_id";
    case "claude-code":
      return "session_id + message.id/uuid";
    case "opencode":
      return "session_id + message.id/part.id";
  }
}

function nativeCursor(kind: NativeSourceKind): string {
  switch (kind) {
    case "codex":
      return "rollout path + modified time + byte offset";
    case "claude-code":
      return "transcript path + modified time + byte offset";
    case "opencode":
      return "session.time_updated + message/part id";
  }
}

function nativeCapabilities(kind: NativeSourceKind): string[] {
  const values = ["session", "project", "model", "tokens"];
  if (kind === "opencode") values.push("native_cost");
  return values;
}

function nativeMissingFields(kind: NativeSourceKind): string[] {
  const values = ["request_id", "account_id", "repository", "git_branch", "price_version"];
  if (kind !== "opencode") values.push("native_cost", "cost_currency");
  return values;
}

function matchesNativeKind(kind: NativeSourceKind, agentType: string): boolean {
  switch (kind) {
    case "codex":
      return agentType === "codex-desktop" || agentType === "codex-cli";
    case "claude-code":
      return agentType === "claude-code";
    case "opencode":
      return agentType === "opencode";
  }
}

function evidence(
  sourceKind: string,
  locator: string,
  rawRecordId: string | null,
  schema: string,
  observedAt: string,
): Evidence {
  return {
    sourceKind,
    locator,
    rawRecordId,
    schemaFingerprint: schema,
    observedAt,
  };
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function sessionField(session: JsonRow | null, field: string): string | null {
  if (session === null) return null;
  return nullableText(session[field]);
}

function nativeUsageObservation(
  source: SourceIdentity,
  agentType: string,
  sessionId: string,
  parentSessionId: string | null,
  projectPath: string | null,
  eventId: string,
  granularity: string,
  occurredAt: string | null,
  model: string | null,
  usage: NonNullable<AgentSessionNativeSummary["usage"]>,
  schema: string,
  observedAt: string,
): CostLedgerUsageObservation {
  return {
    source,
    sourceEventId: eventId,
    granularity,
    isRollup: granularity === "session",
    agentType,
    sessionId,
    parentSessionId,
    requestId: null,
    clientId: null,
    accountId: null,
    projectPath,
    repository: null,
    gitBranch: null,
    model,
    occurredAt,
    tokens: {
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      uncachedInputTokens: null,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
    },
    cost: usage.cost,
    costCurrency: usage.costCurrency,
    credits: null,
    operationCount: null,
    status: null,
    confidence: "high",
    evidence: evidence(
      "native_record",
      `${agentType}:${sessionId}:${eventId}`,
      eventId,
      schema,
      observedAt,
    ),
  };
}

/** Rust `probe_cost_ledger_sources`。 */
export function probeCostLedgerSources(storage: SqliteStorage): CostLedgerSourceProbeResult {
  const generatedAt = new Date().toISOString();
  const reports: CostLedgerSourceProbeReport[] = [];
  const sessions: CostLedgerSessionObservation[] = [];
  const usage: CostLedgerUsageObservation[] = [];
  const snapshots = storage.withDatabase((db) => listAgentSnapshotDetails(db));

  // 1) Flowlet 网关
  const gatewaySource: SourceIdentity = {
    id: "flowlet-gateway",
    sourceType: "gateway",
    adapter: "flowlet-sqlite",
    displayName: "Flowlet 代理请求",
  };
  const gatewaySchema = "flowlet-sqlite:request_logs+usage_records:v1";
  try {
    const snapshot = storage.withDatabase((db) => costLedgerGatewayProbeSnapshot(db, MAX_SAMPLE_USAGE));
    const usageStart = usage.length;
    for (const sample of snapshot.samples) {
      const status =
        sample.errorMessage !== null
          ? "error"
          : sample.status === null
            ? null
            : sample.status >= 200 && sample.status < 400
              ? "success"
              : "error";
      usage.push({
        source: gatewaySource,
        sourceEventId: sample.requestId,
        granularity: "request",
        isRollup: false,
        agentType: sample.agentType,
        sessionId: sample.sessionId,
        parentSessionId: sample.parentSessionId,
        requestId: sample.requestId,
        clientId: sample.clientId,
        accountId: sample.accountId,
        projectPath: null,
        repository: null,
        gitBranch: null,
        model: sample.model,
        occurredAt: sample.occurredAt,
        tokens: {
          inputTokens: sample.inputTokens,
          cachedInputTokens: sample.cachedInputTokens,
          cacheWriteInputTokens: null,
          uncachedInputTokens: sample.uncachedInputTokens,
          outputTokens: sample.outputTokens,
          reasoningTokens: null,
          totalTokens: sample.totalTokens,
        },
        cost: sample.estimatedCost,
        costCurrency: null,
        credits: null,
        operationCount: 1,
        status,
        confidence: "high",
        evidence: evidence(
          "sqlite_row",
          `request_logs:${sample.requestId}`,
          sample.requestId,
          gatewaySchema,
          generatedAt,
        ),
      });
    }
    reports.push({
      source: gatewaySource,
      available: true,
      authorized: true,
      requiresAuthorization: false,
      recordCount: snapshot.recordCount,
      timeRangeStart: snapshot.timeRangeStart,
      timeRangeEnd: snapshot.timeRangeEnd,
      granularities: ["request"],
      capabilities: [
        "request",
        "session",
        "account",
        "client",
        "model",
        "tokens",
        "status",
        "estimated_cost",
      ],
      missingFields: [
        "repository",
        "git_branch",
        "reasoning_tokens",
        "cache_write_tokens",
        "cost_currency",
        "price_version",
      ],
      dedupeKey: "request_id",
      incrementalCursor: "created_at + request_id",
      incrementalSyncSupported: true,
      schemaFingerprint: gatewaySchema,
      confidence: "high",
      sampledSessionCount: 0,
      sampledUsageCount: usage.length - usageStart,
      errors: [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reports.push({
      source: gatewaySource,
      available: false,
      authorized: true,
      requiresAuthorization: false,
      recordCount: 0,
      timeRangeStart: null,
      timeRangeEnd: null,
      granularities: [],
      capabilities: [],
      missingFields: [],
      dedupeKey: "request_id",
      incrementalCursor: "created_at + request_id",
      incrementalSyncSupported: true,
      schemaFingerprint: gatewaySchema,
      confidence: "unknown",
      sampledSessionCount: 0,
      sampledUsageCount: 0,
      errors: [message],
    });
  }

  // 2) 原生会话（快照）
  for (const kind of ["codex", "claude-code", "opencode"] as const) {
    const source = nativeIdentity(kind);
    const schema = nativeSchema(kind);
    const rows = snapshots
      .filter((item) => matchesNativeKind(kind, item.agentType))
      .sort((left, right) => {
        const leftActivity = sessionField(left.session, "activityAt") ?? left.syncedAt;
        const rightActivity = sessionField(right.session, "activityAt") ?? right.syncedAt;
        return rightActivity.localeCompare(leftActivity);
      });
    const activityTimes = rows
      .map((item) => sessionField(item.session, "activityAt") ?? item.syncedAt)
      .filter((value) => value !== "");
    const timeRangeStart =
      activityTimes.length === 0 ? null : activityTimes.reduce((min, value) => (value < min ? value : min));
    const timeRangeEnd =
      activityTimes.length === 0 ? null : activityTimes.reduce((max, value) => (value > max ? value : max));
    const sessionStart = sessions.length;
    const usageStart = usage.length;
    const errors: string[] = [];
    for (const item of rows.slice(0, MAX_SAMPLE_SESSIONS)) {
      const session = item.session;
      sessions.push({
        source,
        agentType: item.agentType,
        sessionId: item.sessionId,
        parentSessionId: sessionField(session, "parentSessionId"),
        projectPath: sessionField(session, "projectPath"),
        startedAt: sessionField(session, "nativeStartedAt"),
        updatedAt: sessionField(session, "nativeUpdatedAt"),
        evidence: evidence(
          "native_session",
          `${item.agentType}:${item.sessionId}`,
          item.sessionId,
          schema,
          generatedAt,
        ),
      });
      const summary = item.summary;
      if (summary === null || !summary.sourceAvailable || summary.usage === null) continue;
      usage.push(
        nativeUsageObservation(
          source,
          item.agentType,
          item.sessionId,
          sessionField(session, "parentSessionId"),
          sessionField(session, "projectPath"),
          `summary:${item.agentType}:${item.sessionId}`,
          "session",
          sessionField(session, "nativeUpdatedAt"),
          summary.models.length > 0 ? (summary.models[0] as string) : null,
          summary.usage,
          schema,
          generatedAt,
        ),
      );
      if (usage.length - usageStart >= MAX_SAMPLE_USAGE) break;
    }
    reports.push({
      source,
      available: rows.length > 0,
      authorized: true,
      requiresAuthorization: true,
      recordCount: rows.length,
      timeRangeStart,
      timeRangeEnd,
      granularities: ["session", "turn"],
      capabilities: nativeCapabilities(kind),
      missingFields: nativeMissingFields(kind),
      dedupeKey: nativeDedupeKey(kind),
      incrementalCursor: nativeCursor(kind),
      incrementalSyncSupported: true,
      schemaFingerprint: schema,
      confidence: "high",
      sampledSessionCount: sessions.length - sessionStart,
      sampledUsageCount: usage.length - usageStart,
      errors,
    });
  }

  return {
    generatedAt,
    reports,
    sessions,
    usage,
    entitlements: [],
    balances: [],
  };
}