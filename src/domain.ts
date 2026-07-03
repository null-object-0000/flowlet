export type ProtocolType = "openai" | "anthropic";
export type AuthStrategy = "bearer" | "x_api_key";

export type ProxyStatus = {
  running: boolean;
  bind_addr: string;
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
  last_used_at?: string;
  last_error?: string;
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
  | "channels"
  | "claude"
  | "clients"
  | "routes"
  | "logs"
  | "usage"
  | "stats";

export const views: Array<{ id: View; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "channels", label: "渠道账号" },
  { id: "claude", label: "Claude Code" },
  { id: "clients", label: "客户端 Token" },
  { id: "routes", label: "高级路由" },
  { id: "stats", label: "账号统计" },
  { id: "logs", label: "请求日志" },
  { id: "usage", label: "用量统计" },
];

export const protocolLabels: Record<ProtocolType, string> = {
  openai: "OpenAI-compatible",
  anthropic: "Anthropic-compatible",
};

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
    last_used_at: undefined,
    last_error: undefined,
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
