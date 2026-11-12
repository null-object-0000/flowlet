// A2A 1.0 JSON-RPC/SSE client. No provider-specific APIs, conversion or execution logic.
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, request } from "undici";

export type A2aObject = Record<string, unknown>;
export const object = (value: unknown): A2aObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as A2aObject)
    : {};
export const END_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
]);
export const A2A_METHODS = new Set([
  "SendMessage",
  "SendStreamingMessage",
  "GetTask",
  "ListTasks",
  "CancelTask",
  "SubscribeToTask",
  "GetExtendedAgentCard",
  "CreateTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "DeleteTaskPushNotificationConfig",
]);
export const MAX_A2A_BYTES = 4 * 1024 * 1024;

export class A2aError extends Error {
  code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.code = code;
  }
}
export function a2aUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new A2aError("A2A URL 无效");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new A2aError("A2A URL 必须为不含账号、查询参数或锚点的 HTTP(S) 地址");
  return url;
}
async function readJson(body: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const bytes of body) {
    size += bytes.length;
    if (size > MAX_A2A_BYTES) throw new A2aError("A2A JSON 响应超过4 MiB");
    chunks.push(Buffer.from(bytes));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new A2aError("A2A 响应不是有效 JSON");
  }
}

/** Incremental UTF-8/multiline SSE parser; bounded per frame, not per long-running stream. */
export async function* a2aEvents(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      if (Buffer.byteLength(frame) > MAX_A2A_BYTES)
        throw new A2aError("A2A SSE 事件超过4 MiB");
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data);
      } catch {
        throw new A2aError("A2A SSE data 不是有效 JSON");
      }
    }
    if (Buffer.byteLength(pending) > MAX_A2A_BYTES)
      throw new A2aError("A2A SSE 事件超过4 MiB");
  }
  pending += decoder.decode();
  if (pending.trim() && !pending.trim().startsWith(":"))
    throw new A2aError("A2A SSE 在完整事件前断开；请查询任务，未自动重发");
}

export class A2aClient {
  private dispatcher: Agent;
  private token: string;
  private signal: AbortSignal;
  private extensions?: string;
  private configured: URL;
  endpoint: URL;
  card: A2aObject = {};
  tenant?: string;
  constructor(
    url: string,
    token: string,
    options: { signal: AbortSignal; insecure?: boolean; extensions?: string },
  ) {
    this.configured = a2aUrl(url);
    this.endpoint = new URL(this.configured);
    if (!token || /[\r\n]/.test(token)) throw new A2aError("A2A 调用密钥无效");
    this.token = token;
    this.signal = options.signal;
    this.extensions = options.extensions;
    this.dispatcher = new Agent({
      connect: { rejectUnauthorized: !options.insecure },
    });
  }
  clean(error: unknown): string {
    return (error instanceof Error ? error.message : String(error))
      .split(this.token)
      .join("[redacted]");
  }
  async close() {
    await this.dispatcher.destroy();
  }
  private async open(url: URL, body?: string) {
    if (url.origin !== this.configured.origin)
      throw new A2aError("拒绝把 A2A 凭据发送到跨域地址");
    const response = await request(url, {
      dispatcher: this.dispatcher,
      method: body === undefined ? "GET" : "POST",
      body,
      signal: this.signal,
      headersTimeout: 30_000,
      bodyTimeout: 0,
      headers: {
        authorization: `Bearer ${this.token}`,
        "a2a-version": "1.0",
        accept: "application/json, text/event-stream",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.extensions ? { "a2a-extensions": this.extensions } : {}),
      },
    });
    response.body.on("error", () => {});
    return response;
  }
  async discover(cardUrl?: string): Promise<A2aObject> {
    const target = cardUrl
      ? a2aUrl(cardUrl)
      : new URL(
          this.configured.href.replace(/\/$/, "") +
            "/.well-known/agent-card.json",
        );
    const response = await this.open(target);
    try {
      if (response.statusCode !== 200)
        throw new A2aError(
          `读取 Agent Card：HTTP ${response.statusCode}（不会跟随重定向）`,
        );
      const card = object(await readJson(response.body));
      const iface = (
        Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : []
      )
        .map(object)
        .find(
          (i) => i.protocolBinding === "JSONRPC" && i.protocolVersion === "1.0",
        );
      if (
        !iface ||
        typeof iface.url !== "string" ||
        typeof card.name !== "string"
      )
        throw new A2aError("Agent Card 未声明有效的 JSONRPC / 1.0 接口");
      const endpoint = a2aUrl(iface.url);
      if (endpoint.origin !== this.configured.origin)
        throw new A2aError("Agent Card 的 RPC 地址跨域，已拒绝发送凭据");
      this.card = card;
      this.endpoint = endpoint;
      this.tenant =
        typeof iface.tenant === "string" && iface.tenant
          ? iface.tenant
          : undefined;
      return card;
    } finally {
      response.body.destroy();
    }
  }
  private payload(method: string, params: A2aObject) {
    if (!A2A_METHODS.has(method))
      throw new A2aError("未知的 A2A 1.0 标准方法：" + method);
    const id = randomUUID();
    const data = { ...params };
    if (this.tenant) {
      if (data.tenant !== undefined && data.tenant !== this.tenant)
        throw new A2aError("tenant 与 Agent Card 不匹配");
      data.tenant = this.tenant;
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: data });
    if (Buffer.byteLength(body) > MAX_A2A_BYTES)
      throw new A2aError("A2A 请求超过4 MiB，请减少附件大小");
    return { id, body };
  }
  private unwrap(value: unknown, id: string): A2aObject {
    const rpc = object(value);
    if (
      rpc.jsonrpc !== "2.0" ||
      rpc.id !== id ||
      (rpc.result === undefined) === (rpc.error === undefined)
    )
      throw new A2aError("无效的 A2A JSON-RPC 响应");
    if (rpc.error !== undefined) {
      const error = object(rpc.error);
      throw new A2aError(
        this.clean(`A2A ${error.code}: ${error.message}`),
        typeof error.code === "number" ? error.code : null,
      );
    }
    if (
      rpc.result === null ||
      typeof rpc.result !== "object" ||
      Array.isArray(rpc.result)
    )
      throw new A2aError("A2A result 必须为对象");
    return rpc.result as A2aObject;
  }
  async call(method: string, params: A2aObject = {}): Promise<A2aObject> {
    const { id, body } = this.payload(method, params);
    const response = await this.open(this.endpoint, body);
    try {
      if (response.statusCode !== 200)
        throw new A2aError(`A2A HTTP ${response.statusCode}；未自动重试`);
      return this.unwrap(await readJson(response.body), id);
    } finally {
      response.body.destroy();
    }
  }
  async *stream(
    method: string,
    params: A2aObject = {},
  ): AsyncGenerator<A2aObject> {
    const { id, body } = this.payload(method, params);
    const response = await this.open(this.endpoint, body);
    try {
      if (response.statusCode !== 200)
        throw new A2aError(`A2A HTTP ${response.statusCode}；未自动重试`);
      if (
        !String(response.headers["content-type"]).includes("text/event-stream")
      ) {
        this.unwrap(await readJson(response.body), id);
        throw new A2aError("该流式操作没有返回 SSE");
      }
      for await (const value of a2aEvents(response.body))
        yield this.unwrap(value, id);
    } finally {
      response.body.destroy();
    }
  }
  async wait(
    task: A2aObject,
    historyLength: number,
    pollMs: number,
    observe: (task: A2aObject) => void,
  ): Promise<A2aObject> {
    while (true) {
      if (
        typeof task.id !== "string" ||
        typeof object(task.status).state !== "string"
      )
        throw new A2aError("GetTask 未返回有效的标准 Task");
      if (END_STATES.has(String(object(task.status).state))) return task;
      await delay(pollMs, undefined, { signal: this.signal });
      task = await this.call("GetTask", { id: task.id, historyLength });
      observe(task);
    }
  }
}
