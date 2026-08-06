/**
 * 从 OpenAI-compatible 消息的 `content` 字段提取纯文本。
 *
 * 兼容三种常见形态：
 * - 字符串：`"你好"`；
 * - 多段内容数组：`[{ type: "text", text: "你好" }, { type: "text", text: "世界" }]`；
 * - 单一对象：`{ text: "你好" }`。
 *
 * 无法提取时返回空字符串，不做 trim；调用方按需 trim。
 */
export function flowletAiTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string") return text;
        }
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}
