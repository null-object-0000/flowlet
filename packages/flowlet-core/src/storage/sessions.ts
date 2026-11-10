// Web Host 的「已观测 Agent 会话」目录（Rust storage_usage.rs list_observed_*）。
//
// 数据来源只有 request_logs 的聚合：Web/Docker 不读取服务器本机 Agent 原生会话文件。
// 字段命名：Rust AgentSessionRow / AgentSessionsPageResult 均 camelCase。
import type { DatabaseSync } from "node:sqlite";
import type { JsonRow } from "../types.ts";

function reqNum(value: unknown): number {
  return Number(value ?? 0);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

interface SessionKey {
  agentType: string;
  sessionId: string;
}

function sessionKey(row: JsonRow): string {
  return `${row.agentType}\0${row.sessionId}`;
}

/** Rust agent_session_metadata::session_time_millis。 */
export function sessionTimeMillis(value: string): number {
  const rfc = Date.parse(value);
  if (!Number.isNaN(rfc)) return rfc;
  const naive = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(naive) ? 0 : naive;
}

function sortByActivity(rows: JsonRow[]): JsonRow[] {
  return rows.sort((left, right) => {
    const byActivity = sessionTimeMillis(String(right.activityAt)) - sessionTimeMillis(String(left.activityAt));
    if (byActivity !== 0) return byActivity;
    return String(right.sessionId).localeCompare(String(left.sessionId));
  });
}

function sessionMatchesSearch(row: JsonRow, search: string): boolean {
  const sessionId = String(row.sessionId).toLowerCase();
  const title = row.title ? String(row.title).toLowerCase() : "";
  const projectPath = row.projectPath ? String(row.projectPath).toLowerCase() : "";
  return sessionId.includes(search) || title.includes(search) || projectPath.includes(search);
}

function sessionMatchesProjectPath(row: JsonRow, projectPath: string): boolean {
  if (!projectPath) return true;
  if (!row.projectPath) return false;
  const normalize = (value: string): string =>
    value.trim().replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const project = normalize(projectPath);
  const session = normalize(String(row.projectPath));
  return session === project || session.startsWith(`${project}/`);
}

/** 命中搜索/项目路径的会话向上追溯到根会话（与 Rust matching_root_session_keys 一致）。 */
function matchingRootKeys(
  catalog: JsonRow[],
  matches: (row: JsonRow) => boolean,
): Set<string> {
  const parentByKey = new Map<string, SessionKey>();
  for (const row of catalog) {
    if (!row.parentSessionId) continue;
    parentByKey.set(sessionKey(row), {
      agentType: String(row.agentType),
      sessionId: String(row.parentSessionId),
    });
  }
  const knownKeys = new Set(catalog.map(sessionKey));
  const roots = new Set<string>();
  for (const row of catalog) {
    if (!matches(row)) continue;
    let current: SessionKey = { agentType: String(row.agentType), sessionId: String(row.sessionId) };
    const visited = new Set<string>();
    for (;;) {
      const currentKey = `${current.agentType}\0${current.sessionId}`;
      if (visited.has(currentKey)) break;
      visited.add(currentKey);
      const parent = parentByKey.get(currentKey);
      if (!parent) {
        if (knownKeys.has(currentKey)) roots.add(currentKey);
        break;
      }
      current = parent;
    }
  }
  return roots;
}

/**
 * 归一化会话派生元数据的一列（title / project_path）：
 * 缺省、非字符串、纯空白一律转成 null。原因是 upsert 用 `COALESCE(excluded.x, 历史值)`，
 * 空串不是 NULL，会覆盖掉历史值；归一成 null 才能保证「本次没解析出」不清空历史。
 */
function metadataText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 写入一条会话派生元数据（docs/agent-session-metadata.md §2）。
 *
 * 与 Rust 的对齐关系：表结构/写入语义是 Node Host 与桌面 Rust 共用的 schema 契约，只是当前
 * 仅 Node Host 写入（Rust 侧读不到该表时忽略）。SQL 逐句照搬文档：`ON CONFLICT DO UPDATE`
 * 只 COALESCE 覆盖 title / project_path，并始终刷新 updated_at。
 *
 * - `agent_type` / `session_id` 为空直接 return：没有会话身份就没有可聚合的键，写进去只会
 *   产生孤儿行（且代理侧不应因此报错）。
 * - title / project_path 传空串/纯空白时归一成 NULL，否则 COALESCE 会把它当成有效值覆盖历史
 *   （空串不等于 NULL）。
 * - source 缺省 'derived'：语义是服务端近似派生；后续更可信来源可显式传 manual/agent。
 * - 异常不在这里吞掉：写失败由调用方（proxy 侧）try/catch 兜底，主链路不受影响。
 */
export function upsertAgentSessionMetadata(db: DatabaseSync, row: JsonRow): void {
  const agentType = typeof row.agent_type === "string" ? row.agent_type.trim() : "";
  const sessionId = typeof row.session_id === "string" ? row.session_id.trim() : "";
  if (!agentType || !sessionId) return;
  const source =
    typeof row.source === "string" && row.source.trim() !== "" ? row.source.trim() : "derived";
  db.prepare(
    `INSERT INTO agent_session_metadata (agent_type, session_id, title, project_path, source, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(agent_type, session_id) DO UPDATE SET
         title        = COALESCE(excluded.title, agent_session_metadata.title),
         project_path = COALESCE(excluded.project_path, agent_session_metadata.project_path),
         updated_at   = excluded.updated_at`,
  ).run(
    agentType,
    sessionId,
    metadataText(row.title),
    metadataText(row.project_path),
    source,
    new Date().toISOString(),
  );
}

/** Rust list_observed_agent_sessions：按 (agent_type, agent_session_id) 聚合请求观测。 */
export function listObservedAgentSessions(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(
      `SELECT
          rl.agent_type,
          rl.agent_session_id,
          MAX(rl.parent_agent_session_id) AS parent_agent_session_id,
          MAX(rl.client_id) AS client_id,
          MAX(rl.client_name) AS client_name,
          MIN(rl.created_at) AS started_at,
          MAX(rl.created_at) AS updated_at,
          COUNT(DISTINCT rl.request_id) AS request_count,
          SUM(CASE WHEN rl.status BETWEEN 200 AND 399 AND rl.error_message IS NULL THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN rl.status BETWEEN 200 AND 399 AND rl.error_message IS NULL THEN 0 ELSE 1 END) AS error_count,
          COALESCE(SUM(ur.total_tokens), 0) AS known_tokens,
          COALESCE(SUM(ur.input_tokens), 0) AS input_tokens,
          COALESCE(SUM(ur.input_cached_tokens), 0) AS input_cached_tokens,
          COALESCE(SUM(ur.input_uncached_tokens), 0) AS input_uncached_tokens,
          COALESCE(SUM(CASE WHEN ur.input_cached_tokens IS NOT NULL THEN ur.input_tokens ELSE 0 END), 0) AS cache_measured_input_tokens,
          COALESCE(SUM(ur.output_tokens), 0) AS output_tokens,
          SUM(CASE WHEN ur.total_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_usage_count,
          COALESCE(SUM(ur.estimated_cost), 0) AS estimated_cost,
          COALESCE(SUM(ur.estimated_input_uncached_cost), 0) AS estimated_input_uncached_cost,
          COALESCE(SUM(ur.estimated_input_cached_cost), 0) AS estimated_input_cached_cost,
          COALESCE(SUM(ur.estimated_input_cache_write_cost), 0) AS estimated_input_cache_write_cost,
          COALESCE(SUM(ur.estimated_output_cost), 0) AS estimated_output_cost,
          -- 会话派生元数据（docs/agent-session-metadata.md §3）：按 (agent_type, session_id)
          -- LEFT JOIN 一对一，MAX 只为满足 GROUP BY 语法；缺失时为 NULL。
          MAX(m.title) AS session_title,
          MAX(m.project_path) AS session_project_path
      FROM request_logs rl
      LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
      LEFT JOIN agent_session_metadata m
             ON m.agent_type = rl.agent_type
            AND m.session_id = rl.agent_session_id
      WHERE rl.is_last_attempt = 1
        AND rl.agent_session_id IS NOT NULL
      GROUP BY rl.agent_type, rl.agent_session_id`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const startedAt = String(row.started_at ?? "");
    const updatedAt = String(row.updated_at ?? "");
    return {
      agentType: String(row.agent_type),
      sessionId: String(row.agent_session_id),
      runtimeStatus: "unknown",
      // 派生标题/项目路径来自 agent_session_metadata（缺失时保持 null，前端回退到目录名/id）。
      title: row.session_title ?? null,
      projectPath: row.session_project_path ?? null,
      parentSessionId: row.parent_agent_session_id ?? null,
      clientId: row.client_id ?? null,
      clientName: row.client_name ?? null,
      nativeStartedAt: null,
      nativeUpdatedAt: null,
      activityAt: updatedAt,
      flowletObserved: true,
      startedAt,
      updatedAt,
      requestCount: reqNum(row.request_count),
      successCount: reqNum(row.success_count),
      errorCount: reqNum(row.error_count),
      knownTokens: reqNum(row.known_tokens),
      inputTokens: reqNum(row.input_tokens),
      inputCachedTokens: reqNum(row.input_cached_tokens),
      inputUncachedTokens: reqNum(row.input_uncached_tokens),
      cacheMeasuredInputTokens: reqNum(row.cache_measured_input_tokens),
      outputTokens: reqNum(row.output_tokens),
      unknownUsageCount: reqNum(row.unknown_usage_count),
      estimatedCost: reqNum(row.estimated_cost),
      estimatedInputUncachedCost: reqNum(row.estimated_input_uncached_cost),
      estimatedInputCachedCost: reqNum(row.estimated_input_cached_cost),
      estimatedInputCacheWriteCost: reqNum(row.estimated_input_cache_write_cost),
      estimatedOutputCost: reqNum(row.estimated_output_cost),
      nativeSummary: null,
      nativeSyncedAt: null,
      hasFlowletRequests: false,
    };
  });
}

/** Rust agent_sessions_page + list_observed_agent_sessions_page（筛选/搜索/分页）。 */
export function listObservedAgentSessionsPage(db: DatabaseSync, filter: JsonRow): JsonRow {
  const page = Math.max(1, Number(filter.page ?? 1));
  const pageSize = Math.min(500, Math.max(1, Number(filter.page_size ?? 20)));
  const offset = (page - 1) * pageSize;
  const search = String(filter.search ?? "").trim().toLowerCase();
  const agentType = String(filter.agent_type ?? "").trim();
  const runtimeStatus = String(filter.runtime_status ?? "").trim();
  const projectPath = String(filter.project_path ?? "").trim();

  const catalog = listObservedAgentSessions(db);
  const matchingRoots = matchingRootKeys(catalog, (row) =>
    search === "" ? !row.parentSessionId : sessionMatchesSearch(row, search),
  );
  const projectRoots = matchingRootKeys(catalog, (row) => sessionMatchesProjectPath(row, projectPath));
  const filtered = catalog.filter(
    (row) =>
      !row.parentSessionId &&
      matchingRoots.has(sessionKey(row)) &&
      projectRoots.has(sessionKey(row)) &&
      (agentType === "" || row.agentType === agentType) &&
      (runtimeStatus === "" || row.runtimeStatus === runtimeStatus),
  );
  const sorted = sortByActivity(filtered);
  const total = sorted.length;
  return {
    rows: sorted.slice(offset, offset + pageSize),
    total,
    page,
    pageSize,
  };
}

/** Rust list_observed_agent_session_children。 */
export function listObservedAgentSessionChildren(
  db: DatabaseSync,
  agentType: string,
  parentSessionId: string,
): JsonRow[] {
  const type = agentType.trim();
  const parent = parentSessionId.trim();
  if (!type || !parent) return [];
  const rows = listObservedAgentSessions(db).filter(
    (row) => row.agentType === type && row.parentSessionId === parent,
  );
  return sortByActivity(rows);
}

/** Rust AgentSessionFlowletUsage（list_agent_sessions 详情用量）。 */
export function agentSessionFlowletUsage(
  db: DatabaseSync,
  agentType: string,
  sessionId: string,
): JsonRow | null {
  const row = db
    .prepare(
      `SELECT
          (SELECT COUNT(1) FROM request_logs
           WHERE is_last_attempt = 1 AND agent_type = ?1
             AND agent_session_id = ?2 AND agent_session_id IS NOT NULL) AS matched,
          (SELECT COALESCE(SUM(ur.total_tokens), 0)
           FROM request_logs rl
           LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
           WHERE rl.is_last_attempt = 1 AND rl.agent_type = ?1
             AND rl.agent_session_id = ?2 AND rl.agent_session_id IS NOT NULL) AS total_tokens,
          (SELECT COALESCE(SUM(ur.estimated_cost), 0)
           FROM request_logs rl
           LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
           WHERE rl.is_last_attempt = 1 AND rl.agent_type = ?1
             AND rl.agent_session_id = ?2 AND rl.agent_session_id IS NOT NULL) AS estimated_cost`,
    )
    .get(agentType, sessionId) as Record<string, unknown> | undefined;
  if (!row || reqNum(row.matched) === 0) return null;
  return { totalTokens: reqNum(row.total_tokens), estimatedCost: reqNum(row.estimated_cost) };
}

export { num as nullableNumber };