import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AgentSessionRepairResult, DataRepairTimeRange } from "./types";

export const dataRepairCommands = {
  repairSessions: (timeRange: DataRepairTimeRange): Promise<AgentSessionRepairResult> =>
    invokeCommand<AgentSessionRepairResult>("repair_opencode_sessions", { timeRange }).catch(toRepairError("session_repair_failed")),
  repairCapturedUsage: (timeRange: DataRepairTimeRange): Promise<number> =>
    invokeCommand<number>("repair_captured_usage", { timeRange }).catch(toRepairError("captured_usage_repair_failed")),
  repairUnknownUsage: (timeRange: DataRepairTimeRange): Promise<number> =>
    invokeCommand<number>("repair_unknown_usage", { timeRange }).catch(toRepairError("unknown_usage_repair_failed")),
  repairCosts: (timeRange: DataRepairTimeRange): Promise<number> =>
    invokeCommand<number>("repair_usage_costs", { timeRange }).catch(toRepairError("usage_cost_repair_failed")),
};

function toRepairError(code: string) {
  return (error: unknown) => { throw toAppError(error, code); };
}
