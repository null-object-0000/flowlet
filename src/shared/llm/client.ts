import { flowletAiTextFromContent } from "./content";
import type {
  FlowletAiChatChunk,
  FlowletAiChatCompletion,
  FlowletAiChatCompletionRequest,
} from "./types";

/** Flowlet 专属 User-Agent，版本号由构建时注入（来源 package.json，见
 *  vite.config.ts 的 `__FLOWLET_APP_VERSION__`）。代理按 config.json 的
 *  `ua_rules`（`pattern: "Flowlet/"`）识别客户端为 Flowlet。 */
export const FLOWLET_USER_AGENT = `Flowlet/${__FLOWLET_APP_VERSION__}`;

/** 测试注入用 fetch 实现；默认取全局 fetch。 */
export type FlowletAiFetch = typeof fetch;

export interface FlowletAiClientOptions {
  /** 上游 Base URL，如 `http://127.0.0.1:18640` 或 `https://api.example.com/v1`。
   *  末尾斜杠会被归一化，请求路径在此基础上拼接。 */
  baseUrl: string;
  /** Bearer API Key（可选）。缺失时请求不带 Authorization 头。 */
  apiKey?: string | null;
  /** 追加的请求头。SDK 已内置 Flowlet 身份标记头（`User-Agent` 与
   *  `x-flowlet-client`），传入同名头可覆盖默认值。 */
  headers?: Record<string, string>;
  /** 覆盖 fetch 实现（测试用）；默认使用全局 fetch。 */
  fetch?: FlowletAiFetch;
}

/** SDK 统一的请求失败错误。带 HTTP 状态码；网络 / 响应体缺失等错误无状态码。 */
export class FlowletAiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "FlowletAiError";
    this.status = status;
  }
}

/**
 * flowlet-ai 内置 SDK 客户端。第一版支持 OpenAI Chat Completions：
 * - `chatCompletions`：非流式，返回完整响应；
 * - `chatCompletionsStream`：流式（SSE），逐 chunk 产出，`[DONE]` 后结束。
 *
 * 请求默认携带 Flowlet 身份标记头，使 Flowlet 代理的请求日志识别为 Flowlet：
 * - `User-Agent: Flowlet/<version>`（命中 config.json `ua_rules` 的 `"Flowlet/"`）；
 * - `x-flowlet-client: Flowlet`（标记头兜底，部分 WebView 会剥离 fetch 的
 *   User-Agent；代理会在识别后、转发上游前剥离该头，不向外泄露）。
 */
export class FlowletAiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FlowletAiFetch;

  constructor(options: FlowletAiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey || null;
    // 内置 Flowlet 身份标记头为默认值；调用方传入的同名头覆盖默认值。
    this.headers = {
      "User-Agent": FLOWLET_USER_AGENT,
      "x-flowlet-client": "Flowlet",
      ...options.headers,
    };
    // 必须绑定全局接收者：直接提取 `globalThis.fetch` 后以自由函数调用，在
    // WebView 中会因丢失 `this` 抛出 "Illegal invocation"。
    this.fetchImpl = options.fetch ?? (globalThis.fetch as FlowletAiFetch).bind(globalThis);
  }

  /** 非流式 chat completion。 */
  async chatCompletions(
    request: FlowletAiChatCompletionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FlowletAiChatCompletion> {
    const response = await this.post(
      "/v1/chat/completions",
      { ...request, stream: false },
      options?.signal,
    );
    return (await response.json()) as FlowletAiChatCompletion;
  }

  /** 流式 chat completion。请求强制 `stream: true`，逐 SSE chunk 产出。 */
  async *chatCompletionsStream(
    request: FlowletAiChatCompletionRequest,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<FlowletAiChatChunk> {
    const response = await this.post(
      "/v1/chat/completions",
      { ...request, stream: true },
      options?.signal,
    );
    if (!response.body) {
      throw new FlowletAiError("未返回流式响应", response.status);
    }
    for await (const data of readSseData(response.body)) {
      if (data === "[DONE]") return;
      let chunk: FlowletAiChatChunk;
      try {
        chunk = JSON.parse(data) as FlowletAiChatChunk;
      } catch {
        // 忽略无法解析的 SSE 片段，继续消费后续事件。
        continue;
      }
      yield chunk;
    }
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.headers,
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // 用户主动中断直接透传 AbortError，调用方可按 signal.aborted 判断；
      // 其余网络错误统一包装为 SDK 错误。
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new FlowletAiError(error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
      throw new FlowletAiError(await httpErrorMessage(response) ?? `HTTP ${response.status}`, response.status);
    }
    return response;
  }
}

/** 创建 flowlet-ai 客户端。 */
export function createFlowletAi(options: FlowletAiClientOptions): FlowletAiClient {
  return new FlowletAiClient(options);
}

/**
 * 从流式响应中读取全部 SSE 事件，逐个产出 `data:` 载荷。
 *
 * 按空行（`\n\n`）切分事件，兼容 `\r\n`；多行 `data:` 拼接为一个载荷；
 * 事件体为 `[DONE]` 时由调用方结束消费。末尾未换行的最后一个事件也处理。
 */
async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = sseEventData(event);
        if (data) yield data;
      }
    }
    if (buffer.trim()) {
      const data = sseEventData(buffer);
      if (data) yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

/** 提取单个 SSE 事件块中的 `data:` 载荷（多行 data 以换行拼接），无 data 行返回 null。 */
function sseEventData(event: string): string | null {
  const lines = event.split("\n");
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}

/** 从错误响应中提取用户可读信息：优先 `error.message`，其次响应体前 200 字符。 */
async function httpErrorMessage(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string" && parsed.error.message.trim()) {
        return `HTTP ${response.status}: ${parsed.error.message.trim()}`;
      }
    } catch {
      // 非 JSON 错误体，回退到原文。
    }
    return `HTTP ${response.status}: ${text.slice(0, 200)}`;
  } catch {
    // 响应体不可读（如测试桩缺失 body 方法）时回退到纯状态码。
    return null;
  }
}

export { flowletAiTextFromContent };
