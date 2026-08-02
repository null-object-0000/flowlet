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
  /** 有延迟记录的请求总耗时（ms）；与 latency_measured_count 搭配计算
   *  平均延迟与输出吞吐（output tokens / 总耗时）。 */
  latency_total_ms: number;
  /** 有延迟记录的请求数（平均延迟分母）。 */
  latency_measured_count: number;
};

export type UsagePeriod = "all" | "year" | "quarter" | "month" | "week" | "today";

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

/** 概览页「今日消耗」轻量聚合：单条聚合行，供 service-strip 悬浮明细展示。 */
export type UsageTodaySummary = {
  total_tokens: number;
  input_tokens: number;
  input_cached_tokens: number;
  input_uncached_tokens: number;
  cache_measured_input_tokens: number;
  output_tokens: number;
};
