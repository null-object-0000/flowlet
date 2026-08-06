/// <reference types="vite/client" />

/** 构建时由 vite `define` 注入的 Flowlet 应用版本号（来源 package.json）。
 *  供 flowlet-ai SDK 组装 `User-Agent: Flowlet/<version>` 使用，避免写死版本号。 */
declare const __FLOWLET_APP_VERSION__: string;
