// Agent 原生数据同步（Rust core/storage_tasks.rs sync_agent_data 的等价实现）。
//
// Owner: desktop-observability。范围：
// - 扫描本机 Claude Code / Codex / Pi / OpenCode / Hermes / DeepSeek Harness 原生会话；
// - 对新增或变化的会话解析原生摘要，写入 `agent_session_snapshots` 与 `agent_usage_events`；
// - 标记源文件已删除的会话（summary.sourceAvailable=false）；
// - 维护 `agent_source_sync_state`；
// - 进程内租约去重（Rust `JobRuntime::try_acquire_definition(AGENT_DATA_SYNC)`）。
//
// 与 Rust 的差异（交付汇报中标注）：
// - 未实现增量 checkpoint：变化会话全量解析（结果一致，长会话更慢）。
// - DeepSeek Harness 不写 agent_usage_events（Rust DSH adapter 未实现
//   timeline_with_usage_events / incremental_source，原生账本由会话摘要承担）。
import { randomUUID } from "node:crypto";
import type { JsonRow } from "../../types.ts";
import type { SqliteStorage } from "../../storage/index.ts";
import { sessionTimeMillis } from "../../storage/agent-native.ts";
import {
  addJobEvent,
  createJob,
  finishJob,
  isJobCancelRequested,
  listAgentSourceSyncStates,
  updateJobProgress,
  type AgentSourceSyncState,
} from "../../storage/background-jobs.ts";
import {
  listAgentSnapshotSummaries,
  markAgentSnapshotSourceDeleted,
  saveAgentSnapshot,
  saveAgentUsageEvents,
  type AgentUsageEventRow,
} from "../../storage/agent-native.ts";
import {
  getNativeAgentSessionSummary,
  getNativeAgentSessionTimeline,
} from "./timeline.ts";
import {
  availableNativeAgentTypes,
  listNativeAgentSessions,
  sessionKey,
} from "./native.ts";

const AGENT_SUMMARY_PARSER_VERSION = 4;
const MAX_AUTO_SYNC_SESSIONS = 12;
const MAX_MANUAL_SYNC_SESSIONS = 20;
const JOB_TYPE = "agent-data-sync";
const JOB_TITLE = "Agent 数据同步";

/** Rust `AgentDataSyncResult`（camelCase）。 */
export interface AgentDataSyncResult {
  started: boolean;
  jobId: string | null;
  scanned: number;
  changed: number;
  failed: number;
  message: string;
}

// ─── 进程内租约（Rust JobRuntime::try_acquire_definition） ───────────────────

let agentDataSyncLeaseHeld = false;

export function tryAcquireAgentDataSync(): boolean {
  if (agentDataSyncLeaseHeld) return false;
  agentDataSyncLeaseHeld = true;
  return true;
}

export function releaseAgentDataSync(): void {
  agentDataSyncLeaseHeld = false;
}

export function isAgentDataSyncRunning(): boolean {
  return agentDataSyncLeaseHeld;
}

// ─── 同步计划 ───────────────────────────────────────────────────────────────

function fingerprintFor(row: JsonRow): string {
  return [
    row.nativeUpdatedAt ?? "",
    row.activityAt,
    row.title ?? "",
    row.projectPath ?? "",
  ].join("|");
}

interface SyncPlan {
  rows: JsonRow[];
  changed: JsonRow[];
  deleted: Array<{ agentType: string; sessionId: string }>;
  deferred: number;
}

function planSync(db: SqliteStorage, force: boolean): SyncPlan {
  const rows = listNativeAgentSessions();
  const available = availableNativeAgentTypes();
  const currentKeys = new Set(rows.map(sessionKey));
  const deleted: Array<{ agentType: string; sessionId: string }> = [];
  for (const snapshot of listAgentSnapshotSummariesFromStorage(db)) {
    const sourceAvailable = snapshot.summary === null ? true : snapshot.summary.sourceAvailable;
    if (
      available.has(snapshot.agentType) &&
      !currentKeys.has(`${snapshot.agentType}\0${snapshot.sessionId}`) &&
      sourceAvailable
    ) {
      deleted.push({ agentType: snapshot.agentType, sessionId: snapshot.sessionId });
    }
  }
  const raw = db.database();
  const changed = rows.filter((row) => {
    const meta = raw
      .prepare(
        `SELECT fingerprint, parser_version FROM agent_session_snapshots
         WHERE agent_type=?1 AND session_id=?2`,
      )
      .get(row.agentType, row.sessionId) as JsonRow | undefined;
    if (meta === undefined) return true;
    if (force) return true;
    return (
      String(meta.fingerprint ?? "") !== fingerprintFor(row) ||
      Number(meta.parser_version ?? 0) !== AGENT_SUMMARY_PARSER_VERSION
    );
  });
  changed.sort(
    (left, right) =>
      sessionTimeMillis(String(right.activityAt)) - sessionTimeMillis(String(left.activityAt)),
  );
  const batchLimit = force ? MAX_MANUAL_SYNC_SESSIONS : MAX_AUTO_SYNC_SESSIONS;
  const deferred = Math.max(0, changed.length - batchLimit);
  return { rows, changed: changed.slice(0, batchLimit), deleted, deferred };
}

function listAgentSnapshotSummariesFromStorage(
  db: SqliteStorage,
): ReturnType<typeof listAgentSnapshotSummaries> {
  return listAgentSnapshotSummaries(db.database());
}

// ─── 来源状态 ───────────────────────────────────────────────────────────────

function updateSourceStates(
  db: SqliteStorage,
  rows: JsonRow[],
  changed: JsonRow[],
  failures: Array<{ agentType: string; error: string }>,
): void {
  const agentTypes = new Set<string>(availableNativeAgentTypes());
  for (const row of rows) agentTypes.add(String(row.agentType));
  for (const agentType of [...agentTypes].sort()) {
    const scanned = rows.filter((row) => row.agentType === agentType).length;
    const changedCount = changed.filter((row) => row.agentType === agentType).length;
    const errors = failures
      .filter((item) => item.agentType === agentType)
      .map((item) => item.error);
    const status = errors.length === 0 ? "succeeded" : "warning";
    const lastError = errors.length === 0 ? null : errors.join("；");
    db.database().prepare(
      `INSERT INTO agent_source_sync_state
         (agent_type, last_checked_at, last_synced_at, status, last_error,
          scanned_count, changed_count, failed_count, updated_at)
       VALUES (?1, datetime('now'),
               CASE WHEN (?3 - ?6) > 0 THEN datetime('now') ELSE NULL END,
               ?2, ?4, ?5, ?3, ?6, datetime('now'))
       ON CONFLICT(agent_type) DO UPDATE SET
         last_checked_at=excluded.last_checked_at,
         last_synced_at=COALESCE(excluded.last_synced_at, agent_source_sync_state.last_synced_at),
         status=excluded.status,
         last_error=excluded.last_error,
         scanned_count=excluded.scanned_count,
         changed_count=excluded.changed_count,
         failed_count=excluded.failed_count,
         updated_at=excluded.updated_at`,
    ).run(agentType, status, changedCount, lastError, scanned, errors.length);
  }
}

// ─── 原生摘要 / 用量事件 ────────────────────────────────────────────────────

function eventsFromTimeline(agentType: string, sessionId: string): AgentUsageEventRow[] {
  // Rust DSH 适配器没有实现 timeline_with_usage_events，因此不产生消息级账本行。
  if (agentType === "deepseek-harness") return [];
  const timeline = getNativeAgentSessionTimeline(agentType, sessionId);
  const events: AgentUsageEventRow[] = [];
  for (const event of timeline.events) {
    if (event.usage === null || event.timestamp === null) continue;
    const parsed = Date.parse(event.timestamp);
    if (Number.isNaN(parsed)) continue;
    if (event.id === "") continue;
    const usage = event.usage;
    events.push({
      eventId: event.id,
      eventTime: new Date(parsed).toISOString(),
      model: event.model,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
    });
  }
  return events;
}

// ─── 同步 ───────────────────────────────────────────────────────────────────

/**
 * Rust `Storage::sync_agent_data_with_job`。调用方必须已经持有租约
 * （`sync_agent_data` 命令负责 acquire/release）。
 */
export function syncAgentData(
  storage: SqliteStorage,
  options: { force: boolean; triggerSource: string; jobId?: string },
): AgentDataSyncResult {
  const jobId = options.jobId ?? randomUUID();
  return storage.withDatabase((db) => {
    const plan = planSync(storage, options.force);
    updateSourceStates(storage, plan.rows, plan.changed, []);
    if (plan.changed.length === 0 && plan.deleted.length === 0) {
      return {
        started: false,
        jobId: null,
        scanned: plan.rows.length,
        changed: 0,
        failed: 0,
        message: "没有发现需要整理的会话变化",
      };
    }
    const total = plan.changed.length + plan.deleted.length;
    createJob(db, {
      id: jobId,
      jobType: JOB_TYPE,
      title: JOB_TITLE,
      stage: "扫描并整理会话",
      trigger: options.triggerSource,
      total,
      firstEventMessage: `发现 ${total} 个需要整理的会话`,
      eventId: randomUUID(),
    });

    const failures: Array<{ agentType: string; error: string }> = [];
    let processed = 0;
    for (const row of plan.changed) {
      if (isJobCancelRequested(db, jobId)) {
        finishJob(db, {
          jobId,
          status: "cancelled",
          summaryJson: JSON.stringify({
            scanned: plan.rows.length,
            processed,
            deferred: plan.deferred + plan.changed.length - processed,
            durationMs: 0,
          }),
          doneMessage: "Agent 数据同步已取消",
          eventId: randomUUID(),
        });
        return {
          started: true,
          jobId,
          scanned: plan.rows.length,
          changed: processed,
          failed: failures.length,
          message: "Agent 数据同步已取消",
        };
      }
      const agentType = String(row.agentType);
      const sessionId = String(row.sessionId);
      try {
        const summary = getNativeAgentSessionSummary(agentType, sessionId);
        saveAgentSnapshot(db, {
          agentType,
          sessionId,
          fingerprint: fingerprintFor(row),
          summaryJson: JSON.stringify(summary),
          sessionJson: JSON.stringify(row),
          sourceOffset: 0,
          parserVersion: AGENT_SUMMARY_PARSER_VERSION,
          usageIdsJson: "[]",
          cursorGuard: "",
          syncedAt: new Date().toISOString(),
        });
        const usageEvents = eventsFromTimeline(agentType, sessionId);
        if (usageEvents.length > 0) {
          saveAgentUsageEvents(db, agentType, sessionId, usageEvents, false);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ agentType, error: message });
        addJobEvent(db, {
          eventId: randomUUID(),
          jobId,
          level: "warning",
          stage: "解析会话",
          message: `${sessionId} 整理失败：${message}`,
        });
      }
      processed += 1;
      updateJobProgress(db, jobId, processed, total);
    }
    for (const item of plan.deleted) {
      if (isJobCancelRequested(db, jobId)) {
        finishJob(db, {
          jobId,
          status: "cancelled",
          summaryJson: JSON.stringify({
            scanned: plan.rows.length,
            processed,
            deferred: plan.deferred + plan.deleted.length - (processed - plan.changed.length),
            durationMs: 0,
          }),
          doneMessage: "Agent 数据同步已取消",
          eventId: randomUUID(),
        });
        return {
          started: true,
          jobId,
          scanned: plan.rows.length,
          changed: plan.changed.length,
          failed: failures.length,
          message: "Agent 数据同步已取消",
        };
      }
      markAgentSnapshotSourceDeleted(db, item.agentType, item.sessionId);
      processed += 1;
      updateJobProgress(db, jobId, processed, total);
    }
    updateSourceStates(storage, plan.rows, plan.changed, failures);
    const status = failures.length === 0 ? "succeeded" : "succeeded_with_warnings";
    finishJob(db, {
      jobId,
      status,
      summaryJson: JSON.stringify({
        scanned: plan.rows.length,
        changed: plan.changed.length,
        deleted: plan.deleted.length,
        failed: failures.length,
        deferred: plan.deferred,
      }),
      doneMessage: "Agent 数据同步完成",
      eventId: randomUUID(),
    });
    return {
      started: true,
      jobId,
      scanned: plan.rows.length,
      changed: plan.changed.length,
      failed: failures.length,
      message:
        failures.length === 0
          ? `已整理 ${plan.changed.length} 个会话，标记 ${plan.deleted.length} 个源文件已删除`
          : `已整理 ${plan.changed.length} 个会话，其中 ${failures.length} 个失败`,
    };
  });
}

/** Rust `get_agent_sync_status`：进程内运行态 + 各来源状态。 */
export function agentSyncStatus(storage: SqliteStorage): {
  running: boolean;
  sources: AgentSourceSyncState[];
} {
  return storage.withDatabase((db) => ({
    running: isAgentDataSyncRunning(),
    sources: listAgentSourceSyncStates(db),
  }));
}

export { availableNativeAgentTypes };