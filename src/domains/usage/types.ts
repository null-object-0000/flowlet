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
};

export type UsagePeriod = "today" | "7d" | "month";
