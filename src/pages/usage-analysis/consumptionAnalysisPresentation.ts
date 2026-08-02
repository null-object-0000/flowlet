/**
 * 消耗分析页「多维消耗分析」模块的纯展示层聚合。
 *
 * 数据来源是 `usage_summary` command 的分组明细行（粒度为
 * 日期 × client × channel × account × upstream_model），本模块在
 * 前端做二次分组：
 *
 * - `groupConsumption`：按模型 / 渠道账号 / 客户端三个主维度聚合；
 * - `buildCrossMatrix`：主维度 × 次维度（模型主维度交叉渠道账号，
 *   其余主维度交叉模型）的 Token / 费用归因矩阵。
 *
 * 费用按币种归集（costByCurrency），避免把 ¥、$ 与 credits 直接相加后
 * 混合展示；单币种聚合仍保留 cost 总和供排序使用。
 */
import { canonicalModelId, officialChannelIdForModel } from "../../domains/channel/types";
import type { UsageSummaryRow } from "../../domains/usage/types";
import { createHeatLevelScale, type HeatLevel, type HeatLevelScale } from "../../shared/visualization/heatmapLevels";

export type ConsumptionDimension = "model" | "account" | "client";
export type ConsumptionMetric = "tokens" | "cost";
export type CostCurrencyLookup = (row: UsageSummaryRow) => string | null;

/** 交叉归因矩阵每个方向最多展示的条目数（1200×720 布局下右栏的可容纳列数）。 */
export const CROSS_MATRIX_MAX_COLS = 4;

export type ConsumptionAggregate = {
  tokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cacheMeasuredInputTokens: number;
  outputTokens: number;
  requests: number;
  unknown: number;
  cost: number;
  costByCurrency: Record<string, number>;
  /** 有延迟记录的请求总耗时（ms）。 */
  latencyTotalMs: number;
  /** 有延迟记录的请求数。 */
  latencyMeasured: number;
};

export type ConsumptionEntry = ConsumptionAggregate & {
  key: string;
  label: string;
  sublabel: string | null;
  /** 品牌标识：model → 官方渠道 ID；account → channel_id；client → client_id。 */
  brandId: string | null;
  tokenShare: number;
  costShare: number;
};

export function cacheHitRateOf(aggregate: Pick<ConsumptionAggregate, "cachedInputTokens" | "cacheMeasuredInputTokens">): number | null {
  if (!(aggregate.cacheMeasuredInputTokens > 0)) return null;
  return Math.max(0, Math.min(1, aggregate.cachedInputTokens / aggregate.cacheMeasuredInputTokens));
}

/** 平均延迟（ms）；没有延迟记录时为 null。 */
export function averageLatencyMsOf(aggregate: Pick<ConsumptionAggregate, "latencyTotalMs" | "latencyMeasured">): number | null {
  if (!(aggregate.latencyMeasured > 0)) return null;
  return aggregate.latencyTotalMs / aggregate.latencyMeasured;
}

/** 输出吞吐（token/s）= 输出 Token ÷ 请求总耗时。
 *  耗时含首 Token 等待，是近似值而非纯解码速度；缺少延迟或输出数据时为 null。 */
export function outputTokensPerSecondOf(
  aggregate: Pick<ConsumptionAggregate, "latencyTotalMs" | "outputTokens">,
): number | null {
  if (!(aggregate.latencyTotalMs > 0) || !(aggregate.outputTokens > 0)) return null;
  return aggregate.outputTokens / (aggregate.latencyTotalMs / 1000);
}

export function groupConsumption(
  rows: UsageSummaryRow[],
  dimension: ConsumptionDimension,
  currencyOf?: CostCurrencyLookup,
): ConsumptionEntry[] {
  const dimensionOf = dimensionSelectors(dimension);
  const groups = new Map<string, Omit<ConsumptionEntry, "tokenShare" | "costShare">>();
  for (const row of rows) {
    const key = dimensionOf.keyOf(row);
    const current = groups.get(key) ?? {
      key,
      label: dimensionOf.labelOf(row),
      sublabel: dimensionOf.sublabelOf(row),
      brandId: dimensionOf.brandIdOf(row),
      ...emptyAggregate(),
    };
    accumulate(current, row, currencyOf);
    groups.set(key, current);
  }
  const totalTokens = totalOf(groups, (entry) => entry.tokens);
  const totalCost = totalOf(groups, (entry) => entry.cost);
  return [...groups.values()].map((entry) => ({
    ...entry,
    tokenShare: totalTokens > 0 ? entry.tokens / totalTokens : 0,
    costShare: totalCost > 0 ? entry.cost / totalCost : 0,
  })).sort((a, b) => b.tokens - a.tokens || b.cost - a.cost || a.label.localeCompare(b.label));
}

export type CrossMatrixCell = {
  tokens: number;
  cost: number;
  costByCurrency: Record<string, number>;
  level: HeatLevel;
};

export type CrossMatrixAxisEntry = {
  key: string;
  label: string;
  /** 矩阵列头用的紧凑标签（如渠道账号只显示账号名）。 */
  shortLabel: string;
  brandId: string | null;
  total: number;
};

export type CrossMatrix = {
  /** 与主维度排行完全一致的行（含未进入 Top 列覆盖的行）。 */
  rowKeys: string[];
  /** 次维度 Top N 列（按当前指标降序）。 */
  columns: CrossMatrixAxisEntry[];
  cells: Map<string, CrossMatrixCell>;
  scale: HeatLevelScale;
  /** 次维度去重后的总列数（可能多于实际展示的 Top N 列）。 */
  columnCount: number;
  /** 列方向 Top N 覆盖的指标总量占比（0–1）。 */
  columnCoverage: number;
};

export function buildCrossMatrix(
  rows: UsageSummaryRow[],
  primary: ConsumptionDimension,
  metric: ConsumptionMetric,
  currencyOf?: CostCurrencyLookup,
  maxColumns: number = CROSS_MATRIX_MAX_COLS,
): CrossMatrix {
  const primaryOf = dimensionSelectors(primary);
  const secondaryOf = primary === "model" ? dimensionSelectors("account") : dimensionSelectors("model");

  type CellAccumulator = { tokens: number; cost: number; costByCurrency: Record<string, number> };
  const cellsByKey = new Map<string, CellAccumulator>();
  const rowTotals = new Map<string, number>();
  const columnTotals = new Map<string, CrossMatrixAxisEntry>();
  let grandTotal = 0;

  const metricOf = (row: UsageSummaryRow) => (metric === "tokens" ? finite(row.known_tokens) : finite(row.estimated_cost));

  for (const row of rows) {
    const rowKey = primaryOf.keyOf(row);
    const colKey = secondaryOf.keyOf(row);
    const value = metricOf(row);
    const cellKey = cellId(rowKey, colKey);
    const cell = cellsByKey.get(cellKey) ?? { tokens: 0, cost: 0, costByCurrency: {} };
    cell.tokens += finite(row.known_tokens);
    cell.cost += finite(row.estimated_cost);
    if (currencyOf) {
      const cost = finite(row.estimated_cost);
      if (cost > 0) {
        const currency = currencyOf(row) ?? "";
        cell.costByCurrency[currency] = (cell.costByCurrency[currency] ?? 0) + cost;
      }
    }
    cellsByKey.set(cellKey, cell);
    rowTotals.set(rowKey, (rowTotals.get(rowKey) ?? 0) + value);
    grandTotal += value;

    const column = columnTotals.get(colKey) ?? {
      key: colKey,
      label: secondaryOf.labelOf(row),
      shortLabel: secondaryOf.shortLabelOf(row),
      brandId: secondaryOf.brandIdOf(row),
      total: 0,
    };
    column.total += value;
    columnTotals.set(colKey, column);
  }

  const columns = [...columnTotals.values()]
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
    .slice(0, maxColumns);
  const covered = columns.reduce((sum, column) => sum + column.total, 0);

  const scale = createHeatLevelScale([...cellsByKey.values()].map((cell) => (metric === "tokens" ? cell.tokens : cell.cost)));
  const cells = new Map<string, CrossMatrixCell>(
    [...cellsByKey.entries()].map(([key, cell]) => [
      key,
      { ...cell, level: scale.levelFor(metric === "tokens" ? cell.tokens : cell.cost) },
    ]),
  );

  return {
    rowKeys: [...rowTotals.keys()],
    columns,
    cells,
    scale,
    columnCount: columnTotals.size,
    columnCoverage: grandTotal > 0 ? covered / grandTotal : 0,
  };
}

export function cellId(rowKey: string, colKey: string) {
  return `${rowKey}::${colKey}`;
}

/** 主维度 → 次维度（交叉矩阵的另一轴）：模型交叉渠道账号，其余交叉模型。 */
export function secondaryDimensionOf(primary: ConsumptionDimension): ConsumptionDimension {
  return primary === "model" ? "account" : "model";
}

type DimensionSelectors = {
  keyOf: (row: UsageSummaryRow) => string;
  labelOf: (row: UsageSummaryRow) => string;
  /** 交叉矩阵列头用的紧凑标签。 */
  shortLabelOf: (row: UsageSummaryRow) => string;
  sublabelOf: (row: UsageSummaryRow) => string | null;
  brandIdOf: (row: UsageSummaryRow) => string | null;
};

function dimensionSelectors(dimension: ConsumptionDimension): DimensionSelectors {
  if (dimension === "model") {
    return {
      keyOf: (row) => (canonicalModelId(row.upstream_model) ?? row.upstream_model?.trim() ?? "unknown-model").toLowerCase(),
      labelOf: (row) => canonicalModelId(row.upstream_model) ?? row.upstream_model ?? "未知模型",
      shortLabelOf: (row) => canonicalModelId(row.upstream_model) ?? row.upstream_model ?? "未知模型",
      sublabelOf: (row) => row.channel_name ?? row.channel_id ?? null,
      brandIdOf: (row) => officialChannelIdForModel(row.upstream_model) ?? row.channel_id ?? null,
    };
  }
  if (dimension === "account") {
    return {
      keyOf: (row) => {
        const channel = row.channel_id?.trim() || "unknown-channel";
        const account = row.account_id?.trim() || row.account_name?.trim() || "unknown-account";
        return `${channel}::${account}`;
      },
      labelOf: (row) => {
        const channel = row.channel_name ?? row.channel_id ?? "未知渠道";
        const account = row.account_name?.trim() || row.account_id?.trim() || null;
        return account ? `${channel} · ${account}` : channel;
      },
      shortLabelOf: (row) => row.account_name?.trim() || row.account_id?.trim() || row.channel_name || row.channel_id || "未知账号",
      sublabelOf: (row) => (row.account_name?.trim() || row.account_id?.trim() ? row.channel_name ?? row.channel_id ?? null : null),
      brandIdOf: (row) => row.channel_id ?? null,
    };
  }
  return {
    keyOf: (row) => row.client_id?.trim() || "unknown-client",
    labelOf: (row) => row.client_name?.trim() || row.client_id?.trim() || "未识别客户端",
    shortLabelOf: (row) => row.client_name?.trim() || row.client_id?.trim() || "未识别",
    sublabelOf: (row) => (row.client_name?.trim() && row.client_id?.trim() && row.client_name.trim() !== row.client_id.trim()
      ? row.client_id.trim()
      : null),
    brandIdOf: (row) => row.client_id?.trim() || null,
  };
}

function accumulate(entry: ConsumptionAggregate, row: UsageSummaryRow, currencyOf?: CostCurrencyLookup) {
  entry.tokens += finite(row.known_tokens);
  entry.inputTokens += finite(row.input_tokens);
  entry.cachedInputTokens += finite(row.input_cached_tokens);
  entry.uncachedInputTokens += finite(row.input_uncached_tokens);
  entry.cacheMeasuredInputTokens += finite(row.cache_measured_input_tokens);
  entry.outputTokens += finite(row.output_tokens);
  entry.requests += finite(row.request_count);
  entry.unknown += finite(row.unknown_count);
  const cost = finite(row.estimated_cost);
  entry.cost += cost;
  if (currencyOf && cost > 0) {
    const currency = currencyOf(row) ?? "";
    entry.costByCurrency[currency] = (entry.costByCurrency[currency] ?? 0) + cost;
  }
  entry.latencyTotalMs += finite(row.latency_total_ms);
  entry.latencyMeasured += finite(row.latency_measured_count);
}

function totalOf(groups: Map<string, ConsumptionAggregate>, valueOf: (entry: ConsumptionAggregate) => number) {
  let total = 0;
  for (const entry of groups.values()) total += valueOf(entry);
  return total;
}

function emptyAggregate(): ConsumptionAggregate {
  return {
    tokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    cacheMeasuredInputTokens: 0,
    outputTokens: 0,
    requests: 0,
    unknown: 0,
    cost: 0,
    costByCurrency: {},
    latencyTotalMs: 0,
    latencyMeasured: 0,
  };
}

function finite(value: number) {
  return Number.isFinite(value) ? value : 0;
}
