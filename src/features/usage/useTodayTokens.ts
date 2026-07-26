import { useQuery } from "@tanstack/react-query";
import { usageCommands } from "../../domains/usage/commands";
import { queryKeys } from "../../shared/query-keys";

/**
 * 概览页顶部「今日消耗」专用。
 *
 * 只拉取今日 Token 消耗总量（单个整数），30s 自动刷新。底层命令走索引
 * 范围扫描、不带分组、不带 JOIN，持锁时间极短，不会像 `useUsageSummary`
 * 拉全量汇总表那样卡住窗口拖动。返回值：有消耗时为正整数，无数据时为 null。
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
  const tokens = query.data ?? null;
  return { query, tokens: tokens && tokens > 0 ? tokens : null };
}
