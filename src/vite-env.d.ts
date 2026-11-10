/// <reference types="vite/client" />

/** 构建时由 vite `define` 注入的 Flowlet 应用版本号（来源 package.json）。
 *  供 flowlet-ai SDK 组装 `User-Agent: Flowlet/<version>` 使用，避免写死版本号。 */
declare const __FLOWLET_APP_VERSION__: string;

/**
 * Flowlet 运行目标由 `vite --mode` 决定：
 * - 未指定 / Tauri desktop：默认分支；
 * - `web`：Docker / Web Host（`isWebHost`）；
 * - `mobile`：移动端；
 * - `demo`：官网 Demo；
 * - `desktop`：Electron 桌面壳（`isDesktopHost`，产物 `dist-desktop`）。
 *
 * `MODE` 已由 `vite/client` 声明为 string；这里只补 Flowlet 自定义的构建期变量。
 */
interface ImportMetaEnv {
  readonly VITE_FLOWLET_TARGET?: string;
  readonly VITE_FLOWLET_DEMO?: string;
  readonly TAURI_ENV_PLATFORM?: string;
}
