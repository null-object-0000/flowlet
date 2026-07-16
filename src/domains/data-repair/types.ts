export type DataRepairStage = "sessions" | "capturedUsage" | "unknownUsage" | "costs";
export type DataRepairTimeRange = "1h" | "6h" | "today" | "7d" | "all";

export interface AgentSessionRepairResult {
  scannedRequests: number;
  repairedRequests: number;
  repairedLogs: number;
  skippedRequests: number;
}

export interface DataRepairResults {
  sessions?: AgentSessionRepairResult;
  capturedUsage?: number;
  unknownUsage?: number;
  costs?: number;
}

export interface DataRepairState {
  status: "idle" | "running" | "success" | "error";
  currentStage: DataRepairStage | null;
  completedStages: DataRepairStage[];
  percent: number;
  results: DataRepairResults;
  error: string | null;
}
