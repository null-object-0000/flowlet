export type AgentDataSyncResult = { started: boolean; jobId: string | null; scanned: number; changed: number; failed: number; message: string };
export type CodexAccountSyncResult = { started: boolean; jobId: string | null; accounts: number; stale: number; failed: number; message: string };
export type AgentSourceSyncState = { agentType: string; lastCheckedAt: string | null; lastSyncedAt: string | null; status: string; lastError: string | null; scannedCount: number; changedCount: number; failedCount: number };
export type AgentSyncStatusReport = { running: boolean; sources: AgentSourceSyncState[] };
/** 模型目录同步结果。`source` 标识目录来源（"models-cn" / "models.dev"）。 */
export type CatalogSyncResult = { source: string; started: boolean; jobId: string | null; skipped: boolean; providerCount: number; modelCount: number; message: string };
