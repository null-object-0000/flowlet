import { useQuery } from "@tanstack/react-query";
import type { UsageTodaySummary } from "../../domains/usage/types";
import { usageCommands } from "../../domains/usage/commands";
import { queryKeys } from "../../shared/query-keys";

/**
 * 概览页顶部「今日消耗」专用。
 *
 * 拉取今日 Token 聚合（总量 + 输入/缓存/输出拆解，单条聚合行），30s 自动
 * 刷新。底层命令走索引范围扫描、不带分组、不带 JOIN，持锁时间极短，不会
 * 像 `useUsageSummary` 拉全量汇总表那样卡住窗口拖动。返回的 `summary`
 * 同时供 service-strip 展示总消耗数与悬浮拆解明细；无消耗时为 null。
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
