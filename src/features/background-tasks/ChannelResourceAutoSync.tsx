import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { accountCommands } from "../../domains/account/commands";
import { queryKeys } from "../../shared/query-keys";

const SYNC_INTERVAL = 5 * 60_000;
const FIRST_SYNC_DELAY = 30_000;

/**
 * 周期同步选择了“自动同步”的渠道资源信息。Rust 会筛选符合条件的账号、
 * 串行驱动隐藏 WebView 并写任务日志；后台轮次不会弹出登录窗口。
 */
export function ChannelResourceAutoSync() {
  const client = useQueryClient();

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const schedule = (delay: number) => { timer = window.setTimeout(run, delay); };
    const run = async () => {
      try {
        const result = await accountCommands.syncScrapeBalances(document.hidden ? "background" : "foreground");
        if (result.started) {
          await Promise.all([
            client.invalidateQueries({ queryKey: queryKeys.usage.latestBalanceSnapshots() }),
            client.invalidateQueries({ queryKey: queryKeys.backgroundTask.all }),
          ]);
        }
      } catch {
        // 自动同步失败不打断应用；详细失败由 Rust 任务日志记录，下一轮继续。
      }
      if (!stopped) schedule(SYNC_INTERVAL);
    };
    schedule(FIRST_SYNC_DELAY);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [client]);

  return null;
}
