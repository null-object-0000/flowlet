import { DesktopBridgeUnavailableError, requireDesktopWindowBridge } from "../desktop/bridge";
import type { ResizeDirection } from "../desktop/bridge";

export type { ResizeDirection };

/** Electron-only window capabilities. Browsers never fall back to a native API. */
export const windowCommands = {
  startDragging: async (): Promise<void> => {
    const bridge = requireDesktopWindowBridge();
    if (bridge.startDragging) return bridge.startDragging();
    throw new DesktopBridgeUnavailableError("标题栏拖动由 -webkit-app-region: drag 处理");
  },
  startResizeDragging: async (direction: ResizeDirection): Promise<void> => {
    const bridge = requireDesktopWindowBridge();
    if (bridge.startResizeDragging) return bridge.startResizeDragging(direction);
    throw new DesktopBridgeUnavailableError("缩放热区需要 window.flowletDesktop.window.resizeBegin");
  },
  minimize: async (): Promise<void> => requireDesktopWindowBridge().minimize(),
  isMaximized: async (): Promise<boolean> => requireDesktopWindowBridge().isMaximized(),
  onResized: async (handler: () => void): Promise<() => void> =>
    requireDesktopWindowBridge().onMaximizedChanged(() => handler()),
  toggleMaximize: async (): Promise<void> => requireDesktopWindowBridge().toggleMaximize(),
  close: async (): Promise<void> => requireDesktopWindowBridge().close(),
};
