import { statSync, watch } from "node:fs";
import type { AgentSourceRoot } from "../../flowlet-core/src/agent/sessions/source-roots.ts";

type WatchHandle = { close(): void };

/** Main-process-only read watcher. Paths come from compiled core adapters, never renderer IPC. */
export function startAgentSourceWatcher(deps: {
  discover: () => AgentSourceRoot[];
  emit: () => void;
  warn: (message: string, detail?: unknown) => void;
  isDirectory?: (path: string) => boolean;
  watchDirectory?: (root: AgentSourceRoot, changed: () => void, failed: (error: Error) => void) => WatchHandle;
}) {
  const watchers = new Map<string, WatchHandle>();
  let closed = false;
  const isDirectory = deps.isDirectory ?? ((path: string) => {
    try { return statSync(path).isDirectory(); } catch { return false; }
  });
  const watchDirectory = deps.watchDirectory ?? ((root, changed, failed) => {
    const watcher = watch(root.path, { recursive: root.recursive, persistent: false }, changed);
    watcher.on("error", failed);
    return watcher;
  });
  const refresh = (): void => {
    if (closed) return;
    let roots: AgentSourceRoot[];
    try { roots = deps.discover(); }
    catch (error) { deps.warn("Agent 会话源发现失败，周期同步仍可用", { error: String(error) }); return; }
    for (const root of roots) {
      if (watchers.has(root.path) || !isDirectory(root.path)) continue;
      try {
        const watcher = watchDirectory(root, () => {
          if (!closed) deps.emit();
        }, (error) => {
          watchers.get(root.path)?.close();
          watchers.delete(root.path);
          deps.warn("Agent 会话源监听中断，将重试；周期同步仍可用", { path: root.path, error: error.message });
        });
        watchers.set(root.path, watcher);
      } catch (error) {
        deps.warn("无法监听 Agent 会话源，将重试；周期同步仍可用", { path: root.path, error: String(error) });
      }
    }
  };
  refresh();
  const timer = setInterval(refresh, 60_000);
  timer.unref();
  return {
    refresh,
    close(): void {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
