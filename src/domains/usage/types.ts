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
  /** 请求总耗时之和（ms），COALESCE(duration_ms, latency_ms)，
   *  与请求日志页「总耗时」同口径；÷ elapsed_measured_count 得平均耗时。 */
  elapsed_total_ms: number;
  /** 有总耗时记录的请求数（平均耗时分母）。 */
  elapsed_measured_count: number;
  /** 纯生成耗时之和（ms）= Σ(duration_ms − ttft_ms)，仅 duration > ttft 的流式请求。 */
  generation_total_ms: number;
  /** 计入生成速度的输出 Token（与 generation_total_ms 同一批请求）。 */
  generation_output_tokens: number;
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
