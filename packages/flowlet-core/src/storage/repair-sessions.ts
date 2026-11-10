// 历史日志 Agent 会话 / 客户端归属修复。
//
// 权威实现：`src-tauri/src/core/storage_usage.rs::repair_agent_sessions`
// （Tauri command 名 `repair_agent_sessions`，前端「设置 → 数据维护 → 数据完整性检查」）。
//
// 语义要点（逐条对照 Rust）：
// - 按 `request_id` 分组取 `MAX(req_headers_json)` 与现有 `MAX(client_id/client_name)`；
// - Agent 三列（agent_type / agent_session_id / parent_agent_session_id）从 header JSON 用
//   与实时代理相同的 Identity Adapter 还原，命中即按 request_id 全量更新；
// - 客户端两列只在 `client_id` 或 `client_name` 为空时按最新 `ua_rules` 重识别，
//   UPDATE 再以 `client_id IS NULL` 兜底，避免覆盖用户已有归属；
// - 查询在事务外完成，批量更新放单个事务（历史数据量大时逐行自动提交会造成大量 fsync，
//   这是前端「点修复后整个应用卡顿」的主因）。
import type { DatabaseSync } from "node:sqlite";
import {
  extractAgentSession,
  headerMapFromJson,
  identifyClientFromJson,
  type UaClientRule,
} from "../proxy/identity.ts";

/** Rust `AgentSessionRepairResult`（`#[serde(rename_all = "camelCase")]`）。 */
export interface AgentSessionRepairResult {
  scannedRequests: number;
  repairedRequests: number;
  repairedLogs: number;
  skippedRequests: number;
  repairedClients: number;
}

/** Rust `repair_time_clause`：窗口过滤 SQL 片段（`today` 按本地自然日，其余按 UTC 相对时长）。 */
function repairTimeClause(column: string, timeRange: string): string {
  switch (timeRange) {
    case "1h":
      return `datetime(${column}) >= datetime('now', '-1 hour')`;
    case "6h":
      return `datetime(${column}) >= datetime('now', '-6 hours')`;
    case "today":
      return `datetime(${column}, 'localtime') >= datetime('now', 'localtime', 'start of day')`;
    case "7d":
      return `datetime(${column}) >= datetime('now', '-7 days')`;
    default:
      return "1 = 1";
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Rust `repair_agent_sessions`：从捕获的请求 headers 修复历史 Claude Code / OpenCode /
 * Codex / DSH 等 Agent 会话归因，并补全为空的客户端归属。返回 camelCase 计数。
 */
export function repairAgentSessions(
  db: DatabaseSync,
  timeRange: string,
  uaRules: UaClientRule[],
): AgentSessionRepairResult {
  const rows = db
    .prepare(
      `SELECT request_id, MAX(req_headers_json) AS headers_json,
              MAX(client_id) AS client_id, MAX(client_name) AS client_name
       FROM request_logs
       WHERE req_headers_json IS NOT NULL
         AND ${repairTimeClause("created_at", timeRange)}
       GROUP BY request_id`,
    )
    .all() as Array<Record<string, unknown>>;

  const scannedRequests = rows.length;
  let repairedRequests = 0;
  let repairedLogs = 0;
  let repairedClients = 0;

  const updateSession = db.prepare(
    `UPDATE request_logs
     SET agent_type = ?2,
         agent_session_id = ?3,
         parent_agent_session_id = ?4
     WHERE request_id = ?1`,
  );
  const updateClient = db.prepare(
    `UPDATE request_logs
     SET client_id = ?2, client_name = ?3
     WHERE request_id = ?1 AND client_id IS NULL`,
  );

  db.exec("BEGIN");
  try {
    for (const raw of rows) {
      const requestId = String(raw.request_id);
      const headersJson = String(raw.headers_json ?? "");
      const existingClientId = nullableString(raw.client_id);
      const existingClientName = nullableString(raw.client_name);

      // 会话归因修复：从 headers JSON 识别 Agent 会话（与实时代理同一套 Identity Adapter）。
      const headers = headerMapFromJson(headersJson);
      const identity = headers === null ? null : extractAgentSession(headers);

      // 客户端归属修复：仅对 client_id 或 client_name 为空的记录重识别。
      const newClient =
        existingClientId === null || existingClientName === null
          ? identifyClientFromJson(headersJson, uaRules)
          : null;

      if (identity === null && newClient === null) continue;

      if (identity !== null) {
        const result = updateSession.run(
          requestId,
          identity.agent_type,
          identity.session_id,
          identity.parent_session_id,
        );
        repairedLogs += Number(result.changes ?? 0);
      }

      if (newClient !== null) {
        updateClient.run(requestId, newClient.id, newClient.name);
        // Rust 在识别出归属时就计数，与实际 UPDATE 命中行数无关。
        repairedClients += 1;
      }

      repairedRequests += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    scannedRequests,
    repairedRequests,
    repairedLogs,
    skippedRequests: Math.max(0, scannedRequests - repairedRequests),
    repairedClients,
  };
}