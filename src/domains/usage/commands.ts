import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AgentNativeUsageSummaryRow, UsagePeriod, UsageSummaryRow, UsageTodaySummary } from "./types";

export const usageCommands = {
  summary: (period: UsagePeriod): Promise<UsageSummaryRow[]> =>
    invokeCommand<UsageSummaryRow[]>("usage_summary", { period }).catch(toUsageError("usage_summary_failed")),
  nativeSummary: (): Promise<AgentNativeUsageSummaryRow[]> =>
    invokeCommand<AgentNativeUsageSummaryRow[]>("agent_native_usage_summary").catch(toUsageError("agent_native_usage_summary_failed")),
  // 概览页「今日消耗」专用：拉取今日 Token 聚合（总量 + 输入/缓存/输出拆解），
  // 单条聚合行，供 service-strip 悬浮明细展示，避免每 30s 拉全量汇总表。
  // 底层走索引范围扫描、不带分组、不带 JOIN，持锁时间极短。
  todayTokens: (): Promise<UsageTodaySummary> =>
    invokeCommand<UsageTodaySummary>("usage_today_tokens").catch(toUsageError("usage_today_tokens_failed")),
};

function toUsageError(code: string) {
  return (error: unknown) => { throw toAppError(error, code); };
}
