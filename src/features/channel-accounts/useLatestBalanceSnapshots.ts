import { useQuery } from "@tanstack/react-query";
import { accountCommands } from "../../domains/account/commands";
import { queryKeys } from "../../shared/query-keys";

/**
 * 读取各账号最新余额快照。
 *
 * `refetchIntervalMs` 仅供由服务端周期同步余额的宿主（Web/Docker）开启轮询；
 * 桌面端由 `ChannelResourceAutoSync` 在每轮同步后显式失效查询，不需要轮询。
 */
export function useLatestBalanceSnapshots(
  enabled: boolean,
  refetchIntervalMs?: number,
) {
  return useQuery({
    queryKey: queryKeys.usage.latestBalanceSnapshots(),
    queryFn: () => accountCommands.latestBalanceSnapshots(),
    enabled,
    networkMode: "always",
    refetchOnWindowFocus: false,
    refetchInterval: enabled ? refetchIntervalMs : false,
    retry: false,
  });
}
