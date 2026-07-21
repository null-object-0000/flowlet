import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { backgroundTaskCommands } from "../../domains/background-task/commands";
import { queryKeys } from "../../shared/query-keys";

/**
 * Codex 账号与用量的周期性后台同步。
 *
 * - 用量窗口本身是 5 小时 / 周级粒度，5 分钟刷新一次足够新鲜，
 *   也避免高频调用官方用量接口与 Codex app-server 进程；
 * - 每轮同步由 Rust 记入任务日志（job_type = codex-account-sync）；
 * - 未发现任何 Codex 账号时 Rust 直接跳过，不创建任务、不发起网络请求。
 */
const SYNC_INTERVAL = 5 * 60_000;
const FIRST_SYNC_DELAY = 20_000;

export function CodexAccountAutoSync() {
  const client = useQueryClient();
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const schedule = (delay: number) => { timer = window.setTimeout(run, delay); };
    const run = async (triggerSource = document.hidden ? "background" : "foreground") => {
      try {
        const result = await backgroundTaskCommands.syncCodexAccounts(triggerSource);
        if (result.started) await Promise.all([client.invalidateQueries({ queryKey: queryKeys.agent.codexAccount() }), client.invalidateQueries({ queryKey: queryKeys.backgroundTask.all })]);
      }
      catch { /* 自动同步失败不打断应用，下一轮继续。 */ }
      if (!stopped) schedule(SYNC_INTERVAL);
    };
    schedule(FIRST_SYNC_DELAY);
    return () => { stopped = true; if (timer) window.clearTimeout(timer); };
  }, [client]);
  return null;
}
