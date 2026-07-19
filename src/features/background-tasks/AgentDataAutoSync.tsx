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
    const publishSchedule = (value: number | null) => { nextScheduledAt = value; window.dispatchEvent(new CustomEvent(SCHEDULE_EVENT, { detail: value })); };
    const schedule = (delay: number) => { publishSchedule(Date.now() + delay); timer = window.setTimeout(run, delay); };
    const run = async (triggerSource = document.hidden ? "background" : "foreground") => {
      publishSchedule(null);
      try {
        const result = await backgroundTaskCommands.syncAgentData(false, triggerSource);
        if (result.started) await Promise.all([client.invalidateQueries({ queryKey: queryKeys.agentSession.all }), client.invalidateQueries({ queryKey: queryKeys.backgroundTask.all })]);
      }
      catch { /* 自动检查失败不打断应用，下一轮继续。 */ }
      if (!stopped) schedule(document.hidden ? BACKGROUND_INTERVAL : FOREGROUND_INTERVAL);
    };
    schedule(3_000);
    const onVisibility = () => { if (!document.hidden) { if (timer) window.clearTimeout(timer); schedule(1_000); } };
    document.addEventListener("visibilitychange", onVisibility);
    let watchTimer: number | undefined;
    let lastWatchSyncAt = 0;
    const unlisten = listen("agent-source-changed", () => {
      if (watchTimer) window.clearTimeout(watchTimer);
      watchTimer = window.setTimeout(() => {
        const cooldownRemaining = FILE_WATCH_COOLDOWN - (Date.now() - lastWatchSyncAt);
        if (cooldownRemaining > 0) return;
        lastWatchSyncAt = Date.now();
        if (timer) window.clearTimeout(timer);
        void run("file-watch");
      }, FILE_WATCH_DEBOUNCE);
    }).catch(() => () => undefined);
    return () => { stopped = true; publishSchedule(null); if (timer) window.clearTimeout(timer); if (watchTimer) window.clearTimeout(watchTimer); document.removeEventListener("visibilitychange", onVisibility); void unlisten.then((dispose) => dispose()); };
  }, [client]);
  return null;
}

export const AGENT_SYNC_SCHEDULE_EVENT = SCHEDULE_EVENT;
