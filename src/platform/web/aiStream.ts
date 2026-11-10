/** Web Host 的 SSE 命令流：AI 生成环境前缀等需要实时进度的管理动作。
 *
 * 只有 Web Host 提供该端点（桌面 Host 未实现）；调用方应先判断 `isWebHost`。
 * 复用与 `invokeWebCommand` 相同的鉴权头（Bearer / Cookie + CSRF）。
 */
import { adminToken, currentCsrfToken } from "./client";

export type AiStreamEvent =
  | { type: "start"; model: string }
  | { type: "progress"; tokens: number; elapsedMs: number }
  | {
      type: "done";
      segment: string;
      model: string;
      completionTokens: number;
      elapsedMs: number;
      tokPerSec: number;
    }
  | { type: "error"; message: string };

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = adminToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const csrf = currentCsrfToken();
  if (csrf) headers["X-CSRF-Token"] = csrf;
  return headers;
}

/** 流式 POST 一个 SSE 端点；每条 `data: {...}` 回调一次。非 SSE 错误响应抛出可读 Error。 */
export async function streamSse(
  path: string,
  body: Record<string, unknown>,
  onEvent: (event: AiStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("text/event-stream")) {
    let message = `请求失败 (${response.status})`;
    try {
      const payload = (await response.json()) as { message?: unknown };
      if (typeof payload.message === "string" && payload.message !== "") message = payload.message;
    } catch {
      /* 非 JSON 错误体：保留状态码文案 */
    }
    throw new Error(message);
  }
  if (response.body === null) throw new Error("服务端未返回事件流");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const block = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf("\n\n");
      if (!block.startsWith("data:")) continue;
      try {
        onEvent(JSON.parse(block.slice("data:".length).trim()) as AiStreamEvent);
      } catch {
        /* 忽略无法解析的事件，避免中断整个流 */
      }
    }
  }
}

export interface EnvPrefixStreamInput {
  provider: string;
  providerDefault: string;
  name: string;
  note?: string;
  used?: string[];
}

/** AI 生成环境前缀（流式）；事件包含 start/progress/done/error。 */
export function streamEnvPrefix(
  input: EnvPrefixStreamInput,
  onEvent: (event: AiStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamSse("/api/ai/env-prefix", { ...input }, onEvent, signal);
}
