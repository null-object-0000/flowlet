import { DesktopBridgeUnavailableError, requireDesktopWindowBridge } from "../desktop/bridge";
import type { ResizeDirection } from "../desktop/bridge";
import { isDesktopHost } from "../desktop/mode";

export type { ResizeDirection };

/**
 * Tauri 窗口实例。必须惰性加载：`getCurrentWindow()` 会读取
 * `window.__TAURI_INTERNALS__`，Web Host / Electron desktop 产物里没有这个
 * 全局对象；`@tauri-apps/api/window` 模块本身也只在 Tauri 分支才动态 import，
 * 保证 desktop 模式完全不加载 Tauri API。
 */
let cachedTauriWindow: import("@tauri-apps/api/window").Window | undefined;
let tauriWindowModule: Promise<typeof import("@tauri-apps/api/window")> | undefined;

async function currentTauriWindow(): Promise<import("@tauri-apps/api/window").Window> {
  if (cachedTauriWindow) return cachedTauriWindow;
  tauriWindowModule ??= import("@tauri-apps/api/window");
  const { getCurrentWindow } = await tauriWindowModule;
  cachedTauriWindow ??= getCurrentWindow();
  return cachedTauriWindow;
}

/**
 * 桌面窗口命令的统一入口。
 *
 * - Tauri 桌面壳：原样走 `@tauri-apps/api/window`；
 * - Electron desktop 壳：走 preload 桥（`ipcRenderer.invoke` → 主进程
 *   `BrowserWindow` 方法）。拖动/双击最大化在 desktop 模式下由 CSS
 *   `-webkit-app-region: drag` 交给平台处理；`startDragging` /
 *   `startResizeDragging` 只是壳提供的兼容通道，正常 UI 路径不调用。
 *   8 向缩放由 `WindowResizeHandles` 直接调用桥的 `resizeBegin` 降级实现。
 *
 * 所有方法都返回 Promise，桥缺失或主进程 channel 未实现时以 rejection 暴露，
 * 调用方负责记录（不要吞掉 rejection）。
 */
export const windowCommands = {
  startDragging: async (): Promise<void> => {
    if (isDesktopHost) {
      const bridge = requireDesktopWindowBridge();
      if (bridge.startDragging) return bridge.startDragging();
      throw new DesktopBridgeUnavailableError(
        "desktop 模式未提供程序化拖动；标题栏拖动由 -webkit-app-region: drag 处理",
      );
    }
    return (await currentTauriWindow()).startDragging();
  },
  startResizeDragging: async (direction: ResizeDirection): Promise<void> => {
    if (isDesktopHost) {
      const bridge = requireDesktopWindowBridge();
      if (bridge.startResizeDragging) return bridge.startResizeDragging(direction);
      throw new DesktopBridgeUnavailableError(
        "desktop 模式未提供程序化缩放；缩放热区走 window.flowletDesktop.window.resizeBegin",
      );
    }
    return (await currentTauriWindow()).startResizeDragging(direction);
  },
  minimize: async (): Promise<void> => {
    if (isDesktopHost) {
      return requireDesktopWindowBridge().minimize();
    }
    return (await currentTauriWindow()).minimize();
  },
  isMaximized: async (): Promise<boolean> => {
    if (isDesktopHost) {
      return requireDesktopWindowBridge().isMaximized();
    }
    return (await currentTauriWindow()).isMaximized();
  },
  /**
   * 窗口尺寸/最大化状态变化订阅。desktop 桥只推送最大化状态
   * （`window:maximized-changed`），因此 desktop 下这里转成最大化状态订阅。
   */
  onResized: async (handler: () => void): Promise<() => void> => {
    if (isDesktopHost) {
      return requireDesktopWindowBridge().onMaximizedChanged(() => handler());
    }
    return (await currentTauriWindow()).onResized(handler);
  },
  toggleMaximize: async (): Promise<void> => {
    if (isDesktopHost) {
      return requireDesktopWindowBridge().toggleMaximize();
    }
    return (await currentTauriWindow()).toggleMaximize();
  },
  close: async (): Promise<void> => {
    if (isDesktopHost) {
      return requireDesktopWindowBridge().close();
    }
    return (await currentTauriWindow()).close();
  },
};
