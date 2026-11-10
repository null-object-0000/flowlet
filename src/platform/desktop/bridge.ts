/**
 * Electron 桌面壳（`packages/flowlet-desktop` 的 preload）注入到渲染进程的桥。
 *
 * 职责边界：
 * - preload 只做受控转发，渲染进程拿不到 `ipcRenderer` / `nodeIntegration`；
 * - 这里声明的是**事实契约**，不是可替换的抽象：字段名、方法名、参数形状必须与
 *   preload 的 `contextBridge.exposeInMainWorld("flowletDesktop", ...)` 完全一致；
 * - 主进程 channel 名见各方法注释，窗口壳与主进程两侧对齐后不要再改。
 *
 * 约束：本文件不得引入任何 renderer 侧业务模块（只放类型与桥存在性判断），
 * 避免 web / mobile / demo 构建把 Electron 概念带进来。
 */

/** 与 Tauri `@tauri-apps/api/window` 的 resize 方向枚举保持一致（该类型未导出）。 */
export type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

/**
 * `window:resize-begin` 的 payload（preload 转成 IPC 参数）。
 * 主进程按 Tauri 方向名（`SouthEast` 等）解析，并优先取 `direction`。
 */
export type DesktopResizeBeginPayload = {
  direction: ResizeDirection;
  screenX: number;
  screenY: number;
};

/** `window:maximized-changed` 的 IPC 原始 payload；preload 会归一成 boolean 回调。 */
export type DesktopMaximizedState = { maximized: boolean };

/**
 * 无边框窗口桥。每个方法都是 `ipcRenderer.invoke` 的 Promise 包装：
 * 主进程实现失败时应 reject（不要返回 undefined），让渲染进程的 catch 能落到
 * 可读日志上。
 *
 * 拖动说明（HG-2）：Electron 没有 Tauri `startDragging()` 的等价 JS API，
 * 标题栏与抽屉头部改用 CSS `-webkit-app-region: drag` 让平台原生处理拖动与
 * 双击最大化；`startDragging` / `startResizeDragging` 是壳额外提供的兼容通道，
 * 渲染进程正常路径不依赖它们。8 向缩放手柄降级为 `resizeBegin` + 主进程
 * `setBounds` 跟随。
 */
export type DesktopWindowBridge = {
  /** channel: `window:minimize`。 */
  minimize: () => Promise<void>;
  /** channel: `window:toggle-maximize`。主进程按 `isMaximized()` 决定 maximize/unmaximize。 */
  toggleMaximize: () => Promise<void>;
  /** channel: `window:is-maximized`。 */
  isMaximized: () => Promise<boolean>;
  /** channel: `window:close`。桌面语义是隐藏到托盘，不直接退出进程。 */
  close: () => Promise<void>;
  /**
   * 主进程 `window:maximized-changed` 事件（IPC payload `{ maximized: boolean }`，
   * preload 归一后回调参数是 boolean）的订阅入口。返回取消订阅函数；
   * 渲染进程 effect 清理时必须调用。
   */
  onMaximizedChanged: (listener: (maximized: boolean) => void) => () => void;
  /**
   * channel: `window:resize-begin`，payload 为 `{ direction, screenX, screenY }`。
   * preload 在 begin 之后自行转发 `window:resize-move`（pointermove）与
   * `window:resize-end`（pointerup），主进程以初始屏幕坐标为基准跟踪光标并
   * `setBounds`（HG-2 降级实现，没有系统 resize 模态循环与窗口吸附）。
   */
  resizeBegin: (payload: DesktopResizeBeginPayload) => Promise<void>;
  /** channel: `window:resize-end`。主进程结束跟随；重复调用必须幂等。 */
  resizeEnd: () => Promise<void>;
  /** 可选：程序化拖动兼容通道（正常 UI 路径使用 CSS app-region）。 */
  startDragging?: () => Promise<void>;
  /** 可选：程序化缩放兼容通道（正常 UI 路径使用 `resizeBegin`）。 */
  startResizeDragging?: (direction: ResizeDirection) => Promise<void>;
};

/** preload 注入的 `window.flowletDesktop` 形状。 */
export type FlowletDesktopBridge = {
  /**
   * Node Host 的管理 token（Bearer）。桌面壳由主进程注入，没有登录页，
   * renderer 不再经过 sessionStorage 获取。
   */
  adminToken?: string;
  /**
   * 运行模式：`host` 本机 Node Host；`client` 连接远程 Docker/Web Host
   * （远程观测+管理，命令经本机 Client Gateway 反代，凭据不进入渲染进程）。
   */
  mode?: "host" | "client";
  /** 客户端模式下远程管理台地址（仅展示/诊断用）。 */
  clientBaseUrl?: string;
  /** 打开「运行模式 / 连接主机」设置窗口。 */
  openModeSettings?: () => Promise<void>;
  window?: DesktopWindowBridge;
  /** channel: `platform:open-external`；主进程用 `shell.openExternal` 打开并做协议校验。 */
  platform?: {
    openExternal?: (url: string) => Promise<void>;
  };
  /** 壳额外提供的顶层别名（与 `platform.openExternal` 等价）。 */
  openExternal?: (url: string) => Promise<void>;
};

declare global {
  interface Window {
    /** 仅在 Electron desktop 壳中由 preload 注入；Tauri / Web / mobile 下不存在。 */
    flowletDesktop?: FlowletDesktopBridge;
  }
}

/** 桌面桥缺失或残缺时抛出；由调用方决定展示/记录，不能被静默吞掉。 */
export class DesktopBridgeUnavailableError extends Error {
  constructor(detail: string) {
    super(`Flowlet 桌面桥不可用：${detail}`);
    this.name = "DesktopBridgeUnavailableError";
  }
}

/** 读取 preload 注入的桥；非桌面环境（或 preload 未加载）返回 undefined。 */
export function getDesktopBridge(): FlowletDesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.flowletDesktop;
}

/** preload 桥是否存在；`mode.ts` 用它作为 `MODE === "desktop"` 之外的兜底判定。 */
export function hasDesktopBridge(): boolean {
  const bridge = getDesktopBridge();
  return typeof bridge === "object" && bridge !== null;
}

/** preload 注入的管理 token；浏览器/测试环境返回空串。 */
export function desktopAdminToken(): string {
  const token = getDesktopBridge()?.adminToken;
  return typeof token === "string" ? token : "";
}

/** 取窗口桥，缺失时抛出可读错误（不降级为静默 no-op）。 */
export function requireDesktopWindowBridge(): DesktopWindowBridge {
  const windowBridge = getDesktopBridge()?.window;
  if (!windowBridge) {
    throw new DesktopBridgeUnavailableError("window.flowletDesktop.window 未注入");
  }
  return windowBridge;
}

/** 取 openExternal 能力，缺失时抛出可读错误。 */
export function requireDesktopOpenExternal(): (url: string) => Promise<void> {
  const bridge = getDesktopBridge();
  const openExternal = bridge?.openExternal ?? bridge?.platform?.openExternal;
  if (typeof openExternal !== "function") {
    throw new DesktopBridgeUnavailableError("window.flowletDesktop.openExternal 未注入");
  }
  return openExternal;
}