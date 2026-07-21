export type RequestLogStatusFilter = "all" | "success" | "error";
export type RequestLogTimeRange = "1h" | "6h" | "today" | "7d" | "all";
/** 模型筛选来源维度：对外模型（public/virtual）或路由目标模型（upstream）。 */
export type RequestLogModelKind = "public" | "upstream";

export type RequestLogFilter = {
  page: number;
  pageSize: number;
  status: RequestLogStatusFilter;
  clientId: string;
  channelId: string;
  search: string;
  timeRange: RequestLogTimeRange;
  model: string;
  /** 所选模型的来源分组；空串表示未按模型筛选（或兼容旧行为的 OR 匹配）。 */
  modelKind: "" | RequestLogModelKind;
};

export type RequestLogRow = {
  id: string;
  request_id: string;
  client_id: string | null;
  client_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  account_id: string | null;
  account_name: string | null;
  client_protocol: string;
  upstream_protocol: string;
  virtual_model: string | null;
  public_model: string | null;
  upstream_model: string | null;
  request_type: string;
  method: string;
  path: string;
  upstream_url: string | null;
  status: number | null;
  latency_ms: number | null;
  is_stream: boolean;
  error_message: string | null;
  fallback_count: number;
  route_reason: string | null;
  created_at: string;
  ttfb_ms: number | null;
  ttft_ms: number | null;
  duration_ms: number | null;
  attempt_seq: number;
  req_headers_json: string | null;
  req_body_b64: string | null;
  res_headers_json: string | null;
  res_body_b64: string | null;
  is_last_attempt: boolean;
  input_tokens: number | null;
  input_cached_tokens: number | null;
  input_uncached_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost: number | null;
};

export type RequestLogSummary = {
  requestCount: number;
  successCount: number;
  errorCount: number;
  averageDurationMs: number | null;
  averageTtftMs: number | null;
  averageOutputTokensPerSecond: number | null;
  knownTokens: number;
  inputTokens: number;
  inputCachedTokens: number;
  inputUncachedTokens: number;
  cacheHitRate: number | null;
  estimatedCost: number;
};

export type RequestLogPage = {
  rows: RequestLogRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: RequestLogSummary;
};

export type RequestLogClient = { id: string; name: string };

export type RequestLogModelOptions = {
  /** 对外模型（public/virtual_model），即客户端请求时使用的模型名。 */
  publicModels: string[];
  /** 路由目标模型（upstream_model），即实际被转发到上游的模型名。 */
  upstreamModels: string[];
};

export const DEFAULT_REQUEST_LOG_FILTER: RequestLogFilter = {
  page: 1,
  pageSize: 8,
  status: "all",
  clientId: "",
  channelId: "",
  search: "",
  timeRange: "all",
  model: "",
  modelKind: "",
};
