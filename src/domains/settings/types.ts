export interface LogCaptureConfig {
  capture_req_headers: boolean;
  capture_req_body: boolean;
  capture_res_headers: boolean;
  capture_res_body: boolean;
  max_body_bytes: number;
  redact_sensitive_headers: boolean;
  body_retention_days: number;
  body_max_size_mb: number;
  body_prune_ratio: number;
}

export type StorageUsageCategoryKey =
  | "configuration"
  | "requestLogs"
  | "bodyData"
  | "usage"
  | "agentSessions"
  | "backgroundTasks";

export interface StorageUsageCategory {
  key: StorageUsageCategoryKey;
  rowCount: number;
  allocatedBytes: number;
}

export interface StorageUsageSummary {
  totalBytes: number;
  databaseBytes: number;
  reclaimableBytes: number;
  autoVacuumMode: number;
  walBytes: number;
  sharedMemoryBytes: number;
  configBytes: number;
  categorizedBytes: number;
  categories: StorageUsageCategory[];
}

export interface DatabaseMaintenanceStats {
  databaseBytes: number;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  reclaimableBytes: number;
  autoVacuumMode: number;
}

export interface DatabaseCompactionResult {
  before: DatabaseMaintenanceStats;
  after: DatabaseMaintenanceStats;
  reclaimedBytes: number;
}

/** One entry of `channels_config.model_prices` in config.json — only the
 *  fields the frontend needs: which currency a model's estimated cost is
 *  denominated in (e.g. CNY / USD / CREDITS). */
export interface ModelPriceCurrencyEntry {
  channel_id: string;
  upstream_model: string;
  currency: string | null;
}

/** 单个输入长度价格档位，对齐 Rust `ModelPriceTier`
 *  （src-tauri/src/core/config.rs）。`up_to_input_tokens` 为总输入 Token 的
 *  闭区间上限，`null` 表示无上限兜底档；各价格为该档内每 unit 单价。 */
export interface ModelPriceTierInfo {
  up_to_input_tokens: number | null;
  input_uncached_price: number;
  input_cached_price: number;
  input_cache_write_price?: number | null;
  output_price: number;
}

/** One entry of `channels_config.model_prices` in config.json — the pricing
 *  fields the model-service detail panel displays. Mirrors Rust `ModelPrice`
 *  (src-tauri/src/core/config.rs) minus id/timestamps the UI never shows. */
export interface ModelPriceInfo {
  channel_id: string;
  upstream_model: string;
  input_uncached_price: number;
  input_cached_price: number;
  input_cache_write_price?: number | null;
  output_price: number;
  tiers: ModelPriceTierInfo[];
  currency: string;
  unit: string;
  source_url?: string | null;
  price_version?: string | null;
}
