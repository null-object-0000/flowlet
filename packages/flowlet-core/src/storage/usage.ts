// 用量与费用聚合 SQL 层。
//
// 逐条对照 src-tauri/src/core/storage_usage.rs：
// - usage_summary_range：本机 usage_records + 同步来的 device_usage_breakdowns
//   UNION ALL 后按设备维度二次分组，再合并 Agent 原生事件（agent_usage_events）；
// - usage_today_summary：今日单行聚合（本机 + 原生 + 设备日快照）；
// - account_stats / account_routing_scores / upsert usage record。
//
// 与 Rust 的已知差异：native 行费用依赖 models-cn/models-dev 价格表；未调用 setPrices
// 时按无价格处理（estimated_cost=0、currency=null），与 Rust 无价格表时一致。
import type { DatabaseSync } from "node:sqlite";
import type { JsonRow } from "../types.ts";
import { canonicalModelKey, officialChannelIdForModel } from "../catalog/index.ts";
import { resolvePrices, resolvePricesAt, type ModelPrice } from "./prices.ts";

export type { ModelPrice, ModelPriceTier } from "./prices.ts";

function reqNum(value: unknown): number {
  return Number(value ?? 0);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export interface CostBreakdown {
  total: number;
  input_uncached: number;
  input_cached: number;
  input_cache_write: number;
  output: number;
}

/** 单次使用费用估算（Rust estimate_cost_at：按当前时刻解析分时价格，未命中返回 null）。 */
export function estimateCostAt(
  prices: ModelPrice[],
  channelId: string | null,
  upstreamModel: string | null,
  inputTokens: number | null,
  inputCachedTokens: number | null,
  inputUncachedTokens: number | null,
  inputCacheWriteTokens: number | null,
  outputTokens: number | null,
  atMs: number = Date.now(),
): CostBreakdown | null {
  if (!channelId || !upstreamModel) return null;
  const canonicalModel = canonicalModelKey(upstreamModel);
  const matches = (price: ModelPrice): boolean =>
    price.channel_id.toLowerCase() === channelId.toLowerCase() &&
    canonicalModelKey(price.upstream_model).toLowerCase() === canonicalModel.toLowerCase();
  let price = prices.find(matches);
  if (!price) {
    const ownerChannel = officialChannelIdForModel(canonicalModel);
    if (ownerChannel) {
      price = prices.find(
        (candidate) =>
          candidate.channel_id.toLowerCase() === ownerChannel.toLowerCase() &&
          canonicalModelKey(candidate.upstream_model).toLowerCase() === canonicalModel.toLowerCase(),
      );
    }
  }
  if (!price) return null;
  const resolved = resolvePricesAt(price, inputTokens, atMs);
  if (!resolved) return null;
  const [uncachedPrice, cachedPrice, cacheWritePrice, outputPrice] = resolved;
  const cacheWrite = Math.max(0, inputCacheWriteTokens ?? 0);
  const inputUncached = Math.max(0, Math.max(0, inputUncachedTokens ?? inputTokens ?? 0) - cacheWrite);
  const inputCached = Math.max(0, inputCachedTokens ?? 0);
  const output = Math.max(0, outputTokens ?? 0);
  const inputUncachedCost = (inputUncached * uncachedPrice) / 1_000_000;
  const inputCachedCost = (inputCached * cachedPrice) / 1_000_000;
  const inputCacheWriteCost = (cacheWrite * (cacheWritePrice ?? uncachedPrice)) / 1_000_000;
  const outputCost = (output * outputPrice) / 1_000_000;
  return {
    total: inputUncachedCost + inputCachedCost + inputCacheWriteCost + outputCost,
    input_uncached: inputUncachedCost,
    input_cached: inputCachedCost,
    input_cache_write: inputCacheWriteCost,
    output: outputCost,
  };
}

/** 原生事件的标准公开 API 等价费用（Rust estimate_native_public_cost）。 */
function estimateNativePublicCost(
  prices: ModelPrice[],
  model: string,
  inputUncachedTokens: number,
  inputCachedTokens: number,
  inputCacheWriteTokens: number,
  outputTokens: number,
): [number, string] | null {
  const canonicalModel = canonicalModelKey(model);
  const officialChannel = officialChannelIdForModel(canonicalModel);
  let price: ModelPrice | undefined;
  if (officialChannel) {
    price = prices.find(
      (candidate) =>
        candidate.channel_id.toLowerCase() === officialChannel.toLowerCase() &&
        candidate.upstream_model.toLowerCase() === canonicalModel.toLowerCase(),
    );
  }
  if (!price) {
    price = prices.find(
      (candidate) =>
        candidate.channel_id.toLowerCase() === "openai-api" &&
        candidate.upstream_model.toLowerCase() === canonicalModel.toLowerCase(),
    );
  }
  if (!price) {
    const candidates = prices.filter(
      (candidate) =>
        candidate.channel_id.toLowerCase() !== "codex-native" &&
        candidate.upstream_model.toLowerCase() === canonicalModel.toLowerCase(),
    );
    if (candidates.length === 1) price = candidates[0];
  }
  if (!price) return null;
  const resolved = resolvePrices(price, null);
  if (!resolved) return null;
  const [uncachedPrice, cachedPrice, cacheWritePrice, outputPrice] = resolved;
  const amount =
    (Math.max(0, inputUncachedTokens) * uncachedPrice) / 1_000_000 +
    (Math.max(0, inputCachedTokens) * cachedPrice) / 1_000_000 +
    (Math.max(0, inputCacheWriteTokens) * (cacheWritePrice ?? uncachedPrice)) / 1_000_000 +
    (Math.max(0, outputTokens) * outputPrice) / 1_000_000;
  return [amount, price.currency];
}

/** Rust is_legacy_aggregate_alias。 */
function isLegacyAggregateAlias(model: string): boolean {
  const key = model.trim().toLowerCase();
  return key === "flowlet-pro" || key === "flowlet-flash";
}

function isCodexAgent(agentType: string): boolean {
  return agentType === "codex-desktop" || agentType === "codex-cli";
}

interface NativeAggregate {
  native_event_count: number;
  input_uncached_tokens: number;
  input_cached_tokens: number;
  input_cache_write_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

function uniqueSnapshotModel(summaryJson: string): string | null {
  try {
    const summary = JSON.parse(summaryJson) as { models?: unknown };
    const raw = Array.isArray(summary.models) ? summary.models : [];
    const models = raw
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    if (models.length === 0) return null;
    const firstKey = canonicalModelKey(models[0]);
    return models.every((model) => canonicalModelKey(model) === firstKey) ? models[0] : null;
  } catch {
    return null;
  }
}

function localDateOf(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const head = value.slice(0, 10);
    return head.charAt(4) === "-" ? head : null;
  }
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localBoundaryMs(date: Date): string {
  // 与 Rust local_boundary 等价：当地 00:00:00 的 RFC3339（含偏移）。
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const offsetMinutes = -midnight.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const pad = (value: number, size = 2): string => String(value).padStart(size, "0");
  return `${midnight.getFullYear()}-${pad(midnight.getMonth() + 1)}-${pad(midnight.getDate())}T00:00:00${offset}`;
}

function invalidRange(message: string): Error {
  return new Error(message);
}

/** Rust usage_period_bounds（period 仅由 usage_summary 内部使用）。 */
export function usagePeriodBounds(period: string): { startAt: string | null; endAt: string | null; groupBy: string } {
  const today = new Date();
  const startOfDay = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const addDays = (date: Date, days: number): Date =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  const todayStart = startOfDay(today);
  let start: Date | null = null;
  let end: Date | null = null;
  let groupBy = "day";
  if (period === "today") {
    start = todayStart;
    end = addDays(todayStart, 1);
    groupBy = "hour";
  } else if (period === "week") {
    const mondayOffset = (todayStart.getDay() + 6) % 7;
    start = addDays(todayStart, -mondayOffset);
    end = addDays(start, 7);
    groupBy = "hour";
  } else if (period === "month") {
    start = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
    end = new Date(todayStart.getFullYear(), todayStart.getMonth() + 1, 1);
  } else if (period === "quarter") {
    const startMonth = Math.floor(todayStart.getMonth() / 3) * 3;
    start = new Date(todayStart.getFullYear(), startMonth, 1);
    end = new Date(todayStart.getFullYear(), startMonth + 3, 1);
  } else if (period === "year") {
    start = new Date(todayStart.getFullYear(), 0, 1);
    end = new Date(todayStart.getFullYear() + 1, 0, 1);
  }
  if (!start || !end) return { startAt: null, endAt: null, groupBy };
  return { startAt: localBoundaryMs(start), endAt: localBoundaryMs(end), groupBy };
}

const USAGE_SUMMARY_COLUMNS = [
  "device_id",
  "usage_date",
  "client_id",
  "client_name",
  "channel_id",
  "channel_name",
  "account_id",
  "account_name",
  "upstream_model",
  "request_count",
  "known_tokens",
  "input_tokens",
  "input_cached_tokens",
  "input_uncached_tokens",
  "cache_measured_input_tokens",
  "output_tokens",
  "unknown_count",
  "estimated_cost",
  "estimated_cost_currency",
  "native_event_count",
  "elapsed_total_ms",
  "elapsed_measured_count",
  "generation_total_ms",
  "generation_output_tokens",
];

function mapUsageSummaryRow(row: Record<string, unknown>): JsonRow {
  const result: JsonRow = {};
  for (const column of USAGE_SUMMARY_COLUMNS) {
    const value = row[column];
    if (
      [
        "request_count",
        "known_tokens",
        "input_tokens",
        "input_cached_tokens",
        "input_uncached_tokens",
        "cache_measured_input_tokens",
        "output_tokens",
        "unknown_count",
        "native_event_count",
        "elapsed_total_ms",
        "elapsed_measured_count",
        "generation_total_ms",
        "generation_output_tokens",
      ].includes(column)
    ) {
      result[column] = reqNum(value);
    } else if (column === "estimated_cost") {
      result[column] = reqNum(value);
    } else {
      result[column] = value ?? null;
    }
  }
  result.date = row.usage_date ?? "未知日期";
  delete result.usage_date;
  return result;
}

/** Rust usage_summary_range（不传 start/end 时为全量）。 */
export function usageSummaryRange(
  db: DatabaseSync,
  prices: ModelPrice[],
  startAtInput: string | null,
  endAtInput: string | null,
  groupByInput: string,
  currentDeviceId: string,
): JsonRow[] {
  if (groupByInput !== "hour" && groupByInput !== "day") {
    throw invalidRange("不支持的用量分组粒度");
  }
  const hasRange = startAtInput !== null || endAtInput !== null;
  let startAt: string | null = null;
  let endAt: string | null = null;
  let breakdownStart: string | null = null;
  let breakdownEnd: string | null = null;
  if (startAtInput !== null && endAtInput !== null) {
    const start = new Date(startAtInput);
    const end = new Date(endAtInput);
    if (Number.isNaN(start.getTime())) throw invalidRange("开始时间不是有效的 RFC3339 时间");
    if (Number.isNaN(end.getTime())) throw invalidRange("结束时间不是有效的 RFC3339 时间");
    if (start.getTime() >= end.getTime()) throw invalidRange("开始时间必须早于结束时间");
    startAt = startAtInput;
    endAt = endAtInput;
    breakdownStart = localDateOf(startAtInput);
    breakdownEnd = localDateOf(new Date(end.getTime() - 1000).toISOString());
  } else if (startAtInput !== null || endAtInput !== null) {
    throw invalidRange("开始时间和结束时间必须同时提供");
  }

  const dateExpression =
    groupByInput === "hour"
      ? "strftime('%Y-%m-%dT%H:00:00', request_logs.created_at, 'localtime')"
      : "strftime('%Y-%m-%d', request_logs.created_at, 'localtime')";
  const localRangeClause = hasRange
    ? "AND request_logs.created_at >= datetime(?3) AND request_logs.created_at < datetime(?4)"
    : "";
  const breakdownRangeClause = hasRange
    ? "AND breakdown_date >= ?5 AND breakdown_date <= ?6"
    : "";

  const sql = `
    SELECT
        device_id,
        usage_date,
        client_id,
        client_name,
        channel_id,
        channel_name,
        account_id,
        account_name,
        upstream_model,
        sum(request_count) AS request_count,
        sum(known_tokens) AS known_tokens,
        sum(input_tokens) AS input_tokens,
        sum(input_cached_tokens) AS input_cached_tokens,
        sum(input_uncached_tokens) AS input_uncached_tokens,
        sum(cache_measured_input_tokens) AS cache_measured_input_tokens,
        sum(output_tokens) AS output_tokens,
        sum(unknown_count) AS unknown_count,
        sum(estimated_cost) AS estimated_cost,
        max(estimated_cost_currency) AS estimated_cost_currency,
        sum(native_event_count) AS native_event_count,
        sum(elapsed_total_ms) AS elapsed_total_ms,
        sum(elapsed_measured_count) AS elapsed_measured_count,
        sum(generation_total_ms) AS generation_total_ms,
        sum(generation_output_tokens) AS generation_output_tokens
    FROM (
        SELECT
            ?1 AS device_id,
            ${dateExpression} AS usage_date,
            usage_records.client_id,
            usage_records.client_name,
            usage_records.channel_id,
            usage_records.channel_name,
            COALESCE(account_links.workspace_account_id, usage_records.account_id) AS account_id,
            COALESCE(ca.name, usage_records.account_name) AS account_name,
            usage_records.upstream_model,
            count(*) AS request_count,
            coalesce(sum(usage_records.total_tokens), 0) AS known_tokens,
            coalesce(sum(usage_records.input_tokens), 0) AS input_tokens,
            coalesce(sum(usage_records.input_cached_tokens), 0) AS input_cached_tokens,
            coalesce(sum(usage_records.input_uncached_tokens), 0) AS input_uncached_tokens,
            coalesce(sum(CASE WHEN usage_records.input_cached_tokens IS NOT NULL THEN usage_records.input_tokens ELSE 0 END), 0) AS cache_measured_input_tokens,
            coalesce(sum(usage_records.output_tokens), 0) AS output_tokens,
            sum(CASE WHEN usage_records.total_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_count,
            coalesce(sum(usage_records.estimated_cost), 0) AS estimated_cost,
            NULL AS estimated_cost_currency,
            0 AS native_event_count,
            coalesce(sum(COALESCE(request_logs.duration_ms, request_logs.latency_ms)), 0) AS elapsed_total_ms,
            sum(CASE WHEN COALESCE(request_logs.duration_ms, request_logs.latency_ms) IS NOT NULL THEN 1 ELSE 0 END) AS elapsed_measured_count,
            coalesce(sum(CASE WHEN request_logs.duration_ms IS NOT NULL
                               AND request_logs.ttft_ms IS NOT NULL
                               AND request_logs.duration_ms > request_logs.ttft_ms
                         THEN request_logs.duration_ms - request_logs.ttft_ms ELSE 0 END), 0) AS generation_total_ms,
            sum(CASE WHEN request_logs.duration_ms IS NOT NULL
                      AND request_logs.ttft_ms IS NOT NULL
                      AND request_logs.duration_ms > request_logs.ttft_ms
                THEN coalesce(usage_records.output_tokens, 0) ELSE 0 END) AS generation_output_tokens
        FROM usage_records
        LEFT JOIN request_logs ON request_logs.request_id = usage_records.request_id
                              AND request_logs.is_last_attempt = 1
        LEFT JOIN channel_accounts ca ON ca.id = usage_records.account_id
        LEFT JOIN channel_account_workspace_links account_links
               ON account_links.local_account_id = usage_records.account_id
        WHERE 1 = 1
        ${localRangeClause}
        GROUP BY usage_date, usage_records.client_id, usage_records.channel_id,
                 usage_records.account_id, usage_records.upstream_model

        UNION ALL

        SELECT
            device_id,
            breakdown_date AS usage_date,
            CASE
                WHEN client_id = 'codex' AND client_name = 'Codex Desktop'
                THEN 'codex-desktop'
                ELSE client_id
            END AS client_id,
            client_name,
            channel_id,
            channel_name,
            account_id,
            account_name,
            upstream_model,
            request_count,
            known_tokens,
            input_tokens,
            input_cached_tokens,
            input_uncached_tokens,
            cache_measured_input_tokens,
            output_tokens,
            unknown_count,
            estimated_cost,
            estimated_cost_currency,
            native_event_count,
            elapsed_total_ms,
            elapsed_measured_count,
            generation_total_ms,
            generation_output_tokens
        FROM device_usage_breakdowns remote
        WHERE device_id != ?2
          AND NOT (
              request_count = 0 AND native_event_count > 0
              AND lower(trim(upstream_model)) IN ('flowlet-pro', 'flowlet-flash')
          )
          AND NOT (
              remote.client_id = 'codex' AND remote.client_name = 'Codex Desktop'
              AND EXISTS (
                  SELECT 1 FROM device_usage_breakdowns current
                  WHERE current.device_id = remote.device_id
                    AND current.breakdown_date = remote.breakdown_date
                    AND current.client_id = 'codex-desktop'
                    AND current.channel_id IS remote.channel_id
                    AND current.account_id IS remote.account_id
                    AND current.upstream_model IS remote.upstream_model
              )
          )
        ${breakdownRangeClause}
    ) combined
    GROUP BY device_id, usage_date, client_id, channel_id, account_id, upstream_model
    ORDER BY usage_date DESC, request_count DESC
  `;
  const params: Array<string | number> = [currentDeviceId, currentDeviceId];
  if (hasRange) {
    params.push(startAt ?? "", endAt ?? "", breakdownStart ?? "", breakdownEnd ?? "");
  }
  const summary = (db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map(
    mapUsageSummaryRow,
  );

  // Agent 原生事件（未经过 Flowlet 的会话）：按 (日期, agent, 模型) 聚合后再合并进结果。
  const nativeDateExpression =
    groupByInput === "hour"
      ? "strftime('%Y-%m-%dT%H:00:00', event_time, 'localtime')"
      : "strftime('%Y-%m-%d', event_time, 'localtime')";
  const nativeRangeClause = hasRange
    ? "AND datetime(event_time) >= datetime(?1) AND datetime(event_time) < datetime(?2)"
    : "";
  const snapshotModels = new Map<string, string>();
  const snapshotRows = db
    .prepare("SELECT agent_type, session_id, summary_json FROM agent_session_snapshots")
    .all() as Array<Record<string, unknown>>;
  for (const row of snapshotRows) {
    const model = uniqueSnapshotModel(String(row.summary_json ?? "{}"));
    if (model) snapshotModels.set(`${String(row.agent_type)}\0${String(row.session_id)}`, model);
  }
  const nativeSql = `
    SELECT
        ${nativeDateExpression} AS usage_date,
        agent_type,
        session_id,
        nullif(trim(model), '') AS model,
        count(*) AS native_event_count,
        coalesce(sum(CASE
            WHEN agent_type IN ('codex-desktop', 'codex-cli') THEN
                max(input_tokens - cached_input_tokens - cache_write_input_tokens, 0)
            ELSE input_tokens
        END), 0) AS input_uncached_tokens,
        coalesce(sum(cached_input_tokens), 0) AS input_cached_tokens,
        coalesce(sum(cache_write_input_tokens), 0) AS input_cache_write_tokens,
        coalesce(sum(output_tokens), 0) AS output_tokens,
        coalesce(sum(total_tokens), 0) AS total_tokens
    FROM agent_usage_events
    WHERE 1 = 1
      ${nativeRangeClause}
      AND NOT EXISTS (
          SELECT 1 FROM request_logs
          WHERE request_logs.agent_type = agent_usage_events.agent_type
            AND request_logs.agent_session_id = agent_usage_events.session_id
      )
    GROUP BY usage_date, agent_type, session_id, nullif(trim(model), '')
    ORDER BY usage_date DESC, native_event_count DESC
  `;
  const nativeParams: string[] = hasRange ? [startAt ?? "", endAt ?? ""] : [];
  const nativeRows = db.prepare(nativeSql).all(...nativeParams) as Array<Record<string, unknown>>;
  const nativeAggregates = new Map<string, { date: string; agentType: string; model: string; aggregate: NativeAggregate }>();
  for (const row of nativeRows) {
    const date = String(row.usage_date ?? "未知日期");
    const agentType = String(row.agent_type);
    const sessionId = String(row.session_id);
    const eventModel = typeof row.model === "string" ? row.model : null;
    const model = eventModel ?? snapshotModels.get(`${agentType}\0${sessionId}`) ?? null;
    if (!model) continue;
    if (isLegacyAggregateAlias(model)) continue;
    const key = `${date}\0${agentType}\0${model}`;
    let entry = nativeAggregates.get(key);
    if (!entry) {
      entry = {
        date,
        agentType,
        model,
        aggregate: {
          native_event_count: 0,
          input_uncached_tokens: 0,
          input_cached_tokens: 0,
          input_cache_write_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
      };
      nativeAggregates.set(key, entry);
    }
    const aggregate = entry.aggregate;
    aggregate.native_event_count += reqNum(row.native_event_count);
    aggregate.input_uncached_tokens += reqNum(row.input_uncached_tokens);
    aggregate.input_cached_tokens += reqNum(row.input_cached_tokens);
    aggregate.input_cache_write_tokens += reqNum(row.input_cache_write_tokens);
    aggregate.output_tokens += reqNum(row.output_tokens);
    aggregate.total_tokens += reqNum(row.total_tokens);
  }

  for (const { date, agentType, model, aggregate } of nativeAggregates.values()) {
    const inputTokens =
      aggregate.input_uncached_tokens +
      aggregate.input_cached_tokens +
      aggregate.input_cache_write_tokens;
    const cost = estimateNativePublicCost(
      prices,
      model,
      aggregate.input_uncached_tokens,
      aggregate.input_cached_tokens,
      aggregate.input_cache_write_tokens,
      aggregate.output_tokens,
    );
    const clientName = agentType;
    summary.push({
      date,
      client_id: agentType,
      client_name: clientName,
      channel_id: "agent-native",
      channel_name: "Agent 原生（未经过 Flowlet）",
      account_id: agentType,
      account_name: clientName,
      upstream_model: model,
      request_count: 0,
      known_tokens: aggregate.total_tokens,
      input_tokens: inputTokens,
      input_cached_tokens: aggregate.input_cached_tokens,
      input_uncached_tokens: aggregate.input_uncached_tokens,
      cache_measured_input_tokens: inputTokens,
      output_tokens: aggregate.output_tokens,
      unknown_count: 0,
      estimated_cost: cost ? cost[0] : 0,
      estimated_cost_currency: cost ? cost[1] : null,
      native_event_count: aggregate.native_event_count,
      elapsed_total_ms: 0,
      elapsed_measured_count: 0,
      generation_total_ms: 0,
      generation_output_tokens: 0,
      device_id: currentDeviceId,
    });
  }

  summary.sort((left, right) => {
    const byDate = String(right.date).localeCompare(String(left.date));
    if (byDate !== 0) return byDate;
    const byCount = reqNum(right.request_count) - reqNum(left.request_count);
    if (byCount !== 0) return byCount;
    return reqNum(right.native_event_count) - reqNum(left.native_event_count);
  });
  return summary;
}

/** Rust usage_today_summary：今日单行聚合（本机 usage_records + 原生事件 + 设备日快照）。 */
export function usageTodaySummary(db: DatabaseSync): JsonRow {
  const row = db
    .prepare(
      `WITH today_sources (
          total_tokens,
          input_tokens,
          input_cached_tokens,
          input_uncached_tokens,
          cache_measured_input_tokens,
          output_tokens
      ) AS (
          SELECT
              coalesce(sum(ur.total_tokens), 0),
              coalesce(sum(ur.input_tokens), 0),
              coalesce(sum(ur.input_cached_tokens), 0),
              coalesce(sum(ur.input_uncached_tokens), 0),
              coalesce(sum(CASE WHEN ur.input_cached_tokens IS NOT NULL THEN ur.input_tokens ELSE 0 END), 0),
              coalesce(sum(ur.output_tokens), 0)
          FROM usage_records ur
          LEFT JOIN request_logs rl
                 ON rl.request_id = ur.request_id
                AND rl.is_last_attempt = 1
          WHERE strftime('%Y-%m-%d', coalesce(rl.created_at, ur.created_at), 'localtime')
                = date('now', 'localtime')

          UNION ALL

          SELECT
              coalesce(sum(a.total_tokens), 0),
              coalesce(sum(CASE
                  WHEN a.agent_type IN ('codex-desktop', 'codex-cli') THEN
                      max(a.input_tokens - a.cached_input_tokens - a.cache_write_input_tokens, 0)
                  ELSE a.input_tokens
              END), 0)
                  + coalesce(sum(a.cached_input_tokens), 0)
                  + coalesce(sum(a.cache_write_input_tokens), 0),
              coalesce(sum(a.cached_input_tokens), 0),
              coalesce(sum(CASE
                  WHEN a.agent_type IN ('codex-desktop', 'codex-cli') THEN
                      max(a.input_tokens - a.cached_input_tokens - a.cache_write_input_tokens, 0)
                  ELSE a.input_tokens
              END), 0),
              coalesce(sum(CASE
                  WHEN a.agent_type IN ('codex-desktop', 'codex-cli') THEN
                      max(a.input_tokens - a.cached_input_tokens - a.cache_write_input_tokens, 0)
                  ELSE a.input_tokens
              END), 0)
                  + coalesce(sum(a.cached_input_tokens), 0)
                  + coalesce(sum(a.cache_write_input_tokens), 0),
              coalesce(sum(a.output_tokens), 0)
          FROM agent_usage_events a
          WHERE strftime('%Y-%m-%d', a.event_time, 'localtime') = date('now', 'localtime')
            AND NOT EXISTS (
                SELECT 1 FROM request_logs rl
                WHERE rl.agent_type = a.agent_type
                  AND rl.agent_session_id = a.session_id
            )

          UNION ALL

          SELECT
              coalesce(sum(d.known_tokens + d.native_total_tokens), 0),
              coalesce(sum(
                  d.input_tokens + d.native_input_tokens
                  + d.native_cached_input_tokens + d.native_cache_write_input_tokens
              ), 0),
              coalesce(sum(d.input_cached_tokens + d.native_cached_input_tokens), 0),
              coalesce(sum(d.input_uncached_tokens + d.native_input_tokens), 0),
              coalesce(sum(
                  d.cache_measured_input_tokens + d.native_input_tokens
                  + d.native_cached_input_tokens + d.native_cache_write_input_tokens
              ), 0),
              coalesce(sum(d.output_tokens + d.native_output_tokens), 0)
          FROM device_daily_usage d
          WHERE d.usage_date = date('now', 'localtime')
      )
      SELECT
          coalesce(sum(total_tokens), 0) AS total_tokens,
          coalesce(sum(input_tokens), 0) AS input_tokens,
          coalesce(sum(input_cached_tokens), 0) AS input_cached_tokens,
          coalesce(sum(input_uncached_tokens), 0) AS input_uncached_tokens,
          coalesce(sum(cache_measured_input_tokens), 0) AS cache_measured_input_tokens,
          coalesce(sum(output_tokens), 0) AS output_tokens
      FROM today_sources`,
    )
    .get() as Record<string, unknown> | undefined;
  return {
    total_tokens: reqNum(row?.total_tokens),
    input_tokens: reqNum(row?.input_tokens),
    input_cached_tokens: reqNum(row?.input_cached_tokens),
    input_uncached_tokens: reqNum(row?.input_uncached_tokens),
    cache_measured_input_tokens: reqNum(row?.cache_measured_input_tokens),
    output_tokens: reqNum(row?.output_tokens),
  };
}

/** Rust account_stats。 */
export function accountStats(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(
      `SELECT
          rl.account_id,
          COALESCE(ca.name, rl.account_name) AS account_name,
          rl.channel_id,
          rl.channel_name,
          count(*) AS total_requests,
          sum(CASE WHEN rl.status >= 200 AND rl.status < 400 THEN 1 ELSE 0 END) AS success_requests,
          sum(CASE WHEN rl.status >= 400 OR rl.error_message IS NOT NULL THEN 1 ELSE 0 END) AS failed_requests,
          CASE
              WHEN count(*) = 0 THEN 0.0
              ELSE round(
                  100.0 * sum(CASE WHEN rl.status >= 400 OR rl.error_message IS NOT NULL THEN 1 ELSE 0 END)
                  / count(*), 2)
          END AS failure_rate,
          coalesce(sum(rl.fallback_count), 0) AS total_fallbacks,
          coalesce(sum(ur.total_tokens), 0) AS known_tokens,
          coalesce(sum(ur.estimated_cost), 0) AS estimated_cost,
          (
              SELECT rl2.error_message FROM request_logs rl2
              WHERE rl2.account_id = rl.account_id AND rl2.error_message IS NOT NULL
              ORDER BY rl2.created_at DESC LIMIT 1
          ) AS last_error,
          (
              SELECT rl3.created_at FROM request_logs rl3
              WHERE rl3.account_id = rl.account_id AND rl3.error_message IS NOT NULL
              ORDER BY rl3.created_at DESC LIMIT 1
          ) AS last_error_at,
          max(rl.created_at) AS last_used_at
      FROM request_logs rl
      LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
      LEFT JOIN channel_accounts ca ON ca.id = rl.account_id
      WHERE rl.account_id IS NOT NULL
      GROUP BY rl.account_id
      ORDER BY total_requests DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    account_id: row.account_id,
    account_name: row.account_name ?? null,
    channel_id: row.channel_id ?? null,
    channel_name: row.channel_name ?? null,
    total_requests: reqNum(row.total_requests),
    success_requests: reqNum(row.success_requests),
    failed_requests: reqNum(row.failed_requests),
    failure_rate: Number(row.failure_rate),
    total_fallbacks: reqNum(row.total_fallbacks),
    known_tokens: reqNum(row.known_tokens),
    estimated_cost: reqNum(row.estimated_cost),
    last_error: row.last_error ?? null,
    last_error_at: row.last_error_at ?? null,
    last_used_at: row.last_used_at ?? null,
  }));
}

/** Rust account_routing_scores：返回 [account_id, channel_id, avg_latency, success_rate, cost_per_1k]。 */
export function accountRoutingScores(db: DatabaseSync): Array<[string, string, number, number, number]> {
  const rows = db
    .prepare(
      `SELECT
          rl.account_id,
          rl.channel_id,
          avg(coalesce(rl.latency_ms, 0)) AS avg_latency,
          100.0 * (1.0 - cast(sum(CASE WHEN rl.status >= 400 OR rl.error_message IS NOT NULL THEN 1 ELSE 0 END) AS REAL) / count(*)) AS success_rate,
          coalesce(sum(ur.estimated_cost), 0) / count(*) * 1000 AS cost_per_1k
      FROM request_logs rl
      LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
      WHERE rl.account_id IS NOT NULL
        AND rl.created_at > datetime('now', '-7 days')
      GROUP BY rl.account_id, rl.channel_id
      HAVING count(*) >= 3`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => [
    String(row.account_id),
    String(row.channel_id),
    Number(row.avg_latency),
    Number(row.success_rate),
    Number(row.cost_per_1k),
  ]);
}

/**
 * Rust upsert_usage_record_with_metadata：先按 request_id UPDATE，未命中再 INSERT，
 * 费用在写入时按内存价格表估算（无价格时留 NULL）。
 */
export function insertUsageRecord(db: DatabaseSync, prices: ModelPrice[], usage: JsonRow): void {
  const usageStatus = String(usage.usage_status ?? "complete");
  const usageSource = String(usage.usage_source ?? "upstream_response");
  const inputTokens = usage.input_tokens ?? null;
  const inputCached = usage.input_cached_tokens ?? null;
  const inputUncached = usage.input_uncached_tokens ?? null;
  const inputCacheWrite = usage.input_cache_write_tokens ?? null;
  const outputTokens = usage.output_tokens ?? null;
  let cost: CostBreakdown | null = null;
  if (usageStatus === "complete") {
    cost = estimateCostAt(
      prices,
      usage.channel_id ?? null,
      usage.upstream_model ?? null,
      inputTokens,
      inputCached,
      inputUncached,
      inputCacheWrite,
      outputTokens,
    );
  }
  const costColumns = cost
    ? [cost.total, cost.input_uncached, cost.input_cached, cost.input_cache_write, cost.output]
    : [null, null, null, null, null];

  const updated = db
    .prepare(
      `UPDATE usage_records
       SET client_id = ?2, client_name = ?3, channel_id = ?4, channel_name = ?5,
           account_id = ?6, account_name = ?7, client_protocol = ?8, upstream_protocol = ?9,
           virtual_model = ?10, upstream_model = ?11,
           input_tokens = ?12, input_cached_tokens = ?13, input_uncached_tokens = ?14,
           input_cache_write_tokens = ?15, output_tokens = ?16, total_tokens = ?17,
           usage_status = ?18, usage_source = ?19,
           estimated_cost = ?20, estimated_input_uncached_cost = ?21,
           estimated_input_cached_cost = ?22, estimated_input_cache_write_cost = ?23,
           estimated_output_cost = ?24, analyzed_at = datetime('now')
       WHERE request_id = ?1`,
    )
    .run(
      String(usage.request_id ?? ""),
      usage.client_id ?? null,
      usage.client_name ?? null,
      usage.channel_id ?? null,
      usage.channel_name ?? null,
      usage.account_id ?? null,
      usage.account_name ?? null,
      String(usage.client_protocol ?? "openai"),
      String(usage.upstream_protocol ?? "openai"),
      usage.virtual_model ?? null,
      usage.upstream_model ?? null,
      inputTokens,
      inputCached,
      inputUncached,
      inputCacheWrite,
      outputTokens,
      usage.total_tokens ?? null,
      usageStatus,
      usageSource,
      ...costColumns,
    );
  if (Number(updated.changes) > 0) return;

  db.prepare(
    `INSERT INTO usage_records (
        id, request_id, client_id, client_name, channel_id, channel_name,
        account_id, account_name, client_protocol, upstream_protocol,
        virtual_model, upstream_model, input_tokens, input_cached_tokens,
        input_uncached_tokens, input_cache_write_tokens, output_tokens, total_tokens,
        usage_status, usage_source,
        estimated_cost, estimated_input_uncached_cost, estimated_input_cached_cost,
        estimated_input_cache_write_cost, estimated_output_cost, analyzed_at, created_at
     ) VALUES (
        lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
        ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
        datetime('now'), datetime('now')
     )`,
  ).run(
    String(usage.request_id ?? ""),
    usage.client_id ?? null,
    usage.client_name ?? null,
    usage.channel_id ?? null,
    usage.channel_name ?? null,
    usage.account_id ?? null,
    usage.account_name ?? null,
    String(usage.client_protocol ?? "openai"),
    String(usage.upstream_protocol ?? "openai"),
    usage.virtual_model ?? null,
    usage.upstream_model ?? null,
    inputTokens,
    inputCached,
    inputUncached,
    inputCacheWrite,
    outputTokens,
    usage.total_tokens ?? null,
    usageStatus,
    usageSource,
    ...costColumns,
  );
}

/** 供 web `db_stats` 使用的两表计数。 */
export function tableCounts(db: DatabaseSync): { logs: number; usage: number } {
  const logs = Number((db.prepare("SELECT COUNT(*) AS total FROM request_logs").get() as { total: number }).total);
  const usage = Number(
    (db.prepare("SELECT COUNT(*) AS total FROM usage_records").get() as { total: number }).total,
  );
  return { logs, usage };
}

export { num as nullableNumber };
