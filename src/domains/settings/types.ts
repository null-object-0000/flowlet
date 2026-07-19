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
