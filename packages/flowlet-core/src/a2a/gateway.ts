import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebContext } from "../web/context.ts";
import { CommandError } from "../types.ts";
import { A2aStore, type A2aAgent, type A2aCall } from "../storage/a2a.ts";
import { a2aRequest, parseHttpUrl, readLimited } from "./network.ts";
import {
  METHODS,
  PUSH_METHODS,
  RpcError,
  gatewayCard,
  validateCapabilities,
  validateAgentCard,
  type ServiceParameters,
} from "./protocol.ts";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface A2aAgentInput {
  id: string;
  name: string;
  cardUrl: string;
  enabled: boolean;
  allowPrivateNetwork: boolean;
  timeoutSeconds: number;
  /** omitted = preserve; empty = remove */
  upstreamToken?: string;
}

function inputOf(value: unknown): A2aAgentInput {
  const i = object(value);
  if (typeof i.id !== "string" || !ID.test(i.id))
    throw new Error("Agent ID 需为 1–64 位小写字母、数字、下划线或连字符");
  if (typeof i.name !== "string" || !i.name.trim() || i.name.length > 100)
    throw new Error("请输入不超过 100 字的 Agent 名称");
  if (typeof i.cardUrl !== "string") throw new Error("请填写 Agent Card URL");
  parseHttpUrl(i.cardUrl);
  if (
    typeof i.enabled !== "boolean" ||
    typeof i.allowPrivateNetwork !== "boolean"
  )
    throw new Error("Agent 开关必须为布尔值");
  if (
    !Number.isInteger(i.timeoutSeconds) ||
    Number(i.timeoutSeconds) < 5 ||
    Number(i.timeoutSeconds) > 1800
  )
    throw new Error("超时必须为 5–1800 秒");
  if (
    i.upstreamToken !== undefined &&
    (typeof i.upstreamToken !== "string" ||
      /[\r\n]/.test(i.upstreamToken) ||
      i.upstreamToken.length > 8192)
  )
    throw new Error("上游 Token 无效");
  return {
    id: i.id,
    name: i.name,
    cardUrl: i.cardUrl,
    enabled: i.enabled,
    allowPrivateNetwork: i.allowPrivateNetwork,
    timeoutSeconds: Number(i.timeoutSeconds),
    upstreamToken: i.upstreamToken as string | undefined,
  };
}

/** Observation only: never changes task IDs, request envelopes or response bytes. */
export class A2aObserver {
  taskId: string | null = null;
  contextId: string | null = null;
  state: string | null = null;
  error: string | null = null;
  finished = false;
  private pending = "";
  private discarding = false;
  private decoder = new TextDecoder();
  observe(value: unknown): void {
    const envelope = object(value);
    if (envelope.error)
      this.error = String(
        object(envelope.error).message ?? "A2A JSON-RPC error",
      ).slice(0, 1000);
    const result = object(envelope.result ?? value);
    if (result.message) this.finished = true;
    const item = object(
      result.task ??
        result.statusUpdate ??
        result.artifactUpdate ??
        result.message ??
        result,
    );
    if (typeof item.taskId === "string") this.taskId = item.taskId;
    if (typeof item.id === "string" && item.status) this.taskId = item.id;
    if (typeof item.contextId === "string") this.contextId = item.contextId;
    if (typeof object(item.status).state === "string") {
      this.state = String(object(item.status).state);
      if (
        [
          "TASK_STATE_COMPLETED",
          "TASK_STATE_FAILED",
          "TASK_STATE_CANCELED",
          "TASK_STATE_REJECTED",
          "TASK_STATE_INPUT_REQUIRED",
          "TASK_STATE_AUTH_REQUIRED",
        ].includes(this.state)
      )
        this.finished = true;
    }
  }
  feed(chunk: Uint8Array): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    const events = this.pending.split(/\r?\n\r?\n/);
    this.pending = events.pop() ?? "";
    for (const event of events) {
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      try {
        this.observe(JSON.parse(data));
      } catch {
        /* comments and non-JSON data pass through */
      }
    }
    if (this.pending.length > 256 * 1024) {
      this.pending = this.pending.slice(-3);
      this.discarding = true;
    }
  }
}

export class A2aGateway {
  readonly store: A2aStore;
  private active = new Set<AbortController>();
  private finishing = new Set<Promise<void>>();
  private ctx: WebContext;
  constructor(ctx: WebContext) {
    if (process.env.FLOWLET_PUBLIC_A2A_URL) {
      const root = parseHttpUrl(process.env.FLOWLET_PUBLIC_A2A_URL);
      if (root.pathname !== "/")
        throw new Error("FLOWLET_PUBLIC_A2A_URL 必须是根地址");
    }
    this.ctx = ctx;
    this.store = ctx.storage.withDatabase((db) => new A2aStore(db));
  }
  async close(): Promise<void> {
    for (const controller of this.active) controller.abort();
    await Promise.allSettled([...this.finishing]);
  }
  list() {
    return this.store.agents().map(({ tokenCipher, ...a }) => ({
      ...a,
      hasUpstreamToken: !!tokenCipher,
      gatewayPath: `/a2a/${a.id}`,
      gatewayUrl: process.env.FLOWLET_PUBLIC_A2A_URL
        ? new URL(`/a2a/${a.id}`, process.env.FLOWLET_PUBLIC_A2A_URL).href
        : undefined,
    }));
  }
  private token(input: A2aAgentInput): string | undefined {
    if (input.upstreamToken !== undefined)
      return input.upstreamToken || undefined;
    const previous = this.store.agent(input.id);
    if (
      previous?.tokenCipher &&
      parseHttpUrl(previous.cardUrl).origin !==
        parseHttpUrl(input.cardUrl).origin
    ) {
      throw new Error("Agent 地址跨域变更时，请重新填写或清除上游 Token");
    }
    const cipher = previous?.tokenCipher;
    return cipher ? this.ctx.secrets.decrypt(cipher) : undefined;
  }
  async inspect(raw: unknown) {
    const input = inputOf(raw);
    const upstream = await a2aRequest(input.cardUrl, {
      allowPrivate: input.allowPrivateNetwork,
      token: this.token(input),
      signal: AbortSignal.timeout(10_000),
    });
    try {
      if (upstream.statusCode !== 200)
        throw new Error(`读取 Agent Card 失败：HTTP ${upstream.statusCode}`);
      const card = object(
        JSON.parse(await readLimited(upstream.body, 512 * 1024)),
      );
      validateAgentCard(card);
      const iface = (
        Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : []
      )
        .map(object)
        .find(
          (i) => i.protocolBinding === "JSONRPC" && i.protocolVersion === "1.0",
        );
      if (!iface || typeof iface.url !== "string")
        throw new Error("当前只支持声明 JSONRPC / 1.0 接口的 A2A Agent");
      const endpoint = parseHttpUrl(iface.url);
      // A discovered card must not redirect an administrator's credential to another origin.
      if (endpoint.origin !== parseHttpUrl(input.cardUrl).origin)
        throw new Error("Agent Card 的调用地址必须与 Card URL 同源");
      return { card, endpoint: endpoint.href };
    } finally {
      upstream.body.destroy();
      await upstream.close();
    }
  }
  async save(raw: unknown) {
    const input = inputOf(raw);
    const inspected = await this.inspect(input);
    const token = this.token(input);
    this.store.save({
      ...input,
      upstreamToken: undefined,
      ...inspected,
      name: input.name.trim(),
      tokenCipher: token ? this.ctx.secrets.encrypt(token) : null,
      updatedAt: new Date().toISOString(),
    } as A2aAgent);
    return this.list().find((a) => a.id === input.id);
  }
  createKey(name: unknown, agentIds: unknown) {
    if (typeof name !== "string" || !name.trim() || name.length > 100)
      throw new Error("请输入调用密钥名称");
    if (
      !Array.isArray(agentIds) ||
      !agentIds.length ||
      agentIds.some((id) => typeof id !== "string" || !this.store.agent(id))
    )
      throw new Error("请选择已登记的 Agent");
    const token = `flwa2a_${randomBytes(32).toString("base64url")}`;
    const id = randomUUID();
    this.store.createKey(id, name.trim(), hash(token), [...new Set(agentIds)]);
    return { id, token };
  }
  private agent(id: string) {
    const agent = this.store.agent(id);
    if (!agent || !agent.enabled)
      throw new CommandError(
        404,
        "a2a_agent_unavailable",
        "Agent 不存在或已停用",
      );
    return agent;
  }
  private parseRpc(body: string): ObjectValue {
    let rpc: ObjectValue;
    try {
      rpc = object(JSON.parse(body));
    } catch {
      throw new RpcError(-32700, "A2A 请求不是有效 JSON");
    }
    if (
      rpc.jsonrpc !== "2.0" ||
      !(typeof rpc.id === "string" || typeof rpc.id === "number") ||
      typeof rpc.method !== "string"
    ) {
      throw new RpcError(
        -32600,
        "需要带 id 的 A2A v1 JSON-RPC 请求；不支持通知",
      );
    }
    if (!METHODS.has(rpc.method))
      throw new RpcError(-32601, "该 A2A 方法尚不支持", rpc.id);
    if (
      (rpc.params === undefined &&
        !["ListTasks", "GetExtendedAgentCard"].includes(rpc.method)) ||
      (rpc.params !== undefined &&
        (rpc.params === null ||
          typeof rpc.params !== "object" ||
          Array.isArray(rpc.params)))
    )
      throw new RpcError(-32602, "A2A params 必须为对象", rpc.id);
    return rpc;
  }
  calls(agentId?: string): A2aCall[] {
    this.store.pruneBodies(
      this.ctx.logCapture.body_retention_days,
      this.ctx.logCapture.body_max_size_mb,
    );
    return this.store.calls(agentId);
  }
  private startCall(
    agentId: string,
    keyId: string,
    method: string,
    body: string,
  ): A2aCall {
    const limit = Math.max(
      0,
      Math.min(Number(this.ctx.logCapture.max_body_bytes) || 0, 64 * 1024),
    );
    const call: A2aCall = {
      id: randomUUID(),
      agentId,
      keyId,
      method,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      httpStatus: null,
      taskId: null,
      contextId: null,
      state: null,
      error: null,
      requestBody: this.ctx.logCapture.capture_req_body
        ? Buffer.from(body).subarray(0, limit).toString()
        : null,
      responseBody: null,
    };
    this.store.record(call);
    return call;
  }
  private async forward(
    agent: A2aAgent,
    body: string,
    keyId: string,
    emit: (
      chunk: Buffer,
      status: number,
      contentType: string,
      extensions?: string,
    ) => Promise<void>,
    signal?: AbortSignal,
    service: ServiceParameters = { version: "1.0" },
    publicUrl?: string,
  ) {
    const rpc = this.parseRpc(body);
    const observer = new A2aObserver();
    const call = this.startCall(agent.id, keyId, String(rpc.method), body);
    const started = Date.now();
    const controller = new AbortController();
    this.active.add(controller);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.finishing.add(finished);
    const combined = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(agent.timeoutSeconds * 1000),
      ...(signal ? [signal] : []),
    ]);
    let upstream: Awaited<ReturnType<typeof a2aRequest>> | undefined;
    const collected: Buffer[] = [];
    let captured = 0;
    const limit = Math.max(
      0,
      Math.min(Number(this.ctx.logCapture.max_body_bytes) || 0, 64 * 1024),
    );
    const jsonChunks: Buffer[] = [];
    let jsonSize = 0;
    try {
      validateCapabilities(agent.card, rpc, service);
      upstream = await a2aRequest(agent.endpoint, {
        allowPrivate: agent.allowPrivateNetwork,
        token: agent.tokenCipher
          ? this.ctx.secrets.decrypt(agent.tokenCipher)
          : undefined,
        body,
        extensions: service.extensions,
        signal: combined,
      });
      call.httpStatus = upstream.statusCode;
      const contentType = String(
        upstream.headers["content-type"] ?? "application/json",
      );
      const streaming = contentType.includes("text/event-stream");
      const isJson = contentType.includes("json");
      const successful =
        upstream.statusCode >= 200 && upstream.statusCode < 300;
      const acceptedExtensions =
        typeof upstream.headers["a2a-extensions"] === "string"
          ? upstream.headers["a2a-extensions"]
          : undefined;
      if (successful && !streaming && !isJson)
        throw new RpcError(
          -32006,
          "InvalidAgentResponseError: expected JSON or SSE",
          rpc.id,
        );
      // Buffer JSON before sending headers, so protocol errors and extended cards can be handled safely.
      if (streaming || !isJson)
        await emit(
          Buffer.alloc(0),
          upstream.statusCode,
          contentType,
          acceptedExtensions,
        );
      for await (const chunk of upstream.body) {
        const bytes = Buffer.from(chunk);
        if (streaming) observer.feed(bytes);
        else {
          jsonSize += bytes.length;
          if (jsonSize > 4 * 1024 * 1024)
            throw new Error("A2A JSON 响应超过 4 MiB");
          jsonChunks.push(bytes);
        }
        if (this.ctx.logCapture.capture_res_body && captured < limit) {
          const part = bytes.subarray(0, limit - captured);
          collected.push(part);
          captured += part.length;
        }
        if (streaming || !isJson)
          await emit(bytes, upstream.statusCode, contentType);
      }
      if (!streaming && isJson && jsonSize) {
        let value: ObjectValue = {};
        const raw = Buffer.concat(jsonChunks);
        try {
          value = object(JSON.parse(raw.toString()));
          if (
            successful &&
            (value.jsonrpc !== "2.0" ||
              value.id !== rpc.id ||
              (value.result === undefined) === (value.error === undefined))
          )
            throw new Error("Invalid JSON-RPC envelope");
        } catch {
          if (successful)
            throw new RpcError(
              -32006,
              "InvalidAgentResponseError: invalid upstream JSON-RPC response",
              rpc.id,
            );
        }
        let output = raw;
        // A known A2A operation missing upstream is unsupported, not an unknown client method.
        if (object(value.error).code === -32601) {
          value.error = {
            ...object(value.error),
            code: PUSH_METHODS.has(String(rpc.method)) ? -32003 : -32004,
            message: PUSH_METHODS.has(String(rpc.method))
              ? "PushNotificationNotSupportedError"
              : "UnsupportedOperationError",
          };
          output = Buffer.from(JSON.stringify(value));
        } else if (
          successful &&
          rpc.method === "GetExtendedAgentCard" &&
          !value.error &&
          publicUrl
        ) {
          try {
            validateAgentCard(object(value.result));
          } catch {
            throw new RpcError(
              -32006,
              "InvalidAgentResponseError: invalid extended Agent Card",
              rpc.id,
            );
          }
          value.result = gatewayCard(
            object(value.result),
            publicUrl,
            this.iface(agent),
          );
          output = Buffer.from(JSON.stringify(value));
        }
        observer.observe(value);
        await emit(
          output,
          upstream.statusCode,
          contentType,
          acceptedExtensions,
        );
      }
      if (!streaming && isJson && !jsonSize)
        await emit(Buffer.alloc(0), upstream.statusCode, contentType);
      if (upstream.statusCode >= 300)
        observer.error ??= `上游 HTTP ${upstream.statusCode}`;
      // A dropped or unfinished stream is not a successfully completed task.
      if (streaming && !observer.finished)
        observer.error ??= "SSE 已结束，未观察到终态；请查询任务状态";
    } catch (error) {
      call.error = combined.aborted
        ? "调用已中断或超时；未自动重试，请查询任务状态"
        : (error instanceof Error ? error.message : String(error)).slice(
            0,
            1000,
          );
      throw error;
    } finally {
      try {
        upstream?.body.destroy();
        if (upstream) await upstream.close();
        Object.assign(call, {
          taskId: observer.taskId,
          contextId: observer.contextId,
          state: observer.state,
          durationMs: Date.now() - started,
          error: call.error ?? observer.error,
          responseBody: this.ctx.logCapture.capture_res_body
            ? Buffer.concat(collected).toString()
            : null,
        });
        this.store.record(call);
        this.store.pruneBodies(
          this.ctx.logCapture.body_retention_days,
          this.ctx.logCapture.body_max_size_mb,
        );
      } finally {
        this.active.delete(controller);
        this.finishing.delete(finished);
        finish();
      }
    }
  }
  private iface(agent: A2aAgent): ObjectValue {
    return (agent.card.supportedInterfaces as ObjectValue[]).find(
      (i) => i.protocolBinding === "JSONRPC" && i.protocolVersion === "1.0",
    )!;
  }
  private publicUrl(agent: A2aAgent, host?: string): string {
    const origin =
      process.env.FLOWLET_PUBLIC_A2A_URL ||
      (host ? `http://${host}` : undefined);
    return origin
      ? new URL(`/a2a/${agent.id}`, parseHttpUrl(origin)).href
      : `/a2a/${agent.id}`;
  }
  async invoke(id: string, rpc: unknown) {
    const value = object(rpc);
    if (
      value.method === "SendStreamingMessage" ||
      value.method === "SubscribeToTask"
    )
      throw new Error("管理台测试请使用非流式方法；流式调用使用 A2A 入口");
    const chunks: Buffer[] = [];
    let status = 200;
    await this.forward(
      this.agent(id),
      JSON.stringify(rpc),
      "admin-test",
      async (bytes, code) => {
        chunks.push(bytes);
        status = code;
      },
      undefined,
      { version: "1.0" },
      this.publicUrl(this.agent(id)),
    );
    return { status, body: JSON.parse(Buffer.concat(chunks).toString()) };
  }
  /** Separate data-plane credentials: admin/model/CLI tokens never authorize A2A traffic. */
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const match =
      /^\/a2a\/([a-z0-9][a-z0-9_-]{0,63})(\/\.well-known\/agent-card\.json)?$/.exec(
        pathname,
      );
    const send = (status: number, value: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "a2a-version": "1.0",
      });
      response.end(JSON.stringify(value));
    };
    if (!match) {
      request.resume();
      send(404, { error: "A2A route not found" });
      return;
    }
    try {
      const agent = this.agent(match[1]);
      const cardRequest = !!match[2];
      if (request.method !== (cardRequest ? "GET" : "POST")) {
        request.resume();
        response.setHeader("allow", cardRequest ? "GET" : "POST");
        send(405, { error: "Method not allowed" });
        return;
      }
      const token =
        /^Bearer (\S+)$/i.exec(
          String(request.headers.authorization ?? ""),
        )?.[1] ?? "";
      const keyId = token.startsWith("flwa2a_")
        ? this.store.authorize(hash(token), agent.id)
        : null;
      if (!keyId) {
        request.resume();
        send(401, { error: "需要具有该 Agent 权限的 Flowlet A2A 调用密钥" });
        return;
      }
      if (cardRequest) {
        // Reverse proxies should set FLOWLET_PUBLIC_A2A_URL; never trust forwarded headers.
        const origin =
          process.env.FLOWLET_PUBLIC_A2A_URL ||
          `http://${request.headers.host}`;
        const root = parseHttpUrl(origin);
        if (root.pathname !== "/")
          throw new Error("FLOWLET_PUBLIC_A2A_URL 必须是根地址");
        const gatewayUrl = new URL(`/a2a/${agent.id}`, root).href;
        send(200, gatewayCard(agent.card, gatewayUrl, this.iface(agent)));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024)
          throw new CommandError(
            413,
            "a2a_body_too_large",
            "A2A 请求超过 4 MiB",
          );
        chunks.push(Buffer.from(chunk));
      }
      const aborted = new AbortController();
      const disconnect = () => {
        if (!response.writableEnded) aborted.abort();
      };
      response.on("close", disconnect);
      try {
        await this.forward(
          agent,
          Buffer.concat(chunks).toString(),
          keyId,
          async (bytes, status, contentType, extensions) => {
            if (!response.headersSent)
              response.writeHead(status, {
                "content-type": contentType,
                "cache-control": "no-store",
                "x-accel-buffering": "no",
                "a2a-version": "1.0",
                ...(extensions ? { "a2a-extensions": extensions } : {}),
              });
            if (!response.write(bytes))
              await once(response, "drain", { signal: aborted.signal });
          },
          aborted.signal,
          {
            version: String(
              request.headers["a2a-version"] ??
                new URL(request.url ?? "/", "http://local").searchParams.get(
                  "A2A-Version",
                ) ??
                "",
            ),
            extensions: String(request.headers["a2a-extensions"] ?? ""),
          },
          this.publicUrl(agent, request.headers.host),
        );
        response.end();
      } finally {
        response.off("close", disconnect);
      }
    } catch (error) {
      if (response.headersSent) response.destroy();
      else if (error instanceof RpcError)
        send(200, {
          jsonrpc: "2.0",
          id: error.id,
          error: { code: error.code, message: error.message },
        });
      else
        send(error instanceof CommandError ? error.status : 502, {
          error:
            error instanceof CommandError
              ? error.message
              : "A2A 调用失败，请检查调用记录与上游服务",
        });
    }
  }
}

const gateways = new WeakMap<WebContext, A2aGateway>();
export function a2aGateway(ctx: WebContext): A2aGateway {
  let gateway = gateways.get(ctx);
  if (!gateway) {
    gateway = new A2aGateway(ctx);
    gateways.set(ctx, gateway);
  }
  return gateway;
}
export async function closeA2aGateway(ctx: WebContext): Promise<void> {
  await gateways.get(ctx)?.close();
}
