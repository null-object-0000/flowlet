/**
 * 用量洞察页「多维归因」模块的纯展示层聚合。
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

/**
 * agent-native 是后端固定的伪渠道，承载未经过 Flowlet 的 Agent 原生会话用量。
 * 后端 `channel_name` 为「Agent 原生（未经过 Flowlet）」，若直接按
 * `${channel} · ${account}` 拼接，会得到「Agent 原生（未经过 Flowlet） · Codex Desktop」：
 * 渠道名前置且主副标题重复。这里把渠道简写与补充说明拆开，label 让账号名在前。
 */
const AGENT_NATIVE_CHANNEL_ID = "agent-native";
const AGENT_NATIVE_CHANNEL_LABEL = "Agent 原生";
const AGENT_NATIVE_CHANNEL_NOTE = "未经过 Flowlet";

export type ConsumptionDimension = "model" | "account" | "client" | "device";
export type ConsumptionMetric = "tokens" | "cost";
export type CostCurrencyLookup = (row: UsageSummaryRow) => string | null;

function modelBrandId(row: UsageSummaryRow): string | null {
  const model = (canonicalModelId(row.upstream_model) ?? row.upstream_model ?? "")
    .trim()
    .toLowerCase();
  if (model.startsWith("gpt-")) return "chatgpt";
  return officialChannelIdForModel(row.upstream_model) ?? row.channel_id ?? null;
}

export function filterConsumptionByDevice(
  rows: UsageSummaryRow[],
  deviceId: string | null,
): UsageSummaryRow[] {
  return deviceId == null ? rows : rows.filter((row) => row.device_id === deviceId);
}

export type ConsumptionAggregate = {
  tokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cacheMeasuredInputTokens: number;
  outputTokens: number;
  requests: number;
  nativeEvents: number;
  unknown: number;
  cost: number;
  costByCurrency: Record<string, number>;
  /** 请求总耗时之和（ms），COALESCE(duration, latency)。 */
  elapsedTotalMs: number;
  /** 有总耗时记录的请求数。 */
  elapsedMeasured: number;
  /** 纯生成耗时之和（ms）= Σ(duration − ttft)。 */
  generationTotalMs: number;
  /** 计入生成速度的输出 Token。 */
  generationOutputTokens: number;
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

/** 平均总耗时（ms），取 COALESCE(duration, latency) 的请求均值；
 *  与请求日志页「总耗时」列同口径；没有耗时记录时为 null。 */
export function averageElapsedMsOf(aggregate: Pick<ConsumptionAggregate, "elapsedTotalMs" | "elapsedMeasured">): number | null {
  if (!(aggregate.elapsedMeasured > 0)) return null;
  return aggregate.elapsedTotalMs / aggregate.elapsedMeasured;
}

/** 输出生成速度（token/s）= 生成输出 Token ÷ 纯生成耗时（duration − ttft）。
 *  与请求日志页单条请求的 tok/s（calculateOutputTokenRate）同口径：
 *  只统计 duration > ttft 的流式请求；缺少数据时为 null。 */
export function outputTokensPerSecondOf(
  aggregate: Pick<ConsumptionAggregate, "generationTotalMs" | "generationOutputTokens">,
): number | null {
  if (!(aggregate.generationTotalMs > 0) || !(aggregate.generationOutputTokens > 0)) return null;
  return aggregate.generationOutputTokens / (aggregate.generationTotalMs / 1000);
}

export function groupConsumption(
  rows: UsageSummaryRow[],
  dimension: ConsumptionDimension,
  currencyOf?: CostCurrencyLookup,
  deviceNameOf?: (deviceId: string) => string,
): ConsumptionEntry[] {
  const dimensionOf = dimensionSelectors(dimension, deviceNameOf);
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
  /** 与主维度排行完全一致的行。 */
  rowKeys: string[];
  /** 次维度的全部列，按 Token 体量降序。 */
  columns: CrossMatrixAxisEntry[];
  cells: Map<string, CrossMatrixCell>;
  scale: HeatLevelScale;
};

export function buildCrossMatrix(
  rows: UsageSummaryRow[],
  primary: ConsumptionDimension,
  metric: ConsumptionMetric,
  currencyOf?: CostCurrencyLookup,
): CrossMatrix {
  const primaryOf = dimensionSelectors(primary);
  const secondaryOf = primary === "model" ? dimensionSelectors("account") : dimensionSelectors("model");

  type CellAccumulator = { tokens: number; cost: number; costByCurrency: Record<string, number> };
  const cellsByKey = new Map<string, CellAccumulator>();
  const rowTotals = new Map<string, number>();
  const columnTotals = new Map<string, CrossMatrixAxisEntry>();
  // 列序固定按 Token 体量排，与当前指标切换无关——避免切「预估费用」时列序跳动。
  const columnTokenTotals = new Map<string, number>();
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

    const column = columnTotals.get(colKey) ?? {
      key: colKey,
      label: secondaryOf.labelOf(row),
      shortLabel: secondaryOf.shortLabelOf(row),
      brandId: secondaryOf.brandIdOf(row),
      total: 0,
    };
    column.total += value;
    columnTotals.set(colKey, column);
    columnTokenTotals.set(colKey, (columnTokenTotals.get(colKey) ?? 0) + finite(row.known_tokens));
  }

  const columns = [...columnTotals.values()]
    .sort((a, b) => (columnTokenTotals.get(b.key) ?? 0) - (columnTokenTotals.get(a.key) ?? 0) || a.label.localeCompare(b.label));

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

function dimensionSelectors(
  dimension: ConsumptionDimension,
  deviceNameOf?: (deviceId: string) => string,
): DimensionSelectors {
  if (dimension === "model") {
    return {
      keyOf: (row) => (canonicalModelId(row.upstream_model) ?? row.upstream_model?.trim() ?? "unknown-model").toLowerCase(),
      labelOf: (row) => canonicalModelId(row.upstream_model) ?? row.upstream_model ?? "未知模型",
      shortLabelOf: (row) => canonicalModelId(row.upstream_model) ?? row.upstream_model ?? "未知模型",
      sublabelOf: (row) => row.channel_name ?? row.channel_id ?? null,
      brandIdOf: modelBrandId,
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
        // Agent 原生渠道：账号（如 Codex Desktop）在前、渠道简写在后，
        // 避免多个原生账号都以「Agent 原生（未经过 Flowlet）」前缀开头而难以区分。
        if (row.channel_id === AGENT_NATIVE_CHANNEL_ID) {
          return account ? `${account} · ${AGENT_NATIVE_CHANNEL_LABEL}` : AGENT_NATIVE_CHANNEL_LABEL;
        }
        return account ? `${channel} · ${account}` : channel;
      },
      shortLabelOf: (row) => row.account_name?.trim() || row.account_id?.trim() || row.channel_name || row.channel_id || "未知账号",
      sublabelOf: (row) => {
        // Agent 原生渠道：主标题已含「Agent 原生」，副标题只补充说明，不与主标题重复。
        if (row.channel_id === AGENT_NATIVE_CHANNEL_ID) return AGENT_NATIVE_CHANNEL_NOTE;
        return (row.account_name?.trim() || row.account_id?.trim() ? row.channel_name ?? row.channel_id ?? null : null);
      },
      brandIdOf: (row) => row.channel_id ?? null,
    };
  }
  if (dimension === "client") {
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
  // device：label 由调用方通过 deviceNameOf 解析设备展示名（来自同步的 known_devices），
  // 未匹配到时回退到 device_id 本身。
  return {
    keyOf: (row) => row.device_id?.trim() || "unknown-device",
    labelOf: (row) => {
      const id = row.device_id?.trim();
      if (!id) return "未知设备";
      return deviceNameOf?.(id) || id;
    },
    shortLabelOf: (row) => {
      const id = row.device_id?.trim();
      if (!id) return "未知";
      return deviceNameOf?.(id) || id;
    },
    sublabelOf: (row) => {
      const id = row.device_id?.trim();
      if (!id) return null;
      const name = deviceNameOf?.(id);
      return name && name !== id ? id : null;
    },
    brandIdOf: (row) => row.device_id?.trim() || null,
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
  entry.nativeEvents += finite(row.native_event_count ?? 0);
  entry.unknown += finite(row.unknown_count);
  const cost = finite(row.estimated_cost);
  entry.cost += cost;
  if (currencyOf && cost > 0) {
    const currency = currencyOf(row) ?? "";
    entry.costByCurrency[currency] = (entry.costByCurrency[currency] ?? 0) + cost;
  }
  entry.elapsedTotalMs += finite(row.elapsed_total_ms);
  entry.elapsedMeasured += finite(row.elapsed_measured_count);
  entry.generationTotalMs += finite(row.generation_total_ms);
  entry.generationOutputTokens += finite(row.generation_output_tokens);
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
    nativeEvents: 0,
    unknown: 0,
    cost: 0,
    costByCurrency: {},
    elapsedTotalMs: 0,
    elapsedMeasured: 0,
    generationTotalMs: 0,
    generationOutputTokens: 0,
  };
}

function finite(value: number) {
  return Number.isFinite(value) ? value : 0;
}
