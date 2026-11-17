import { requireDesktopOpenExternal } from "./desktop/bridge";
import { isDesktopHost } from "./desktop/mode";

export type OpenExternalResult = "opened" | "blocked";

/**
 * 在系统浏览器中打开外部链接。
 *
 * - Electron 壳：受控 preload 桥，由系统浏览器打开；
 * - 浏览器 / Demo：新标签页打开，并显式使用 noopener,noreferrer。
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
  const opened = window.open(target, "_blank", "noopener,noreferrer");
  return opened ? "opened" : "blocked";
}
