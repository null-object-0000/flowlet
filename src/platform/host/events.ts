import { DesktopBridgeUnavailableError, getDesktopBridge } from "../desktop/bridge";

export type HostEventName = "agent-source-changed" | "storage-usage-progress";

/** Browser/client modes have no local event source; HTTP results remain authoritative. */
export async function listen<T = unknown>(
  event: HostEventName,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  const bridge = getDesktopBridge();
  if (!bridge || bridge.mode === "client") return () => undefined;
  if (!bridge.events) throw new DesktopBridgeUnavailableError("window.flowletDesktop.events 未注入");
  const callback = (payload: unknown) => handler({ payload: payload as T });
  switch (event) {
    case "agent-source-changed": return bridge.events.onAgentSourceChanged(callback);
    case "storage-usage-progress": return bridge.events.onStorageUsageProgress(callback);
    default: throw new Error(`不支持的宿主事件：${String(event)}`);
  }
}
