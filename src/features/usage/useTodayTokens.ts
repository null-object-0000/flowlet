import { useQuery } from "@tanstack/react-query";
import type { UsageTodaySummary } from "../../domains/usage/types";
import { usageCommands } from "../../domains/usage/commands";
import { queryKeys } from "../../shared/query-keys";

/**
 * 概览页顶部「今日消耗」专用。
 *
 * 拉取与用量统计页「日 / 全部设备」同口径的单条聚合，30s 自动刷新。
 * 后端只读取今日数据，避免像 `useUsageSummary` 一样轮询整段历史；无消耗时为 null。
 */
export function useTodayTokens(autoRefresh: boolean) {
  const query = useQuery({
    queryKey: queryKeys.usage.todayTokens(),
    queryFn: usageCommands.todayTokens,
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
    refetchInterval: autoRefresh ? 30_000 : false,
  });
  const data = query.data ?? null;
  const summary: UsageTodaySummary | null = data && data.total_tokens > 0 ? data : null;
  return { query, summary };
}
