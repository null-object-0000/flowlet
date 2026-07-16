import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AgentSessionRepairResult } from "./types";

export const dataRepairCommands = {
  repairSessions: (): Promise<AgentSessionRepairResult> =>
    invokeCommand<AgentSessionRepairResult>("repair_opencode_sessions").catch(toRepairError("session_repair_failed")),
  repairCapturedUsage: (): Promise<number> =>
    invokeCommand<number>("repair_captured_usage").catch(toRepairError("captured_usage_repair_failed")),
  repairUnknownUsage: (): Promise<number> =>
    invokeCommand<number>("repair_unknown_usage").catch(toRepairError("unknown_usage_repair_failed")),
  repairCosts: (): Promise<number> =>
    invokeCommand<number>("repair_usage_costs").catch(toRepairError("usage_cost_repair_failed")),
};

function toRepairError(code: string) {
  return (error: unknown) => { throw toAppError(error, code); };
}
