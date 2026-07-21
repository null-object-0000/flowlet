export type StorageUsageCategoryKey =
  | "configuration"
  | "requestLogs"
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
  walBytes: number;
  sharedMemoryBytes: number;
  configBytes: number;
  categorizedBytes: number;
  categories: StorageUsageCategory[];
}

/** One entry of `channels_config.model_prices` in config.json — only the
 *  fields the frontend needs: which currency a model's estimated cost is
 *  denominated in (e.g. CNY / USD / CREDITS). */
export interface ModelPriceCurrencyEntry {
  channel_id: string;
  upstream_model: string;
  currency: string | null;
}
