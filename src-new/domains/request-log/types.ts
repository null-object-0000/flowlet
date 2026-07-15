export type RequestLogStatusFilter = "all" | "success" | "error";

export type RequestLogFilter = {
  page: number;
  pageSize: number;
  status: RequestLogStatusFilter;
  clientId: string;
  channelId: string;
  search: string;
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
  is_last_attempt: boolean;
};

export type RequestLogPage = {
  rows: RequestLogRow[];
  total: number;
  page: number;
  pageSize: number;
};

export type RequestLogClient = { id: string; name: string };

export const DEFAULT_REQUEST_LOG_FILTER: RequestLogFilter = {
  page: 1,
  pageSize: 25,
  status: "all",
  clientId: "",
  channelId: "",
  search: "",
};
