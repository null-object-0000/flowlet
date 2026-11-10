import { hasDesktopBridge } from "./bridge";

/**
 * 纯函数形式的模式判定，便于单测直接覆盖组合（构建模式 × preload 桥）。
 *
 * - `MODE === "desktop"`：`vite --mode desktop` 构建，产物 `dist-desktop`；
 * - preload 桥存在：壳加载了非 desktop 产物时的兜底，避免窗口命令全部落到
 *   Tauri API（desktop 构建没有 `__TAURI_INTERNALS__`）。
 */
export function resolveDesktopHost(mode: string, desktopBridgePresent: boolean): boolean {
  return mode === "desktop" || desktopBridgePresent;
}

/**
 * True when the frontend runs inside the Electron desktop shell
 * (`vite --mode desktop`, loaded by the Node Host / Electron window) instead of
 * the Tauri desktop shell or the browser-based Web Host.
 *
 * 注意：`isWebHost` 的语义保持不变（Docker / Web Host 仍只认 `--mode web`），
 * 这里新增的是独立的 desktop 运行模式，不改变 web 分支行为。
 */
export const isDesktopHost = resolveDesktopHost(import.meta.env.MODE, hasDesktopBridge());

/**
 * 客户端模式判定：Electron 壳的 preload 声明 `mode === "client"`。
 *
 * 客户端模式按 Web Host 语义运行（加载 WebApp、命令走远程管理 API、隐藏本机
 * Agent 接入/抓取/跨设备同步等桌面专有能力），但窗口壳仍是 Electron。
 */
export function resolveDesktopClient(mode: string, bridgeMode: string | undefined): boolean {
  return mode === "desktop" && bridgeMode === "client";
}

export const isDesktopClient = resolveDesktopClient(
  import.meta.env.MODE,
  hasDesktopBridge() ? window.flowletDesktop?.mode : undefined,
);