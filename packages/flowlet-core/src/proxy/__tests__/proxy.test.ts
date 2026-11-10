// P0 acceptance tests for the Node model proxy (docs/migration/proxy-core.md 附录 A).
//
// 全部使用本地 node:http mock 上游；不访问任何真实上游、不使用数据副本里的真实 Key。
// 运行：node --test packages/flowlet-core/src/proxy/__tests__/proxy.test.ts
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { createProxyController, type ProxyController } from "../index.ts";
import type { ModelCatalog } from "../../catalog/index.ts";
import type { SqliteStorage } from "../../storage/index.ts";
import type { JsonRow, ProxyBindConfig } from "../../types.ts";
import type { ProxyRuntimeConfigSource } from "../forward.ts";

// ─── fixtures ───────────────────────────────────────────────────────────────

const CATALOG_RAW: JsonRow = {
  schemaVersion: 1,
  models: [
    {
      id: "deepseek-v4-pro",
      ownerChannelId: "deepseek",
      modelsCnProviderId: "deepseek",
      aliases: ["deepseek-v4-pro-0813"],
    },
    {
      id: "deepseek-v4-flash",
      ownerChannelId: "deepseek",
      modelsCnProviderId: "deepseek",
      aliases: ["deepseek-v4-flash-0731", "deepseek-flash"],
    },
    {
      id: "deepseek-v4-flash-vision-exp",
      ownerChannelId: "deepseek",
      modelsCnProviderId: "deepseek",
      aliases: [],
    },
    { id: "LongCat-2.5", ownerChannelId: "longcat", modelsCnProviderId: "longcat", aliases: [] },
    { id: "qwen3.8-max", ownerChannelId: "qwen", modelsCnProviderId: "qwen-cn", aliases: [] },
  ],
};

const MODELS_CN: JsonRow = {
  providers: [
    {
      id: "deepseek",
      models: [
        { id: "deepseek-v4-pro", capabilities: { inputModalities: ["text"] }, limits: { contextTokens: 128000, maxOutputTokens: 8192 } },
        { id: "deepseek-v4-flash", capabilities: { inputModalities: ["text"] } },
        { id: "deepseek-v4-flash-vision-exp", capabilities: { inputModalities: ["text", "image"] } },
      ],
    },
    { id: "longcat", models: [{ id: "LongCat-2.5", capabilities: { inputModalities: ["text"] } }] },
    { id: "qwen-cn", models: [{ id: "qwen3.8-max", capabilities: { inputModalities: ["text"] } }] },
  ],
};

function fakeCatalog(): ModelCatalog {
  return {
    raw: () => CATALOG_RAW,
    modelsCn: () => MODELS_CN,
    modelsDev: () => null,
    routingModelId: (name: string) => name,
    isSupported: () => true,
  } as unknown as ModelCatalog;
}

class FakeRuntimeConfig implements ProxyRuntimeConfigSource {
  value: JsonRow;
  constructor(value: JsonRow) {
    this.value = value;
  }
  snapshot(): JsonRow {
    return this.value;
  }
  replace(snapshot: JsonRow): void {
    this.value = snapshot;
  }
  update(mutate: (draft: JsonRow) => void): void {
    const draft = JSON.parse(JSON.stringify(this.value)) as JsonRow;
    mutate(draft);
    this.value = draft;
  }
}

class FakeStorage {
  logs: JsonRow[] = [];
  usage: JsonRow[] = [];
  updates: { requestId: string; patch: JsonRow }[] = [];
  appMeta: Record<string, string> = {};
  channelModels: JsonRow[] = [];
  sessionMetadata: JsonRow[] = [];
  insertRequestLog(row: JsonRow): string {
    this.logs.push({ ...row });
    return `log-${this.logs.length}`;
  }
  insertUsageRecord(row: JsonRow): void {
    this.usage.push({ ...row });
  }
  updateRequestLogTiming(requestId: string, patch: JsonRow): void {
    this.updates.push({ requestId, patch: { ...patch } });
  }
  upsertAgentSessionMetadata(row: JsonRow): void {
    this.sessionMetadata.push({ ...row });
  }
  upsertUsageRecordWithMetadata(row: JsonRow, status: string, source: string): void {
    this.usage.push({ ...row, usage_status: status, usage_source: source });
  }
  getAppMeta(key: string): string | null {
    return this.appMeta[key] ?? null;
  }
  listChannelModels(): JsonRow[] {
    return this.channelModels;
  }
}

interface MockRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface MockUpstream {
  port: number;
  requests: MockRequest[];
  close(): Promise<void>;
}

type MockHandler = (
  req: MockRequest,
  res: http.ServerResponse,
) => void | Promise<void>;

async function startMockUpstream(handler: MockHandler): Promise<MockUpstream> {
  const requests: MockRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const mockReq: MockRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(mockReq);
      void handler(mockReq, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
  });
  res.end(body);
}

function channelRow(port: number, overrides: JsonRow = {}): JsonRow {
  return {
    id: "mock",
    name: "Mock",
    vendor: "mock",
    supported_protocols: ["openai", "anthropic", "responses"],
    openai_base_url: `http://127.0.0.1:${port}/v1`,
    anthropic_base_url: `http://127.0.0.1:${port}`,
    openai_auth: "bearer",
    anthropic_auth: "x_api_key",
    timeout_seconds: null,
    supports_files_api: false,
    enabled: true,
    ...overrides,
  };
}

function accountRow(overrides: JsonRow = {}): JsonRow {
  return {
    id: "acc",
    channel_id: "mock",
    name: "Account",
    api_key: "upstream-key",
    enabled: true,
    priority: 0,
    credential_status: "healthy",
    created_at: "2026-01-01T00:00:00Z",
    last_error: null,
    use_upstream_proxy: false,
    base_url_override: null,
    anthropic_base_url_override: null,
    ...overrides,
  };
}

function routeRow(overrides: JsonRow = {}): JsonRow {
  return {
    id: "route-1",
    virtual_model_id: "deepseek-v4-pro",
    channel_id: "mock",
    account_id: "acc",
    upstream_model: "deepseek-v4-pro",
    client_protocol: "openai",
    priority: 0,
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

interface ProxyFixture {
  storage: FakeStorage;
  runtime: FakeRuntimeConfig;
  controller: ProxyController;
  port: number;
  factory: FakeRuntimeConfig["value"];
}

async function startProxy(options: {
  upstreamPort: number;
  channels?: JsonRow[];
  accounts?: JsonRow[];
  routes?: JsonRow[];
  rules?: JsonRow[];
  channelOverrides?: JsonRow;
  token?: string;
}): Promise<ProxyFixture> {
  const token = options.token ?? "client-token";
  const snapshot: JsonRow = {
    channels: options.channels ?? [channelRow(options.upstreamPort, options.channelOverrides)],
    accounts: options.accounts ?? [accountRow()],
    routes: options.routes ?? [routeRow()],
    rules: options.rules ?? [],
    virtual_models: [],
  };
  const storage = new FakeStorage();
  const runtime = new FakeRuntimeConfig(snapshot);
  const bindConfig: ProxyBindConfig = {
    host: "127.0.0.1",
    port: await freePort(),
    allow_lan: false,
    default_client_token: token,
  };
  const controller = createProxyController({
    storage: storage as unknown as SqliteStorage,
    catalog: fakeCatalog(),
    runtimeConfig: runtime,
    clientToken: token,
    bindConfig,
  });
  await controller.start();
  const port = controller.bindConfig().port;
  return { storage, runtime, controller, port, factory: snapshot };
}

// ─── client helpers ─────────────────────────────────────────────────────────

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  chunks: Buffer[];
  firstChunkDelayMs: number;
}

function request(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    token?: string | null;
    onChunk?: (chunk: Buffer) => void;
  },
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const started = Date.now();
    const headers: Record<string, string> = {
      ...(options.token === null
        ? {}
        : { authorization: `Bearer ${options.token ?? "client-token"}` }),
      ...(options.headers ?? {}),
    };
    const clientReq = http.request(
      { host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        let firstChunkAt: number | null = null;
        res.on("data", (chunk: Buffer) => {
          if (firstChunkAt === null) firstChunkAt = Date.now();
          chunks.push(chunk);
          options.onChunk?.(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            chunks,
            firstChunkDelayMs: firstChunkAt === null ? -1 : firstChunkAt - started,
          });
        });
        res.on("error", reject);
      },
    );
    clientReq.on("error", reject);
    if (options.body !== undefined) clientReq.write(options.body);
    clientReq.end();
  });
}

function openAbortableRequest(
  port: number,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
    onChunk?: (chunk: Buffer) => void;
  },
): { done: Promise<RawResponse | null>; abort: () => void } {
  let clientReq: http.ClientRequest | null = null;
  let aborted = false;
  const done = new Promise<RawResponse | null>((resolve) => {
    const started = Date.now();
    clientReq = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: {
          authorization: "Bearer client-token",
          ...(options.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let firstChunkAt: number | null = null;
        res.on("data", (chunk: Buffer) => {
          if (firstChunkAt === null) firstChunkAt = Date.now();
          chunks.push(chunk);
          options.onChunk?.(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            chunks,
            firstChunkDelayMs: firstChunkAt === null ? -1 : firstChunkAt - started,
          });
        });
        res.on("error", () => resolve(null));
        res.on("close", () => {
          if (!res.complete) resolve(null);
        });
      },
    );
    clientReq.on("error", () => resolve(null));
    if (options.body !== undefined) clientReq.write(options.body);
    clientReq.end();
  });
  return {
    done,
    abort: () => {
      aborted = true;
      void aborted;
      clientReq?.destroy();
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sseData(events: string[], done = false): string {
  const lines = events.map((event) => `data: ${event}\n\n`).join("");
  return done ? `${lines}data: [DONE]\n\n` : lines;
}

function baseChatBody(model = "deepseek-v4-pro"): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: "hi" }],
  });
}

function findLog(storage: FakeStorage, predicate: (row: JsonRow) => boolean): JsonRow | undefined {
  return storage.logs.find(predicate);
}

function decodedBase64(bodyBase64: string | null | undefined): string {
  return bodyBase64 === null || bodyBase64 === undefined ? "" : Buffer.from(bodyBase64, "base64").toString("utf8");
}

// ─── tests ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

test("A1: start 幂等 + 无账号/无路由也能监听，空模型列表合法", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, {}));
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    channels: [],
    accounts: [],
    routes: [],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  // 第二次 start 不应重复绑定/抛错。
  await proxy.controller.start();
  assert.equal(proxy.controller.status().running, true);

  const health = await request(proxy.port, { path: "/health", token: null });
  assert.equal(health.status, 200);
  assert.equal(health.body.toString("utf8"), "ok");

  const openaiModels = await request(proxy.port, { path: "/v1/models" });
  assert.equal(openaiModels.status, 200);
  assert.deepEqual(JSON.parse(openaiModels.body.toString("utf8")), { object: "list", data: [] });

  const anthropicModels = await request(proxy.port, {
    path: "/anthropic/v1/models",
    headers: { "x-api-key": "client-token" },
    token: null,
  });
  assert.equal(anthropicModels.status, 200);
  const anthropicBody = JSON.parse(anthropicModels.body.toString("utf8")) as JsonRow;
  assert.deepEqual(anthropicBody.data, []);
  assert.equal(anthropicBody.has_more, false);
  assert.equal(anthropicBody.first_id, "");
  assert.equal(anthropicBody.last_id, "");

  // stop 幂等。
  await proxy.controller.stop();
  await proxy.controller.stop();
  assert.equal(proxy.controller.status().running, false);
});

test("client token 鉴权：错误 token 401，/health 免鉴权", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, {}));
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const unauthorized = await request(proxy.port, {
    path: "/v1/models",
    token: null,
  });
  assert.equal(unauthorized.status, 401);
  const body = JSON.parse(unauthorized.body.toString("utf8")) as JsonRow;
  assert.equal(body.error.code, "invalid_api_key");
  assert.equal(body.error.type, "authentication_error");

  const wrong = await request(proxy.port, { path: "/v1/models", token: "wrong-token" });
  assert.equal(wrong.status, 401);

  const health = await request(proxy.port, { path: "/health", token: null });
  assert.equal(health.status, 200);
});

test("A2/P0-4: 非流式透传状态/头/body，替换客户端凭据并改写模型（捕获最终上游请求）", async () => {
  const upstream = await startMockUpstream((_req, res) => {
    jsonResponse(res, 201, { ok: true, echoed: "upstream" });
  });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    routes: [routeRow({ upstream_model: "deepseek-v4-pro-0813" })],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions?trace=1",
    headers: {
      "content-type": "application/json",
      "x-flowlet-client": "pi",
      "x-flowlet-session": "local-session",
      "x-deepseek-harness-session-id": "dsh-native-session",
      "user-agent": "OpenAI/JS 6.26.0",
    },
    body: baseChatBody(),
  });

  assert.equal(response.status, 201);
  assert.equal(upstream.requests.length, 1);
  const seen = upstream.requests[0];
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/v1/chat/completions?trace=1");
  assert.equal(seen.headers.authorization, "Bearer upstream-key");
  assert.equal(seen.headers["x-flowlet-client"], undefined);
  assert.equal(seen.headers["x-flowlet-session"], undefined);
  // DSH 原生会话头必须原样透传，UA 也保留。
  assert.equal(seen.headers["x-deepseek-harness-session-id"], "dsh-native-session");
  assert.equal(seen.headers["user-agent"], "OpenAI/JS 6.26.0");
  // 请求侧 content-length 被丢弃后由客户端按最终 body 重算。
  const forwarded = JSON.parse(seen.body.toString("utf8")) as JsonRow;
  assert.equal(forwarded.model, "deepseek-v4-pro-0813");
  assert.equal(seen.headers["content-length"], String(seen.body.length));

  // 客户端收到 mock 的状态/头/body（body 逐字节）。
  assert.equal(response.body.toString("utf8"), JSON.stringify({ ok: true, echoed: "upstream" }));
  assert.match(String(response.headers["content-type"]), /application\/json/);

  // 日志捕获必须来自最终上游请求：URL/鉴权/model 都是改写后的值。
  const log = findLog(proxy.storage, (row) => row.is_last_attempt && row.status === 201);
  assert.ok(log, "应有成功请求日志");
  assert.equal(log.public_model, "deepseek-v4-pro");
  assert.equal(log.virtual_model, "deepseek-v4-pro");
  assert.equal(log.upstream_model, "deepseek-v4-pro-0813");
  assert.equal(log.route_reason, "direct");
  assert.equal(log.attempt_seq, 0);
  assert.equal(log.fallback_count, 0);
  assert.equal(log.channel_id, "mock");
  assert.equal(log.account_id, "acc");
  assert.match(String(log.upstream_url), /\/v1\/chat\/completions\?trace=1$/);
  assert.ok(typeof log.ttfb_ms === "number" && typeof log.duration_ms === "number");
  const capturedHeaders = JSON.parse(String(log.req_headers_json)) as JsonRow;
  assert.equal(capturedHeaders.authorization, "Bearer upstream-key");
  assert.equal(capturedHeaders["x-flowlet-client"], undefined);
});

test("P0-5: 同模型账号 429 → 下一个账号成功（fallback 日志链）", async () => {
  const upstream = await startMockUpstream((req, res) => {
    if (req.headers.authorization === "Bearer key-a") {
      jsonResponse(res, 429, { error: { message: "rate limited" } });
      return;
    }
    jsonResponse(res, 200, { ok: true, key: req.headers.authorization });
  });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    accounts: [
      accountRow({ id: "acc-a", name: "A", api_key: "key-a", priority: 0 }),
      accountRow({ id: "acc-b", name: "B", api_key: "key-b", priority: 1 }),
    ],
    routes: [
      routeRow({ id: "r-a", account_id: "acc-a" }),
      routeRow({ id: "r-b", account_id: "acc-b" }),
    ],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
  });
  assert.equal(response.status, 200);
  assert.equal((JSON.parse(response.body.toString("utf8")) as JsonRow).key, "Bearer key-b");
  assert.equal(upstream.requests.length, 2);

  await waitFor(() =>
    proxy.storage.logs.some((row) => row.route_reason === "retryable_status"),
  );
  const fallback = findLog(proxy.storage, (row) => row.route_reason === "retryable_status");
  assert.ok(fallback);
  assert.equal(fallback.status, 429);
  assert.equal(fallback.is_last_attempt, false);
  assert.equal(fallback.attempt_seq, 1);
  assert.equal(fallback.fallback_count, 1);
  assert.equal(fallback.account_id, "acc-a");
  const success = findLog(proxy.storage, (row) => row.status === 200 && row.is_last_attempt);
  assert.ok(success);
  assert.equal(success.route_reason, "fallback_success");
  assert.equal(success.account_id, "acc-b");
});

test("P0-6: 同规范模型跨上游变体降级", async () => {
  const upstream = await startMockUpstream((req, res) => {
    const body = JSON.parse(req.body.toString("utf8")) as JsonRow;
    if (body.model === "deepseek-v4-pro") {
      jsonResponse(res, 429, { error: { message: "rate limited" } });
      return;
    }
    jsonResponse(res, 200, { ok: true, model: body.model });
  });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    routes: [
      routeRow({ id: "r-variant-a", upstream_model: "deepseek-v4-pro", priority: 0 }),
      routeRow({ id: "r-variant-b", upstream_model: "deepseek-v4-pro-0813", priority: 1 }),
    ],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
  });
  assert.equal(response.status, 200);
  assert.equal((JSON.parse(response.body.toString("utf8")) as JsonRow).model, "deepseek-v4-pro-0813");
  assert.equal(upstream.requests.length, 2);

  await waitFor(() => proxy.storage.logs.some((row) => row.is_last_attempt && row.status === 200));
  const success = findLog(proxy.storage, (row) => row.is_last_attempt && row.status === 200);
  assert.ok(success);
  assert.equal(success.upstream_model, "deepseek-v4-pro-0813");
  assert.equal(success.route_reason, "fallback_success");
  assert.equal(success.fallback_count, 1);
});

test("P0-7: 401 标记 invalid_key 并从下一请求候选池排除", async () => {
  const upstream = await startMockUpstream((req, res) => {
    if (req.headers.authorization === "Bearer key-a") {
      jsonResponse(res, 401, { error: { message: "invalid key" } });
      return;
    }
    jsonResponse(res, 200, { ok: true, key: req.headers.authorization });
  });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    accounts: [
      accountRow({ id: "acc-a", name: "A", api_key: "key-a", priority: 0 }),
      accountRow({ id: "acc-b", name: "B", api_key: "key-b", priority: 1 }),
    ],
    routes: [
      routeRow({ id: "r-a", account_id: "acc-a" }),
      routeRow({ id: "r-b", account_id: "acc-b" }),
    ],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const first = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
  });
  // 401 不 fallback，直接透传给客户端；账号被标记。
  assert.equal(first.status, 401);
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].headers.authorization, "Bearer key-a");
  await waitFor(() =>
    (proxy.runtime.snapshot().accounts as JsonRow[]).some(
      (account) => account.id === "acc-a" && account.credential_status === "invalid_key",
    ),
  );

  const second = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
  });
  assert.equal(second.status, 200);
  assert.equal(upstream.requests.length, 2);
  assert.equal(upstream.requests[1].headers.authorization, "Bearer key-b");
});

test("P0-8: 图片请求到纯文本模型被拒绝，且不发起上游调用", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, {}));
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const body = JSON.stringify({
    model: "deepseek-v4-pro",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ],
  });
  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(response.status, 400);
  const payload = JSON.parse(response.body.toString("utf8")) as JsonRow;
  assert.equal(payload.error.code, "model_input_modality_unsupported");
  assert.equal(upstream.requests.length, 0);

  await waitFor(() =>
    proxy.storage.logs.some((row) => row.route_reason === "input_modality_image_unsupported"),
  );
  const skipped = findLog(
    proxy.storage,
    (row) => row.route_reason === "input_modality_image_unsupported",
  );
  assert.ok(skipped);
  assert.equal(skipped.status, null);
  assert.equal(skipped.upstream_url, null);
  assert.equal(skipped.req_headers_json, null);
  assert.equal(skipped.is_last_attempt, false);
  const terminal = findLog(
    proxy.storage,
    (row) => row.route_reason === "model_input_modality_unsupported",
  );
  assert.ok(terminal);
  assert.equal(terminal.status, 400);
  assert.equal(terminal.attempt_seq, 1);
  assert.equal(terminal.fallback_count, 1);
});

test("P0-9: 协议不匹配记录 skipped 节点 + 终态 model_protocol_unsupported", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, {}));
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, {
    method: "POST",
    path: "/anthropic/v1/messages",
    headers: { "content-type": "application/json", "x-api-key": "client-token" },
    token: null,
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(response.status, 404);
  const payload = JSON.parse(response.body.toString("utf8")) as JsonRow;
  assert.equal(payload.type, "error");
  assert.equal(payload.error.type, "model_protocol_unsupported");
  assert.equal(upstream.requests.length, 0);

  await waitFor(() =>
    proxy.storage.logs.some((row) => row.route_reason === "protocol_unsupported"),
  );
  const skipped = findLog(proxy.storage, (row) => row.route_reason === "protocol_unsupported");
  assert.ok(skipped);
  assert.equal(skipped.attempt_seq, 0);
  assert.equal(skipped.fallback_count, 1);
  assert.equal(skipped.status, null);
  assert.equal(skipped.channel_id, "mock");
  const terminal = findLog(
    proxy.storage,
    (row) => row.route_reason === "model_protocol_unsupported",
  );
  assert.ok(terminal);
  assert.equal(terminal.status, 404);
  assert.equal(terminal.is_last_attempt, true);
  assert.equal(terminal.attempt_seq, 1);
});

test("P0-10: 入站别名归一到规范模型后命中路由", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    routes: [routeRow({ upstream_model: "deepseek-v4-pro-0813" })],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody("deepseek-v4-pro-0813"),
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.requests.length, 1);
  const forwarded = JSON.parse(upstream.requests[0].body.toString("utf8")) as JsonRow;
  assert.equal(forwarded.model, "deepseek-v4-pro-0813");

  await waitFor(() => proxy.storage.logs.some((row) => row.is_last_attempt && row.status === 200));
  const log = findLog(proxy.storage, (row) => row.is_last_attempt && row.status === 200);
  assert.ok(log);
  assert.equal(log.public_model, "deepseek-v4-pro-0813");
  assert.equal(log.virtual_model, "deepseek-v4-pro");
});

test("P0-13: DeepSeek 推理模型 OpenAI 路由回填 reasoning_content（已有值不改）", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const body = JSON.stringify({
    model: "deepseek-v4-pro",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "second" },
      { role: "assistant", content: "answer-2", reasoning_content: "keep-me" },
    ],
  });
  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(response.status, 200);
  const forwarded = JSON.parse(upstream.requests[0].body.toString("utf8")) as JsonRow;
  const messages = forwarded.messages as JsonRow[];
  assert.equal(messages[1].reasoning_content, "");
  assert.equal(messages[3].reasoning_content, "keep-me");
});

test("P0-14: 非 DeepSeek 路由不改写 assistant 消息（请求体逐字节不变）", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    routes: [
      routeRow({ virtual_model_id: "LongCat-2.5", upstream_model: "LongCat-2.5" }),
    ],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const body = JSON.stringify({
    model: "LongCat-2.5",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer-1" },
    ],
  });
  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(response.status, 200);
  // model 未变化 → 文本替换后与入站字节完全一致。
  assert.equal(upstream.requests[0].body.toString("utf8"), body);
});

test("P0-11: Anthropic content_block_start 补字段，但日志捕获保留上游原文", async () => {
  const upstreamSse = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"read"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
  const upstream = await startMockUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const chunk of upstreamSse.match(/[\s\S]{1,17}/g) ?? []) res.write(chunk);
    res.end();
  });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    routes: [
      routeRow({
        virtual_model_id: "deepseek-v4-pro",
        client_protocol: "anthropic",
        upstream_model: "deepseek-v4-pro",
      }),
    ],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, {
    method: "POST",
    path: "/anthropic/v1/messages",
    headers: { "content-type": "application/json", "x-api-key": "client-token" },
    token: null,
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(response.status, 200);
  const clientText = response.body.toString("utf8");
  assert.ok(clientText.includes('"thinking":""'), `客户端流应补 thinking: ${clientText}`);
  assert.ok(clientText.includes('"input":{}'), `客户端流应补 input: ${clientText}`);
  // content-length 在修复路径必须删除（长度发生变化）。
  assert.equal(response.headers["content-length"], undefined);

  await waitFor(() => proxy.storage.updates.length > 0);
  const patch = proxy.storage.updates[0].patch;
  const captured = decodedBase64(patch.res_body_b64 as string);
  assert.equal(captured, upstreamSse, "日志捕获必须是上游原始字节（未修复）");
});

test("P0-12: 流式每块重置空闲超时（慢块流不被总超时截断）", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    for (let i = 0; i < 4; i += 1) {
      res.write(sseData([JSON.stringify({ choices: [{ delta: { content: `t${i}` } }] })]));
      await delay(220);
    }
    res.write(sseData([JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } })], true));
    res.end();
  });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    channelOverrides: { timeout_seconds: 1 },
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
  });
  assert.equal(response.status, 200);
  assert.ok(response.body.toString("utf8").includes("data: [DONE]"));
  assert.ok(response.chunks.length >= 2, "应逐块转发而不是整包缓冲");

  await waitFor(() => proxy.storage.updates.length > 0);
  const patch = proxy.storage.updates[0].patch;
  assert.equal(typeof patch.duration_ms, "number");
  assert.equal(patch.route_reason ?? null, null);
  // usage 完整。
  await waitFor(() => proxy.storage.usage.length > 0);
  assert.equal(proxy.storage.usage[0].usage_status, "complete");
  assert.equal(proxy.storage.usage[0].input_tokens, 5);
  assert.equal(proxy.storage.usage[0].output_tokens, 7);
});

test("P0-12b: 流式空闲超时 → stream_timeout 并中止下游", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    res.write(sseData([JSON.stringify({ choices: [{ delta: { content: "start" } }] })]));
    await delay(1400);
    res.end();
  });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    channelOverrides: { timeout_seconds: 1 },
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
  }).catch(() => null);
  // 超时会异常终止连接（Rust 同样让客户端看到断连）。
  assert.equal(response, null);

  await waitFor(() => proxy.storage.updates.length > 0);
  assert.equal(proxy.storage.updates[0].patch.route_reason, "stream_timeout");
});

test("P0-16: 收到 [DONE] 后下游断开仍记为 complete", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    res.write(
      sseData([
        JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
      ], true),
    );
    await delay(800);
    res.end();
  });
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  let sawDone = false;
  const handle = openAbortableRequest(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
    onChunk: (chunk) => {
      if (chunk.toString("utf8").includes("data: [DONE]")) sawDone = true;
    },
  });
  await waitFor(() => sawDone);
  handle.abort();
  await handle.done;

  await waitFor(() => proxy.storage.updates.length > 0);
  const patch = proxy.storage.updates[0].patch;
  assert.equal(patch.route_reason ?? null, null);
  assert.equal(patch.error_message ?? null, null);
  await waitFor(() => proxy.storage.usage.length > 0);
  assert.equal(proxy.storage.usage[0].usage_status, "complete");
  assert.equal(proxy.storage.usage[0].output_tokens, 4);
});

test("P0-17: 下游中途断开保留已收 partial usage", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    // Anthropic 形状：message_start 只有输入 token，先发 usage 再断开。
    res.write(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
    );
    res.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n',
    );
    await delay(1000);
    res.end();
  });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    routes: [
      routeRow({ client_protocol: "anthropic", upstream_model: "deepseek-v4-pro" }),
    ],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  let received = "";
  const handle = openAbortableRequest(proxy.port, {
    method: "POST",
    path: "/anthropic/v1/messages",
    headers: { "content-type": "application/json", "x-api-key": "client-token" },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    }),
    onChunk: (chunk) => {
      received += chunk.toString("utf8");
    },
  });
  // openAbortableRequest 固定带 bearer token；这里改用 direct http 请求以走 x-api-key 也可，
  // bearer 同样通过 client token 鉴权（identifyClient 先看 Authorization）。
  await waitFor(() => received.includes("hello"));
  handle.abort();
  await handle.done;

  await waitFor(() => proxy.storage.updates.length > 0);
  const patch = proxy.storage.updates[0].patch;
  assert.equal(patch.route_reason, "stream_cancelled");
  await waitFor(() => proxy.storage.usage.length > 0);
  const usage = proxy.storage.usage[0];
  assert.equal(usage.usage_status, "partial");
  assert.equal(usage.input_tokens, 11);
  assert.equal(usage.output_tokens, null);
  assert.equal(usage.total_tokens, null);
});

test("P0-15: gzip 响应字节原样透传，usage 从解压体解析", async () => {
  const payload = { id: "cmpl-1", usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 }, text: "hi" };
  const gzip = zlib.gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const upstream = await startMockUpstream((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(gzip.length),
    });
    res.end(gzip);
  });
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const body = baseChatBody();
  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.equal(response.body.length, gzip.length);
  assert.ok(response.body.equals(gzip), "客户端收到的压缩字节必须与上游一致");

  await waitFor(() => proxy.storage.usage.length > 0);
  const usage = proxy.storage.usage[0];
  assert.equal(usage.input_tokens, 12);
  assert.equal(usage.output_tokens, 34);
  assert.equal(usage.total_tokens, 46);
  // 日志 body 是解压后的内容（不是压缩字节）。
  await waitFor(() =>
    proxy.storage.logs.some((row) => row.is_last_attempt && typeof row.res_body_b64 === "string"),
  );
  const log = findLog(
    proxy.storage,
    (row) => row.is_last_attempt && typeof row.res_body_b64 === "string",
  );
  assert.ok(log);
  const captured = JSON.parse(decodedBase64(log.res_body_b64 as string)) as JsonRow;
  assert.equal(captured.id, "cmpl-1");
});

test("P0-18/19: 剥离本地 Agent 身份头，DSH 原生会话头透传", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      "x-flowlet-client": "pi",
      "x-flowlet-session": "session-1",
      "x-deepseek-harness-session-id": "native-1",
      "user-agent": "deepseek-harness/0.2.1",
      "anthropic-beta": "prompt-caching-2024-07-31, context-1m-2025-08-07",
    },
    body: baseChatBody(),
  });
  const seen = upstream.requests[0];
  assert.equal(seen.headers["x-flowlet-client"], undefined);
  assert.equal(seen.headers["x-flowlet-session"], undefined);
  assert.equal(seen.headers["x-deepseek-harness-session-id"], "native-1");
  assert.equal(seen.headers["user-agent"], "deepseek-harness/0.2.1");
  // context-1m beta 被剔除，其余 beta 保留。
  assert.equal(seen.headers["anthropic-beta"], "prompt-caching-2024-07-31");
});

test("会话元数据：按会话身份派生标题与项目路径并 upsert，无会话身份不写", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  // 真实 Claude Code 请求形态：system 消息里带工作目录，user 消息里带环境提醒块。
  const body = JSON.stringify({
    model: "deepseek-v4-pro",
    system: [
      {
        type: "text",
        text: "# Environment\nPrimary working directory: /home/dev/projects/flowlet\nIs a git repository: true",
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>会话开始时的上下文提示</system-reminder>" },
          { type: "text", text: "修复登录超时的重试逻辑" },
        ],
      },
    ],
  });
  await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      "x-claude-code-session-id": "claude-session-1",
      "user-agent": "claude-cli/2.1.322 (external, sdk-cli)",
    },
    body,
  });
  assert.equal(proxy.storage.sessionMetadata.length, 1);
  const meta = proxy.storage.sessionMetadata[0];
  assert.equal(meta.agent_type, "claude-code");
  assert.equal(meta.session_id, "claude-session-1");
  assert.equal(meta.title, "修复登录超时的重试逻辑");
  assert.equal(meta.project_path, "/home/dev/projects/flowlet");
  assert.equal(meta.source, "derived");

  // 未识别出会话身份（无会话头）时不写元数据：元数据必须能归属到具体会话行。
  await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
  });
  assert.equal(proxy.storage.sessionMetadata.length, 1);
});

test("P0-20: 未开放模型详情返回 404 model_not_found", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, {}));
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, { path: "/v1/models/not-exposed" });
  assert.equal(response.status, 404);
  const payload = JSON.parse(response.body.toString("utf8")) as JsonRow;
  assert.equal(payload.error.code, "model_not_found");
  assert.equal(payload.error.param, "model");

  // 已开放模型详情返回 200（无 models-cn 规格时字段为 null）。
  const open = await request(proxy.port, { path: "/v1/models/deepseek-v4-pro" });
  assert.equal(open.status, 200);
  const detail = JSON.parse(open.body.toString("utf8")) as JsonRow;
  assert.equal(detail.id, "deepseek-v4-pro");
  assert.equal(detail.object, "model");
  assert.equal(detail.specification_source, "models-cn");
  assert.equal(detail.context_window, 128000);
  assert.equal(detail.max_output_tokens, 8192);
  assert.equal(detail.max_input_tokens, null);
});

test("P0-4b: SSE 原样透传（分块 + [DONE]），首块在流结束前到达", async () => {
  const events = [
    JSON.stringify({ choices: [{ delta: { content: "He" } }] }),
    JSON.stringify({ choices: [{ delta: { content: "llo" } }] }),
  ];
  const full = sseData(events, true);
  let firstChunkSentAt = 0;
  let finishedAt = 0;
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    res.write(full.slice(0, 20));
    firstChunkSentAt = Date.now();
    await delay(150);
    res.write(full.slice(20, 60));
    await delay(150);
    res.write(full.slice(60));
    await delay(150);
    finishedAt = Date.now();
    res.end();
  });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    channelOverrides: { timeout_seconds: 5 },
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const requestStartedAt = Date.now();
  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.toString("utf8"), full);
  assert.ok(response.chunks.length >= 2, "SSE 必须逐块透传");
  // firstChunkDelayMs 是「请求开始 → 首块到达客户端」的耗时；直接和「上游结束时刻」比较，
  // 不要再用响应结束时刻反推首块时刻——高负载下毫秒抖动会让原写法退化成 0ms 级误判。
  assert.ok(
    response.firstChunkDelayMs >= 0 &&
      response.firstChunkDelayMs < finishedAt - requestStartedAt,
    "首块必须在流结束前到达客户端",
  );

  // 首条流式日志在开始转发前已写入（duration=null），结束后回填。
  const initial = findLog(proxy.storage, (row) => row.is_stream === true && row.duration_ms === null);
  assert.ok(initial, "流式开始时应先写入未完成日志");
  assert.equal(initial.status, 200);
  await waitFor(() => proxy.storage.updates.length > 0);
  assert.equal(typeof proxy.storage.updates[0].patch.duration_ms, "number");
});

test("P0-1b: 无可用账号 / 无开放模型 / 模型未开放 错误码区分", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, {}));

  // 无可用账号（有路由但账号 disabled）
  const noAccount = await startProxy({
    upstreamPort: upstream.port,
    accounts: [accountRow({ enabled: false })],
  });
  const r1 = await request(noAccount.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
  });
  assert.equal(r1.status, 404);
  assert.equal((JSON.parse(r1.body.toString("utf8")) as JsonRow).error.code, "no_available_account");
  await noAccount.controller.stop();

  // 有可用账号但没有任何开放模型
  const noModel = await startProxy({
    upstreamPort: upstream.port,
    routes: [],
  });
  const r2 = await request(noModel.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
  });
  assert.equal(r2.status, 404);
  assert.equal((JSON.parse(r2.body.toString("utf8")) as JsonRow).error.code, "no_available_model");
  await noModel.controller.stop();

  // 有模型但请求了未开放的模型名（未登记别名 → 原样 → model_not_exposed）
  const notExposed = await startProxy({ upstreamPort: upstream.port });
  const r3 = await request(notExposed.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody("unregistered-model"),
  });
  assert.equal(r3.status, 404);
  assert.equal((JSON.parse(r3.body.toString("utf8")) as JsonRow).error.code, "model_not_exposed");
  await notExposed.controller.stop();

  await upstream.close();
});

test("Responses 协议：非 POST 返回 405 responses_unsupported_method", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, {}));
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, { method: "GET", path: "/v1/responses/resp_1" });
  assert.equal(response.status, 405);
  assert.equal(
    (JSON.parse(response.body.toString("utf8")) as JsonRow).error.code,
    "responses_unsupported_method",
  );
  assert.equal(upstream.requests.length, 0);
});

test("Responses 回放兼容：非法 input[*].status 在转发前归一", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    routes: [routeRow({ client_protocol: "responses" })],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const body = JSON.stringify({
    model: "deepseek-v4-pro",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      // 上游曾返回的坏 item 形态：status: null + encrypted_content: null
      {
        type: "reasoning",
        id: "msg_6679bf3e",
        summary: [],
        status: null,
        encrypted_content: null,
        content: [{ type: "reasoning_text", text: "thought" }],
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
      { type: "function_call", call_id: "c1", name: "bash", arguments: "{}", status: "" },
    ],
  });
  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/responses",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.requests.length, 1);

  const forwarded = JSON.parse(upstream.requests[0].body.toString("utf8")) as JsonRow;
  const items = forwarded.input as JsonRow[];
  // null → completed，并清掉 encrypted_content: null
  assert.equal(items[1].status, "completed");
  assert.equal(Object.prototype.hasOwnProperty.call(items[1], "encrypted_content"), false);
  // 合法 status 不动
  assert.equal(items[2].status, "completed");
  // 空串同样归一
  assert.equal(items[3].status, "completed");
  // item 顺序、id 与内容不动
  assert.equal(items[1].id, "msg_6679bf3e");
  assert.equal((items[1].content as JsonRow[])[0].text, "thought");
});

test("Responses 回放兼容：无需归一或非 Responses 协议时请求体逐字节不变", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    routes: [routeRow({ client_protocol: "responses" })],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const clean = JSON.stringify({
    model: "deepseek-v4-pro",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
  });
  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/responses",
    headers: { "content-type": "application/json" },
    body: clean,
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.requests[0].body.toString("utf8"), clean);
});

test("P1: Anthropic thinking 回填（当前用户轮补空块，已完成轮次不动）", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    routes: [
      routeRow({
        virtual_model_id: "deepseek-v4-pro",
        client_protocol: "anthropic",
        upstream_model: "deepseek-v4-pro",
      }),
    ],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const body = JSON.stringify({
    model: "deepseek-v4-pro",
    max_tokens: 64,
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [
      { role: "user", content: "q1" },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: "q2" },
      { role: "assistant", content: [{ type: "text", text: "a2" }] },
    ],
  });
  const response = await request(proxy.port, {
    method: "POST",
    path: "/anthropic/v1/messages",
    headers: { "content-type": "application/json", "x-api-key": "client-token" },
    token: null,
    body,
  });
  assert.equal(response.status, 200);
  const forwarded = JSON.parse(upstream.requests[0].body.toString("utf8")) as JsonRow;
  const messages = forwarded.messages as JsonRow[];
  // 当前轮（最后一条 user 之后）补 thinking 块。
  assert.deepEqual(messages[3].content[0], { type: "thinking", thinking: "" });
  // 已完成的历史轮次不动。
  assert.deepEqual(messages[1].content, [{ type: "text", text: "a1" }]);
});

test("P1: Files API 绑定账号原样转发（upload body 不变）", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, { type: "file", id: "file_1" }));
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    channelOverrides: { supports_files_api: true },
    accounts: [
      accountRow({ id: "acc-a", name: "A", api_key: "key-a", priority: 0 }),
      accountRow({ id: "acc-b", name: "B", api_key: "key-b", priority: 1 }),
    ],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const multipart = Buffer.from(
    "--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--boundary--\r\n",
    "utf8",
  );
  const response = await request(proxy.port, {
    method: "POST",
    path: "/anthropic/v1/files",
    headers: {
      "content-type": "multipart/form-data; boundary=boundary",
      "x-api-key": "client-token",
    },
    token: null,
    body: multipart,
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].url, "/v1/files");
  assert.equal(upstream.requests[0].headers["x-api-key"], "key-a");
  assert.ok(upstream.requests[0].body.equals(multipart), "上传 body 必须原样透传");
  assert.equal(response.body.toString("utf8"), JSON.stringify({ type: "file", id: "file_1" }));

  const list = await request(proxy.port, {
    method: "GET",
    path: "/anthropic/v1/files",
    headers: { "x-api-key": "client-token" },
    token: null,
  });
  assert.equal(list.status, 200);
  assert.equal(upstream.requests[1].url, "/v1/files");
});

test("P1: 无 files 能力渠道时 Files API 返回 503 files_account_unavailable", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, {}));
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, {
    method: "GET",
    path: "/anthropic/v1/files",
    headers: { "x-api-key": "client-token" },
    token: null,
  });
  assert.equal(response.status, 503);
  const payload = JSON.parse(response.body.toString("utf8")) as JsonRow;
  assert.equal(payload.type, "error");
  assert.equal(payload.error.type, "files_account_unavailable");
  assert.equal(upstream.requests.length, 0);
});

test("P1: messages 带 files-api beta 时 pin 到绑定账号 / pin miss 回退常规路由", async () => {
  // pin 命中：两个账号都有候选，Files 绑定账号是 A，请求必须落到 A。
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    channelOverrides: { supports_files_api: true },
    accounts: [
      accountRow({ id: "acc-a", name: "A", api_key: "key-a", priority: 0 }),
      accountRow({ id: "acc-b", name: "B", api_key: "key-b", priority: 1 }),
    ],
    routes: [
      routeRow({ id: "r-a", account_id: "acc-a", client_protocol: "anthropic" }),
      routeRow({ id: "r-b", account_id: "acc-b", client_protocol: "anthropic" }),
    ],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const anthropicHeaders = {
    "content-type": "application/json",
    "x-api-key": "client-token",
    "anthropic-beta": "files-api-2025-04-14",
  };
  const body = JSON.stringify({
    model: "deepseek-v4-pro",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  });
  // 先做一次普通请求，把 round-robin 游标推进到 B。
  await request(proxy.port, {
    method: "POST",
    path: "/anthropic/v1/messages",
    headers: { "content-type": "application/json", "x-api-key": "client-token" },
    token: null,
    body,
  });
  const pinned = await request(proxy.port, {
    method: "POST",
    path: "/anthropic/v1/messages",
    headers: anthropicHeaders,
    token: null,
    body,
  });
  assert.equal(pinned.status, 200);
  assert.equal(upstream.requests[1].headers["x-api-key"], "key-a");
  await waitFor(() => proxy.storage.logs.some((row) => row.route_reason === "files_api_pinned"));
  assert.ok(findLog(proxy.storage, (row) => row.route_reason === "files_api_pinned"));

  // pin miss：绑定账号 A 没有候选（只有 B 的路由），不干预，按常规路由。
  const missUpstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  const missProxy = await startProxy({
    upstreamPort: missUpstream.port,
    channelOverrides: { supports_files_api: true },
    accounts: [
      accountRow({ id: "acc-a", name: "A", api_key: "key-a", priority: 0 }),
      accountRow({ id: "acc-b", name: "B", api_key: "key-b", priority: 1 }),
    ],
    routes: [routeRow({ id: "r-b", account_id: "acc-b", client_protocol: "anthropic" })],
  });
  cleanups.push(async () => {
    await missProxy.controller.stop();
    await missUpstream.close();
  });
  const missed = await request(missProxy.port, {
    method: "POST",
    path: "/anthropic/v1/messages",
    headers: anthropicHeaders,
    token: null,
    body,
  });
  assert.equal(missed.status, 200);
  assert.equal(missUpstream.requests[0].headers["x-api-key"], "key-b");
  await waitFor(() =>
    missProxy.storage.logs.some((row) => row.route_reason === "files_api_pin_missed"),
  );
});

test("P1: /models 过滤规则（enabled/健康账号/规范身份/去重/排序/owned_by）", async () => {
  const upstream = await startMockUpstream((_req, res) => jsonResponse(res, 200, {}));
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    channelOverrides: { vendor: "mockv" },
    accounts: [
      accountRow({ id: "acc-a", api_key: "key-a", priority: 0 }),
      accountRow({ id: "acc-b", api_key: "key-b", priority: 1, credential_status: "invalid_key" }),
    ],
    routes: [
      routeRow({ id: "r1", account_id: "acc-a" }),
      routeRow({ id: "r1-anth", account_id: "acc-a", client_protocol: "anthropic" }),
      routeRow({
        id: "r2",
        account_id: "acc-a",
        upstream_model: "deepseek-v4-pro-0813",
        created_at: "2026-01-01T00:00:00Z",
      }),
      routeRow({
        id: "r3",
        account_id: "acc-b",
        virtual_model_id: "LongCat-2.5",
        upstream_model: "LongCat-2.5",
      }),
      routeRow({
        id: "r4",
        account_id: "acc-a",
        virtual_model_id: "LongCat-2.5",
        upstream_model: "LongCat-2.5",
        enabled: false,
      }),
      routeRow({
        id: "r5",
        account_id: "acc-a",
        virtual_model_id: "qwen3.8-max",
        upstream_model: "LongCat-2.5",
      }),
    ],
  });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, { path: "/v1/models" });
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body.toString("utf8")) as JsonRow;
  assert.deepEqual(
    (payload.data as JsonRow[]).map((entry) => entry.id),
    ["deepseek-v4-pro"],
  );
  assert.equal(payload.data[0].owned_by, "mockv");
  assert.equal(payload.data[0].object, "model");
  assert.equal(payload.data[0].created, 1767225600);

  const anthropic = await request(proxy.port, {
    path: "/anthropic/v1/models",
    headers: { "x-api-key": "client-token" },
    token: null,
  });
  const anthropicPayload = JSON.parse(anthropic.body.toString("utf8")) as JsonRow;
  assert.equal(anthropicPayload.data.length, 1);
  assert.equal(anthropicPayload.data[0].id, "deepseek-v4-pro");
  assert.equal(anthropicPayload.data[0].type, "model");
  assert.equal(anthropicPayload.first_id, "deepseek-v4-pro");
  assert.equal(anthropicPayload.last_id, "deepseek-v4-pro");
});

// ─── 流式压缩 SSE 的观测解压（usage / TTFT） ────────────────────────────────

/** 按给定偏移切分 buffer（落在多字节 UTF-8 / data 行中间的切点由调用方给出）。 */
function splitBufferAt(buffer: Buffer, cuts: number[]): Buffer[] {
  const sorted = [...new Set(cuts)]
    .filter((cut) => cut > 0 && cut < buffer.length)
    .sort((left, right) => left - right);
  const pieces: Buffer[] = [];
  let start = 0;
  for (const cut of sorted) {
    pieces.push(buffer.subarray(start, cut));
    start = cut;
  }
  pieces.push(buffer.subarray(start));
  return pieces.filter((piece) => piece.length > 0);
}

/** 布局与 SSE payload 一致，但把整体 gzip 拆成多块（可跨块切在行/多字节字符中间）。 */
function streamingGzipChunks(plain: Buffer, cuts: number[]): Buffer[] {
  return splitBufferAt(plain, cuts).map((piece) => zlib.gzipSync(piece));
}

const streamingUsagePayload = (): string =>
  sseData(
    [
      JSON.stringify({ id: "chatcmpl-stream", choices: [{ delta: { content: "你好" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "，世界" } }] }),
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
      }),
    ],
    true,
  );

test("P0-15b: 流式 gzip SSE 分块观测解压 → usage 完整且客户端压缩字节逐字节一致", async () => {
  const plaintext = streamingUsagePayload();
  const plain = Buffer.from(plaintext, "utf8");
  // 一处切在“你好”的多字节 UTF-8 中间，一处切在 usage 的 data 行中间。
  const multibyteCut = plain.indexOf(Buffer.from("你", "utf8")) + 1;
  const usageLineCut = plain.indexOf(Buffer.from('"usage"', "utf8")) + 4;
  const chunks = streamingGzipChunks(plain, [multibyteCut, usageLineCut]);
  const upstreamCompressed = Buffer.concat(chunks);
  assert.ok(chunks.length >= 2, "上游应该分多块写出压缩体");

  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
      "cache-control": "no-cache",
    });
    res.flushHeaders();
    for (const chunk of chunks) {
      res.write(chunk);
      await delay(15);
    }
    res.end();
  });
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.ok(
    response.body.equals(upstreamCompressed),
    "客户端收到的压缩字节必须与上游逐字节一致",
  );

  await waitFor(() => proxy.storage.usage.length > 0);
  const usage = proxy.storage.usage[0];
  assert.equal(usage.usage_status, "complete");
  assert.equal(usage.input_tokens, 11);
  assert.equal(usage.output_tokens, 22);
  assert.equal(usage.total_tokens, 33);

  await waitFor(() => proxy.storage.updates.length > 0);
  const patch = proxy.storage.updates[0].patch;
  assert.equal(typeof patch.ttft_ms, "number", "TTFT 必须从解压后的明文里测到");
  assert.ok((patch.ttft_ms as number) >= 0);
  assert.equal(patch.route_reason ?? null, null);
  assert.equal(patch.error_message ?? null, null);
  // 日志捕获仍是解压后的 SSE 原文（捕获层自行解压，不改变既有语义）。
  assert.equal(decodedBase64(patch.res_body_b64 as string), plaintext);
});

const zstdCompressSync = (
  zlib as unknown as { zstdCompressSync?: (input: Buffer) => Buffer }
).zstdCompressSync;
const zstdSupported =
  typeof zstdCompressSync === "function" &&
  typeof (zlib as unknown as { createZstdDecompress?: unknown }).createZstdDecompress === "function";

test(
  "P0-15c: 流式 zstd SSE 分块观测解压 → usage 完整且字节逐字节一致",
  { skip: zstdSupported ? false : "当前 Node 运行时没有 zstd 支持" },
  async () => {
    const compressZstd = zstdCompressSync as (input: Buffer) => Buffer;
    const plaintext = streamingUsagePayload();
    const plain = Buffer.from(plaintext, "utf8");
    const cuts = [plain.indexOf(Buffer.from("你", "utf8")) + 1, plain.indexOf(Buffer.from('"usage"', "utf8")) + 4];
    const chunks = splitBufferAt(plain, cuts).map((piece) => compressZstd(piece));
    const upstreamCompressed = Buffer.concat(chunks);

    const upstream = await startMockUpstream(async (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "content-encoding": "zstd",
      });
      res.flushHeaders();
      for (const chunk of chunks) {
        res.write(chunk);
        await delay(15);
      }
      res.end();
    });
    const proxy = await startProxy({ upstreamPort: upstream.port });
    cleanups.push(async () => {
      await proxy.controller.stop();
      await upstream.close();
    });

    const response = await request(proxy.port, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      body: baseChatBody(),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], "zstd");
    assert.ok(response.body.equals(upstreamCompressed));

    await waitFor(() => proxy.storage.usage.length > 0);
    const usage = proxy.storage.usage[0];
    assert.equal(usage.usage_status, "complete");
    assert.equal(usage.input_tokens, 11);
    assert.equal(usage.output_tokens, 22);
    assert.equal(usage.total_tokens, 33);

    await waitFor(() => proxy.storage.updates.length > 0);
    const patch = proxy.storage.updates[0].patch;
    assert.equal(typeof patch.ttft_ms, "number");
    assert.equal(patch.route_reason ?? null, null);
  },
);

test("P0-15d: 截断的 gzip 流不崩溃，已转发字节一致且不伪造 usage", async () => {
  const events: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    events.push(JSON.stringify({ choices: [{ delta: { content: `t${index}` } }] }));
  }
  // usage 事件只在流末尾：截断后解不出它。
  events.push(
    JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 },
    }),
  );
  const plaintext = sseData(events, true);
  const compressed = zlib.gzipSync(Buffer.from(plaintext, "utf8"));
  const truncated = compressed.subarray(0, Math.floor(compressed.length * 0.4));

  const upstream = await startMockUpstream((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
    });
    res.write(truncated);
    res.end();
  });
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
  });
  assert.equal(response.status, 200, "截断压缩体不能让请求失败");
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.ok(response.body.equals(truncated), "已转发的压缩字节必须与上游一致");

  await waitFor(() => proxy.storage.updates.length > 0);
  const patch = proxy.storage.updates[0].patch;
  assert.equal(patch.route_reason ?? null, null, "上游干净结束，流本身不是 stream_error");
  assert.equal(typeof patch.duration_ms, "number");
  // 解压失败只停用观测解压：解不出终态 usage 时不写 usage 行（不伪造 complete）。
  assert.equal(proxy.storage.usage.length, 0);
});

test("P0-15e: 未知 content-encoding 不崩溃、不产生 usage，字节原样透传", async () => {
  const plaintext = streamingUsagePayload();
  // 用不被支持的算法编码，模拟上游真实发来的 `content-encoding: compress` 压缩体。
  const opaque = zlib.gzipSync(Buffer.from(plaintext, "utf8"));
  const chunks = splitBufferAt(opaque, [Math.floor(opaque.length / 2)]);

  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "content-encoding": "compress",
    });
    res.flushHeaders();
    for (const chunk of chunks) {
      res.write(chunk);
      await delay(10);
    }
    res.end();
  });
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], "compress");
  assert.ok(response.body.equals(opaque), "未知编码时字节必须原样透传");

  await waitFor(() => proxy.storage.updates.length > 0);
  const patch = proxy.storage.updates[0].patch;
  assert.equal(patch.route_reason ?? null, null);
  assert.equal(typeof patch.duration_ms, "number");
  // 未知编码不解压：观测链路看到的是压缩字节，解析不到 usage（与修复前行为一致）。
  assert.equal(proxy.storage.usage.length, 0);
});

test("P0-15f: 流式 deflate / br 同样解析 usage 且字节逐字节一致", async () => {
  const cases: { encoding: string; compress: (input: Buffer) => Buffer }[] = [
    { encoding: "deflate", compress: (input) => zlib.deflateSync(input) },
    { encoding: "br", compress: (input) => zlib.brotliCompressSync(input) },
  ];
  for (const { encoding, compress } of cases) {
    const plaintext = sseData(
      [
        JSON.stringify({ choices: [{ delta: { content: `hello ${encoding}` } }] }),
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
        }),
      ],
      true,
    );
    const plain = Buffer.from(plaintext, "utf8");
    // 单一压缩流按任意字节切块写出：解压器必须容忍跨块的多字节 UTF-8 / data 行。
    const compressed = compress(plain);
    const chunks = splitBufferAt(compressed, [
      Math.floor(compressed.length / 3),
      Math.floor((compressed.length * 2) / 3),
    ]);
    const upstreamCompressed = Buffer.concat(chunks);

    const upstream = await startMockUpstream(async (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "content-encoding": encoding,
      });
      res.flushHeaders();
      for (const chunk of chunks) {
        res.write(chunk);
        await delay(10);
      }
      res.end();
    });
    const proxy = await startProxy({ upstreamPort: upstream.port });
    cleanups.push(async () => {
      await proxy.controller.stop();
      await upstream.close();
    });

    const response = await request(proxy.port, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      body: baseChatBody(),
    });
    assert.equal(response.status, 200, `${encoding} 流式响应必须成功`);
    assert.equal(response.headers["content-encoding"], encoding);
    assert.ok(response.body.equals(upstreamCompressed), `${encoding} 字节必须原样透传`);

    await waitFor(() => proxy.storage.usage.length > 0);
    const usage = proxy.storage.usage[0];
    assert.equal(usage.usage_status, "complete", `${encoding} usage 必须完整`);
    assert.equal(usage.input_tokens, 5);
    assert.equal(usage.output_tokens, 6);
    assert.equal(usage.total_tokens, 11);
  }
});

test("P0-15g: 标成 deflate 的原始 deflate（无 zlib 头）流也能解析 usage", async () => {
  const plaintext = sseData(
    [
      JSON.stringify({ choices: [{ delta: { content: "raw deflate" } }] }),
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }),
    ],
    true,
  );
  const compressed = zlib.deflateRawSync(Buffer.from(plaintext, "utf8"));
  const chunks = splitBufferAt(compressed, [Math.floor(compressed.length / 2)]);

  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "content-encoding": "deflate",
    });
    res.flushHeaders();
    for (const chunk of chunks) {
      res.write(chunk);
      await delay(10);
    }
    res.end();
  });
  const proxy = await startProxy({ upstreamPort: upstream.port });
  cleanups.push(async () => {
    await proxy.controller.stop();
    await upstream.close();
  });

  const response = await request(proxy.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: baseChatBody(),
  });
  assert.equal(response.status, 200);
  assert.ok(response.body.equals(Buffer.concat(chunks)), "原始 deflate 字节必须原样透传");

  await waitFor(() => proxy.storage.usage.length > 0);
  const usage = proxy.storage.usage[0];
  assert.equal(usage.usage_status, "complete");
  assert.equal(usage.input_tokens, 2);
  assert.equal(usage.output_tokens, 3);
  assert.equal(usage.total_tokens, 5);
});
