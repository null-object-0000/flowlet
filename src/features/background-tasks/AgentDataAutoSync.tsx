import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { backgroundTaskCommands } from "../../domains/background-task/commands";
import { queryKeys } from "../../shared/query-keys";

const FOREGROUND_INTERVAL = 60_000;
const BACKGROUND_INTERVAL = 5 * 60_000;
const FILE_WATCH_DEBOUNCE = 8_000;
const FILE_WATCH_COOLDOWN = 30_000;
const SCHEDULE_EVENT = "flowlet-agent-sync-scheduled";
let nextScheduledAt: number | null = null;

export function getNextAgentSyncAt() { return nextScheduledAt; }

export function AgentDataAutoSync() {
  const client = useQueryClient();
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let running = false;
    let pendingTrigger: string | undefined;
    let lastWatchSyncAt = 0;
    const publishSchedule = (value: number | null) => { nextScheduledAt = value; window.dispatchEvent(new CustomEvent(SCHEDULE_EVENT, { detail: value })); };
    const schedule = (delay: number, triggerSource?: string) => {
      window.clearTimeout(timer);
      publishSchedule(Date.now() + delay);
      timer = window.setTimeout(() => void run(triggerSource), delay);
    };
    const run = async (triggerSource = document.hidden ? "background" : "foreground") => {
      if (stopped) return;
      // 文件事件、恢复前台和周期检查共用一个执行槽，慢扫描期间只保留一次补查。
      if (running) { pendingTrigger = triggerSource; return; }
      running = true;
      if (triggerSource === "file-watch") lastWatchSyncAt = Date.now();
      window.clearTimeout(timer);
      publishSchedule(null);
      try {
        const result = await backgroundTaskCommands.syncAgentData(false, triggerSource);
        // deviceSync：原生用量账本（agent_usage_events）更新后，用量页热力图/统计卡需要重取。
        if (result.started && !stopped) await Promise.all([
          client.invalidateQueries({ queryKey: queryKeys.agentSession.all }),
          client.invalidateQueries({ queryKey: queryKeys.backgroundTask.all }),
          client.invalidateQueries({ queryKey: queryKeys.deviceSync.all }),
        ]);
      }
      catch { /* 自动检查失败不打断应用，下一轮继续。 */ }
      running = false;
      if (!stopped) {
        const followUp = pendingTrigger;
        pendingTrigger = undefined;
        schedule(followUp ? 1_000 : document.hidden ? BACKGROUND_INTERVAL : FOREGROUND_INTERVAL, followUp);
      }
    };
    schedule(3_000);
    const onVisibility = () => {
      if (running) {
        if (!document.hidden) pendingTrigger = "foreground";
        return;
      }
      // 隐藏后立即降频，避免前台定时器在托盘中仍提前唤醒一次。
      schedule(document.hidden ? BACKGROUND_INTERVAL : 1_000);
    };
    document.addEventListener("visibilitychange", onVisibility);
    let watchTimer: number | undefined;
    const flushWatchChange = () => {
      if (stopped) return;
      const remaining = FILE_WATCH_COOLDOWN - (Date.now() - lastWatchSyncAt);
      // 等待期间可能执行过一次补查，以实际扫描开始时间重新核对冷却期。
      if (remaining > 0) {
        watchTimer = window.setTimeout(flushWatchChange, remaining);
        return;
      }
      void run("file-watch");
    };
    const unlisten = listen("agent-source-changed", () => {
      if (stopped) return;
      if (watchTimer) window.clearTimeout(watchTimer);
      watchTimer = window.setTimeout(flushWatchChange,
        Math.max(FILE_WATCH_DEBOUNCE, FILE_WATCH_COOLDOWN - (Date.now() - lastWatchSyncAt)));
    }).catch(() => () => undefined);
    return () => { stopped = true; publishSchedule(null); if (timer) window.clearTimeout(timer); if (watchTimer) window.clearTimeout(watchTimer); document.removeEventListener("visibilitychange", onVisibility); void unlisten.then((dispose) => dispose()); };
  }, [client]);
  return null;
}

export const AGENT_SYNC_SCHEDULE_EVENT = SCHEDULE_EVENT;
