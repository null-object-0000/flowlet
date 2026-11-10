import { requireDesktopOpenExternal } from "./desktop/bridge";
import { isDesktopHost } from "./desktop/mode";
import { invokeCommand } from "./tauri/client";
import { isWebHost } from "./web/mode";

export type OpenExternalResult = "opened" | "blocked";

/**
 * 在系统浏览器中打开外部链接。
 *
 * - Tauri 桌面壳：走 Tauri `open_external_url`（WebView 内不直接跳转，避免把登录页
 *   挤进应用窗口）；
 * - Electron desktop 壳：走 preload 桥（`platform:open-external` → 主进程
 *   `shell.openExternal`），同样不在应用窗口内跳转；
 * - Web Host：浏览器环境没有 Tauri command / 桌面桥，用 `window.open` 新标签页打开，
 *   并显式使用 `noopener,noreferrer`。
 *
 * 返回 `blocked` 表示浏览器拦截了弹窗（调用方应展示可读提示），而不是静默失败。
 */
export async function openExternalUrl(url: string): Promise<OpenExternalResult> {
  const target = url.trim();
  if (!target) {
    throw new Error("登录地址为空，请重新发起登录。");
  }
  if (isDesktopHost) {
    await requireDesktopOpenExternal()(target);
    return "opened";
  }
  if (isWebHost) {
    const opened = window.open(target, "_blank", "noopener,noreferrer");
    return opened ? "opened" : "blocked";
  }
  await invokeCommand<null>("open_external_url", { url: target });
  return "opened";
}