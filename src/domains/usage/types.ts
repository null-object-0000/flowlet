export type UsageSummaryRow = {
  date: string;
  client_id: string | null;
  client_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  account_id: string | null;
  account_name: string | null;
  upstream_model: string | null;
  request_count: number;
  known_tokens: number;
  input_tokens: number;
  input_cached_tokens: number;
  input_uncached_tokens: number;
  cache_measured_input_tokens: number;
  output_tokens: number;
  unknown_count: number;
  estimated_cost: number;
  /** 后端已明确的费用币种；Agent 原生行会直接返回，代理旧行可为空并由价格目录回退。 */
  estimated_cost_currency?: string | null;
  /** 未经过 Flowlet 的 Agent 原生消息级用量事件数；代理行为 0。 */
  native_event_count?: number;
  /** 请求总耗时之和（ms），COALESCE(duration_ms, latency_ms)，
   *  与请求日志页「总耗时」同口径；÷ elapsed_measured_count 得平均耗时。 */
  elapsed_total_ms: number;
  /** 有总耗时记录的请求数（平均耗时分母）。 */
  elapsed_measured_count: number;
  /** 纯生成耗时之和（ms）= Σ(duration_ms − ttft_ms)，仅 duration > ttft 的流式请求。 */
  generation_total_ms: number;
  /** 计入生成速度的输出 Token（与 generation_total_ms 同一批请求）。 */
  generation_output_tokens: number;
  /** 产生这条聚合的设备的 device_id。本机请求为当前设备（string），
   *  跨设备同步来的聚合也标记来源设备；历史未标记行兼容为 null，前端按「未知设备」归组。 */
  device_id: string | null;
};

export type UsagePeriod = "all" | "year" | "quarter" | "month" | "week" | "today";

export type UsageSummaryFilter = {
  /** UTC ISO timestamps forming a half-open range. Both null means all time. */
  startAt: string | null;
  endAt: string | null;
  groupBy: "hour" | "day";
};

export type AgentNativeCostEstimate = {
  amount: number | null;
  currency: string | null;
  sourceUrl: string | null;
  priceVersion: string | null;
  pricedTurnCount: number;
  unpricedTurnCount: number;
};

export type AgentNativeUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number | null;
  costCurrency: string | null;
  apiEquivalent?: AgentNativeCostEstimate | null;
  planConsumption?: AgentNativeCostEstimate | null;
};

export type AgentNativeUsageSummaryRow = {
  date: string;
  activityAt: string;
  agentType: string;
  sessionId: string;
  turnCount: number;
  models: string[];
  truncated: boolean;
  usage: AgentNativeUsage | null;
};

/** 概览页「今日消耗」单条聚合，与用量统计页「日 / 全部设备」口径一致。 */
export type UsageTodaySummary = {
  total_tokens: number;
  input_tokens: number;
  input_cached_tokens: number;
  input_uncached_tokens: number;
  cache_measured_input_tokens: number;
  output_tokens: number;
};
