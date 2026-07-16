export type DataRepairStage = "sessions" | "capturedUsage" | "unknownUsage" | "costs";

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
