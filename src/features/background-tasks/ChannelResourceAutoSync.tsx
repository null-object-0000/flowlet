import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { accountCommands } from "../../domains/account/commands";
import { queryKeys } from "../../shared/query-keys";

export const CHANNEL_RESOURCE_SYNC_INTERVAL_MS = 5 * 60_000;
const FIRST_SYNC_DELAY = 30_000;

/**
 * 周期同步渠道资源信息。Rust 会按账号能力选择官方余额 API 或隐藏 WebView，
 * 串行执行并写任务日志；后台 WebView 轮次不会弹出登录窗口。
 *
 * CHANNEL_RESOURCE_SYNC_INTERVAL_MS 同时用于概览页账号数据过期提示：
 * 自动同步账号超过两轮该周期仍未更新成功时，渠道 Logo 展示黄色 Badge dot。
 */
export function ChannelResourceAutoSync() {
  const client = useQueryClient();

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const schedule = (delay: number) => { timer = window.setTimeout(run, delay); };
    const run = async () => {
      try {
        const result = await accountCommands.syncChannelResources(document.hidden ? "background" : "foreground");
        if (result.started) {
          await Promise.all([
            client.invalidateQueries({ queryKey: queryKeys.usage.latestBalanceSnapshots() }),
            client.invalidateQueries({ queryKey: queryKeys.backgroundTask.all }),
          ]);
        }
      } catch {
        // 自动同步失败不打断应用；详细失败由 Rust 任务日志记录，下一轮继续。
      }
      if (!stopped) schedule(CHANNEL_RESOURCE_SYNC_INTERVAL_MS);
    };
    schedule(FIRST_SYNC_DELAY);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [client]);

  return null;
}
