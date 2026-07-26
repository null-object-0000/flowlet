import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { UsageSummaryRow } from "./types";

export const usageCommands = {
  summary: (): Promise<UsageSummaryRow[]> =>
    invokeCommand<UsageSummaryRow[]>("usage_summary").catch(toUsageError("usage_summary_failed")),
  // 概览页「今日消耗」专用：只拉取今日 Token 总数（单个整数），避免每 30s
  // 拉全量汇总表。底层走索引范围扫描，持锁时间极短。
  todayTokens: (): Promise<number> =>
    invokeCommand<number>("usage_today_tokens").catch(toUsageError("usage_today_tokens_failed")),
};

function toUsageError(code: string) {
  return (error: unknown) => { throw toAppError(error, code); };
}
