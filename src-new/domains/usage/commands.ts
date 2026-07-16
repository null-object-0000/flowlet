import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { UsageSummaryRow } from "./types";

export const usageCommands = {
  summary: (): Promise<UsageSummaryRow[]> =>
    invokeCommand<UsageSummaryRow[]>("usage_summary").catch(toUsageError("usage_summary_failed")),
  analyze: (): Promise<number> =>
    invokeCommand<number>("analyze_usage").catch(toUsageError("usage_analyze_failed")),
};

function toUsageError(code: string) {
  return (error: unknown) => { throw toAppError(error, code); };
}
