/**
 * 复制文本到系统剪贴板。
 *
 * 优先使用 Clipboard API；但 Flowlet Web Host 常部署在内网 HTTP（例如
 * `http://10.x.x.x:20134`），不是安全上下文，`navigator.clipboard` 在浏览器里为
 * `undefined`，直接调用会抛 `Cannot read properties of undefined (reading 'writeText')`。
 * 因此这里统一回退到 `document.execCommand("copy")` + 临时 textarea，页面只需调用本函数。
 *
 * 失败时抛错，由调用方决定 Toast 文案；成功不返回内容。
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 权限被拒或非安全上下文：继续走 execCommand 回退。
    }
  }
  if (typeof document === "undefined" || !document.body) {
    throw new Error("Clipboard unavailable");
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.top = "0";
  field.style.left = "0";
  field.style.opacity = "0";
  const previousFocus = document.activeElement;
  document.body.append(field);
  try {
    field.select();
    // 部分移动端/旧浏览器需要显式设置选区范围才能复制整段文本。
    field.setSelectionRange(0, field.value.length);
    if (!document.execCommand("copy")) throw new Error("Copy unavailable");
  } finally {
    field.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
}