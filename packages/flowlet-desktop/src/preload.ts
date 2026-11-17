// Electron preload：把受控的桌面桥注入渲染进程。
//
// 契约（与 src/platform/desktop/bridge.ts 对齐，且兼容 lead 约定的 resizeBegin/
// resizeEnd 与顶层 openExternal 别名）：
//   window.flowletDesktop = {
//     adminToken,
//     window: { startDragging, startResizeDragging, resizeBegin, resizeEnd,
//               minimize, toggleMaximize, isMaximized, close, onMaximizedChanged },
//     dialog / events (local Host only),
//     platform: { openExternal },
//     openExternal,
//   }
//
// 渲染进程拿不到 ipcRenderer / nodeIntegration；所有调用都经过 main 的白名单 handler。
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopDialogOptions, FlowletDesktopBridge } from "../../../src/platform/desktop/bridge";

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

interface Bootstrap {
  /** 主机模式=本机随机管理 token；客户端模式为空（远程凭据仅在 main）。 */
  adminToken: string;
  /** host / client：决定渲染进程加载桌面壳还是 Web 管理台界面。 */
  mode: "host" | "client";
  /** 客户端模式远程管理台地址（展示用）。 */
  clientBaseUrl: string;
}

const bootstrap = ipcRenderer.sendSync("desktop:bootstrap") as Bootstrap;

function attachPointerSession(moveChannel: string, endChannel: string): void {
  const onMove = (event: PointerEvent): void => {
    void ipcRenderer.invoke(moveChannel, { screenX: event.screenX, screenY: event.screenY });
  };
  const cleanup = (): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };
  const onUp = (): void => {
    cleanup();
    void ipcRenderer.invoke(endChannel);
  };
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerup", onUp, { once: true });
  window.addEventListener("pointercancel", onUp, { once: true });
}

function subscribeHostEvent(
  channel: "host:event:agent-source-changed" | "host:event:storage-usage-progress",
  listener: (payload: unknown) => void,
): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

const desktopApi = {
  adminToken: bootstrap.mode === "client" ? "" : bootstrap.adminToken,
  /** 运行模式：host = 本机 Node Host；client = 连接远程 Web Host。 */
  mode: bootstrap.mode === "client" ? "client" : "host",
  clientBaseUrl: bootstrap.clientBaseUrl,
  /** 打开「运行模式 / 连接主机」设置窗口（客户端模式设置页入口）。 */
  openModeSettings: async (): Promise<void> => {
    await ipcRenderer.invoke("mode:open-settings");
  },
  window: {
    /** 标题栏拖动。优先使用 CSS `-webkit-app-region: drag`；此方法作为 IPC 兜底。 */
    startDragging: async (): Promise<void> => {
      await ipcRenderer.invoke("window:start-dragging");
      attachPointerSession("window:drag-move", "window:drag-end");
    },
    /** 8 向缩放：pointermove/pointerup 由 preload 转发，main 用 setBounds 跟随。 */
    startResizeDragging: async (direction: ResizeDirection): Promise<void> => {
      await ipcRenderer.invoke("window:start-resize-dragging", direction);
      attachPointerSession("window:resize-move", "window:resize-end");
    },
    resizeBegin: async (payload: {
      edge?: ResizeDirection;
      direction?: ResizeDirection;
      screenX?: number;
      screenY?: number;
    }): Promise<void> => {
      await ipcRenderer.invoke("window:resize-begin", payload);
      attachPointerSession("window:resize-move", "window:resize-end");
    },
    resizeEnd: async (): Promise<void> => {
      await ipcRenderer.invoke("window:resize-end");
    },
    minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke("window:toggle-maximize"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
    /** 关闭主窗口 = 隐藏到托盘（main 侧实现），不退出进程。 */
    close: (): Promise<void> => ipcRenderer.invoke("window:close"),
    onMaximizedChanged: (listener: (maximized: boolean) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { maximized?: unknown } | boolean): void => {
        listener(typeof payload === "boolean" ? payload : payload?.maximized === true);
      };
      ipcRenderer.on("window:maximized-changed", handler);
      return () => {
        ipcRenderer.removeListener("window:maximized-changed", handler);
      };
    },
  },
  ...(bootstrap.mode !== "client" ? {
    dialog: {
      open: (options: DesktopDialogOptions): Promise<string | string[] | null> => ipcRenderer.invoke("dialog:open", options),
      save: (options: DesktopDialogOptions): Promise<string | null> => ipcRenderer.invoke("dialog:save", options),
    },
    events: {
      onAgentSourceChanged: (listener: (payload: unknown) => void): (() => void) =>
        subscribeHostEvent("host:event:agent-source-changed", listener),
      onStorageUsageProgress: (listener: (payload: unknown) => void): (() => void) =>
        subscribeHostEvent("host:event:storage-usage-progress", listener),
    },
  } : {}),
  platform: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke("platform:open-external", url),
  },
  // lead 约定的顶层别名；与 platform.openExternal 等价。
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("platform:open-external", url),
} satisfies FlowletDesktopBridge;

contextBridge.exposeInMainWorld("flowletDesktop", desktopApi);
