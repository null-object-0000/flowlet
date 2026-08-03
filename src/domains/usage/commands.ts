import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AgentNativeUsageSummaryRow, UsageSummaryFilter, UsageSummaryRow, UsageTodaySummary } from "./types";

export const usageCommands = {
  summary: (filter: UsageSummaryFilter): Promise<UsageSummaryRow[]> =>
    invokeCommand<UsageSummaryRow[]>("usage_summary", {
      startAt: filter.startAt,
      endAt: filter.endAt,
      groupBy: filter.groupBy,
    }).catch(toUsageError("usage_summary_failed")),
  nativeSummary: (): Promise<AgentNativeUsageSummaryRow[]> =>
    invokeCommand<AgentNativeUsageSummaryRow[]>("agent_native_usage_summary").catch(toUsageError("agent_native_usage_summary_failed")),
  // 概览页「今日消耗」专用：单条聚合，本机代理、本机 Agent 原生用量和
  // 其他设备日快照与用量统计页「日 / 全部设备」保持同一口径。
  todayTokens: (): Promise<UsageTodaySummary> =>
    invokeCommand<UsageTodaySummary>("usage_today_tokens").catch(toUsageError("usage_today_tokens_failed")),
};

function toUsageError(code: string) {
  return (error: unknown) => { throw toAppError(error, code); };
}
