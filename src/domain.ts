export type ProtocolType = "openai" | "anthropic";
export type FlowletTier = "pro" | "flash" | "none";
export type AuthStrategy = "bearer" | "x_api_key";
export type AccountResourceMode = "token_pack" | "pay_as_you_go";

// 模型开放范围（需求三）：全部开放（默认）/ 仅 Flowlet 模型 / 自定义。
export type ModelExposureMode = "all" | "flowlet_only" | "custom";

export type ProxyStatus = {
  running: boolean;
  bind_addr: string;
  /** 代理进程的真实启动时间（RFC3339），未运行时为 null。 */
  started_at?: string | null;
};


export type ProxyBindConfig = {
  host: string;
  port: number;
  allow_lan: boolean;
};
export type ChannelPreset = {
  id: string;
  name: string;
  vendor: string;
  supported_protocols: ProtocolType[];
  openai_base_url: string;
  anthropic_base_url: string;
  openai_auth: AuthStrategy;
  anthropic_auth: AuthStrategy;
  default_model: string;
  supports_model_list: boolean;
  supports_balance_query: boolean;
  small_model: string | null;
  created_at: string;
  updated_at: string;
};

export type ChannelAccount = {
  id: string;
  channel_id: string;
  name: string;
  api_key: string;
  enabled: boolean;
  priority: number;
  remark?: string;
  resource_mode?: AccountResourceMode | null;
  base_url_override?: string | null;
  last_used_at?: string;
  last_error?: string;
  // "healthy" 表示可参与路由；"invalid_key" 表示上游最近返回 401，应从候选池排除
  credential_status: "healthy" | "invalid_key";
  created_at: string;
  updated_at: string;
};

export type RouteCandidate = {
  id: string;
  virtual_model_id: string;
  channel_id: string;
  account_id: string;
  upstream_model: string;
  client_protocol: ProtocolType;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type ClientConfig = {
  id: string;
  name: string;
  token: string;
  app_type: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type ModelPrice = {
  id: string;
  channel_id: string;
  upstream_model: string;
  input_uncached_price: number;
  input_cached_price: number;
  output_price: number;
  currency: string;
  unit: string;
  source: string;
  synced_at?: string;
  created_at: string;
  updated_at: string;
};

export type VirtualModel = {
  id: string;
  name: string;
  protocol_type: ProtocolType;
  routing_strategy: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

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
  unknown_count: number;
  estimated_cost: number;
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
  status: number | null;
  latency_ms: number | null;
  is_stream: boolean;
  error_message: string | null;
  fallback_count: number;
  route_reason: string | null;
  created_at: string;
  ttfb_ms: number | null;
  duration_ms: number | null;
  attempt_seq: number;
  req_headers_json: string | null;
  req_body_b64: string | null;
  res_headers_json: string | null;
  res_body_b64: string | null;
  stream_summary: string | null;
  is_last_attempt: boolean;
};

export type LogFilter = {
  page: number;        // 1-based
  pageSize: number;
  status: "all" | "success" | "error";
  client: string;      // "" = 不过滤
  channel: string;     // "" = 不过滤
  search: string;      // 模糊匹配 path / request_id / error_message
};

export type LogPage = {
  rows: RequestLogRow[];
  total: number;
  page: number;        // 1-based
  pageSize: number;
};

export type LogMeta = {
  total: number;
  page: number;
  pageSize: number;
  lastFetchedAt: number; // 用于判断是否脏
};

export type LogCaptureConfig = {
  capture_req_headers: boolean;
  capture_req_body: boolean;
  capture_res_headers: boolean;
  capture_res_body: boolean;
  stream_summary_max_bytes: number;
  max_body_bytes: number;
  /** 默认 false（不脱敏），true 时敏感 Header 替换为 [redacted] */
  redact_sensitive_headers?: boolean;
};

export type ChannelModel = {
  id: string;
  channel_id: string;
  model: string;
  display_name?: string | null;
  supported_protocols: ProtocolType[];
  context_window?: number | null;
  max_output_tokens?: number | null;
  supports_stream: boolean;
  enabled: boolean;
  source: string;
  synced_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type AccountBalanceSnapshot = {
  id: string;
  account_id: string;
  balance: number | null;
  currency: string | null;
  token_pack_total: number | null;
  token_pack_used: number | null;
  token_pack_remaining: number | null;
  token_pack_expire_at: string | null;
  source: string;
  synced_at: string | null;
  remark: string | null;
  created_at: string;
  updated_at: string;
};

export type RouteRule = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match_client_id: string | null;
  match_model: string | null;
  match_protocol: ProtocolType | null;
  target_channel_id: string;
  target_account_id: string;
  target_upstream_model: string;
  created_at: string;
  updated_at: string;
};

export type AccountStatsRow = {
  account_id: string;
  account_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  total_requests: number;
  success_requests: number;
  failed_requests: number;
  failure_rate: number;
  total_fallbacks: number;
  known_tokens: number;
  estimated_cost: number;
  last_error: string | null;
  last_error_at: string | null;
  last_used_at: string | null;
};

export type View =
  | "overview"
  | "routes"
  | "accounts"
  | "logs"
  | "usage"
  | "stats";

export const views: Array<{ id: View; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "routes", label: "模型服务" },
  { id: "accounts", label: "渠道账号" },
  { id: "logs", label: "请求日志" },
  { id: "usage", label: "用量成本" },
  { id: "stats", label: "高级设置" },
];

export const protocolLabels: Record<ProtocolType, string> = {
  openai: "OpenAI-compatible",
  anthropic: "Anthropic-compatible",
};

export const defaultExposedModelsByChannel: Record<string, string[]> = {
  longcat: ["LongCat-2.0"],
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
};

export const flowletPublicModels = {
  pro: { id: "flowlet-pro", name: "Flowlet Pro", description: "高质量，适合复杂任务" },
  flash: { id: "flowlet-flash", name: "Flowlet Flash", description: "响应快，适合日常任务" },
} as const;

// 档位映射按渠道维护：channel_id + upstream_model → tier。
// 未知组合默认 "none"（不参与聚合池，但仍可作为直接模型开放）。
// 禁止通过 model 名称猜测（includes("pro")/includes("flash")）判定档位。
const defaultFlowletTierByChannel: Record<string, Record<string, FlowletTier>> = {
  deepseek: {
    "deepseek-v4-pro": "pro",
    "deepseek-v4-flash": "flash",
  },
  longcat: {
    "longcat-2.0": "pro",
  },
};

export function getFlowletTier(channelId: string, model: string): FlowletTier {
  const normalized = model.trim().toLowerCase();
  return defaultFlowletTierByChannel[channelId]?.[normalized] ?? "none";
}

export function flowletModelIdForTier(tier: FlowletTier): string | null {
  return tier === "pro" ? flowletPublicModels.pro.id : tier === "flash" ? flowletPublicModels.flash.id : null;
}
export function getDefaultExposedModels(channel: ChannelPreset): string[] {
  return defaultExposedModelsByChannel[channel.id] ?? [channel.default_model].filter(Boolean);
}

export function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createAccount(channelId: string, index: number): ChannelAccount {
  const now = new Date().toISOString();
  return {
    id: genId("account"),
    channel_id: channelId,
    name: `账号 ${index + 1}`,
    api_key: "",
    enabled: true,
    priority: index,
    remark: "",
    resource_mode: channelId === "longcat" ? "token_pack" : "pay_as_you_go",
    base_url_override: null,
    last_used_at: undefined,
    last_error: undefined,
    credential_status: "healthy",
    created_at: now,
    updated_at: now,
  };
}

export function createClient(_index?: number): ClientConfig {
  const now = new Date().toISOString();
  return {
    id: genId("client"),
    name: "新客户端",
    token: `flowlet-${genId("token").slice(-12)}`,
    app_type: "custom",
    enabled: true,
    created_at: now,
    updated_at: now,
  };
}

export function createModelPrice(channelId: string, _index?: number): ModelPrice {
  const now = new Date().toISOString();
  return {
    id: genId("price"),
    channel_id: channelId,
    upstream_model: "",
    input_uncached_price: 0,
    input_cached_price: 0,
    output_price: 0,
    currency: "USD",
    unit: "1M tokens",
    source: "preset",
    synced_at: undefined,
    created_at: now,
    updated_at: now,
  };
}

export function createRouteCandidate(
  virtualModelId: string,
  channelId: string,
  accountId: string,
  upstreamModel: string,
  protocol: ProtocolType,
  priority: number
): RouteCandidate {
  const now = new Date().toISOString();
  return {
    id: genId("route"),
    virtual_model_id: virtualModelId,
    channel_id: channelId,
    account_id: accountId,
    upstream_model: upstreamModel,
    client_protocol: protocol,
    priority,
    enabled: true,
    created_at: now,
    updated_at: now,
  };
}

