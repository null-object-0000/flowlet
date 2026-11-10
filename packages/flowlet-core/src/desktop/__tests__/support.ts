// 桌面命令测试共享装置：真实 SQLite schema + 内存宿主桥。
//
// 与 `web/__tests__` 的做法一致：使用真实 `SqliteStorage`（临时目录，非 mock schema）
// 与真实 `RuntimeConfig`，只把 Electron 宿主能力替换成可断言的假实现。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonRow } from "../../types.ts";
import type { DesktopContext, DesktopHostBridge } from "../types.ts";
import { SqliteStorage } from "../../storage/index.ts";
import { RuntimeConfig } from "../../config/index.ts";
import type { ModelPrice } from "../../storage/prices.ts";

export interface HostCall {
  channel: string;
  payload: JsonRow | undefined;
}

type HostResponder = (channel: string, payload: JsonRow | undefined) => unknown;

export interface FakeHost {
  bridge: DesktopHostBridge;
  calls: HostCall[];
  /** 覆盖某些 channel 的返回值/抛错行为（默认返回 null）。 */
  respond: (channel: string, responder: HostResponder) => void;
  keyring: Map<string, string>;
}

function keyringKey(service: string, username: string): string {
  return `${service}\u0000${username}`;
}

/** 内存宿主桥：keyring.* 用 Map 模拟，其余 channel 记录调用并返回 respond 结果。 */
export function createFakeHost(): FakeHost {
  const calls: HostCall[] = [];
  const responders = new Map<string, HostResponder>();
  const keyring = new Map<string, string>();
  const bridge: DesktopHostBridge = {
    async invoke<T>(channel: string, payload?: JsonRow): Promise<T> {
      calls.push({ channel, payload });
      if (channel === "keyring.get") {
        const key = keyringKey(String(payload?.service), String(payload?.username));
        return { secret: keyring.get(key) ?? null } as T;
      }
      if (channel === "keyring.set") {
        keyring.set(
          keyringKey(String(payload?.service), String(payload?.username)),
          String(payload?.secret ?? ""),
        );
        return null as T;
      }
      if (channel === "keyring.delete") {
        keyring.delete(keyringKey(String(payload?.service), String(payload?.username)));
        return null as T;
      }
      const responder = responders.get(channel);
      return (responder === undefined ? null : responder(channel, payload)) as T;
    },
  };
  return {
    bridge,
    calls,
    respond(channel, responder) {
      responders.set(channel, responder);
    },
    keyring,
  };
}

export interface TestContext {
  ctx: DesktopContext;
  storage: SqliteStorage;
  runtimeConfig: RuntimeConfig;
  host: FakeHost;
  dir: string;
  configPath: string;
  /** 修改代理运行状态（compact_database 前置检查）。 */
  setProxyRunning(running: boolean): void;
  cleanup(): void;
}

const EMPTY_PROXY_STATUS = { running: false, bind_addr: "127.0.0.1:0", started_at: null };

/**
 * 构造真实存储 + 真实运行时快照 + 假宿主桥的 `DesktopContext`。
 * 只填充本批次命令实际读取的字段，其余用类型断言补齐（与 web 测试一致）。
 */
export function createTestContext(options: { prefix?: string } = {}): TestContext {
  const dir = mkdtempSync(path.join(tmpdir(), options.prefix ?? "flowlet-desktop-cmd-"));
  const storage = new SqliteStorage(path.join(dir, "flowlet.sqlite"));
  const runtimeConfig = new RuntimeConfig({
    channels: [],
    accounts: [],
    routes: [],
    rules: [],
    virtual_models: [],
  });
  const host = createFakeHost();
  const configPath = path.join(dir, "config.json");
  let proxyRunning = false;
  const ctx = {
    storage,
    runtimeConfig,
    proxy: {
      start: async () => undefined,
      stop: async () => undefined,
      status: () => ({ ...EMPTY_PROXY_STATUS, running: proxyRunning }),
      bindConfig: () => ({
        host: "127.0.0.1",
        port: 0,
        allow_lan: false,
        default_client_token: "token",
      }),
      setBindConfig: () => undefined,
    },
    catalogDir: dir,
    configPath,
    adminToken: "admin-token-for-test-only-1234",
    clientToken: "client-token-for-test-only",
    staticDir: dir,
    publicProxyUrl: "",
    deviceIdentity: {
      schema_version: 1,
      device_id: "test-device",
      created_at: "2026-01-01T00:00:00Z",
      display_name: "test",
      platform: "linux",
    },
    config: {},
    channelsConfig: {},
    logCapture: {},
    upstreamProxy: { enabled: false, url: "" },
    secrets: {
      encrypt: (plaintext: string) => plaintext,
      decrypt: (encoded: string) => encoded,
    },
    cliAuth: {},
    desktop: {
      host: host.bridge,
      appVersion: "9.9.9-test",
      dataDir: dir,
      portable: true,
    },
  } as unknown as DesktopContext;
  return {
    ctx,
    storage,
    runtimeConfig,
    host,
    dir,
    configPath,
    setProxyRunning(running: boolean) {
      proxyRunning = running;
    },
    cleanup() {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 一个最小但字段完整的 ChannelPreset（snake_case，serde 必填字段齐全）。 */
export function samplePreset(id = "deepseek"): JsonRow {
  return {
    id,
    name: "DeepSeek",
    vendor: "deepseek",
    supported_protocols: ["openai", "anthropic"],
    openai_base_url: "https://api.deepseek.com/v1",
    anthropic_base_url: "https://api.deepseek.com/anthropic",
    openai_auth: "bearer",
    anthropic_auth: "bearer",
    default_model: "deepseek-v4.1-flash",
    small_model: null,
    timeout_seconds: null,
    supports_model_list: true,
    supports_model_detail: true,
    supports_balance_query: false,
    supports_quota_query: false,
    supports_usage_query: false,
    supports_scrape_balance: false,
    supports_files_api: false,
    platform_url: null,
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/** 字段完整的 ChannelAccount（snake_case）。 */
export function sampleAccount(id = "account-1"): JsonRow {
  return {
    id,
    workspace_account_id: null,
    channel_id: "deepseek",
    name: "Main",
    api_key: "sk-test",
    management_key: null,
    enabled: true,
    priority: 1,
    remark: null,
    resource_mode: null,
    resource_sync_mode: "manual",
    base_url_override: null,
    use_upstream_proxy: false,
    anthropic_base_url_override: null,
    workspace_default_base_url: null,
    workspace_default_anthropic_base_url: null,
    last_used_at: null,
    last_error: null,
    credential_status: "healthy",
    synced_models: null,
    models_synced_at: null,
    exposed_models: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

export function sampleRoute(id = "route-1"): JsonRow {
  return {
    id,
    virtual_model_id: "deepseek-v4.1-flash",
    channel_id: "deepseek",
    account_id: "account-1",
    upstream_model: "deepseek-v4.1-flash",
    client_protocol: "openai",
    priority: 1,
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

export function sampleRule(id = "rule-1"): JsonRow {
  return {
    id,
    name: "Route to main",
    enabled: true,
    priority: 1,
    match_client_id: null,
    match_model: null,
    match_protocol: null,
    target_channel_id: "deepseek",
    target_account_id: "account-1",
    target_upstream_model: "deepseek-v4.1-flash",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

export function sampleVirtualModel(id = "vm-1"): JsonRow {
  return {
    id,
    name: "DeepSeek V4.1 Flash",
    protocol_type: "openai",
    routing_strategy: "priority",
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

export function samplePrice(id = "price-1"): ModelPrice {
  return {
    id,
    channel_id: "deepseek",
    upstream_model: "deepseek-v4.1-flash",
    input_uncached_price: 1,
    input_cached_price: 0.1,
    input_cache_write_price: null,
    output_price: 2,
    tiers: [],
    schedules: [],
    currency: "USD",
    unit: "per_million_tokens",
    source_url: null,
    price_version: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
// ─── 假 S3 HTTP 服务（账号工作区测试用） ────────────────────────────────────

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";

export interface FakeS3 {
  endpoint: string;
  bucket: string;
  objects: Map<string, { body: Buffer; etag: string }>;
  close(): Promise<void>;
  /** 直接写入/覆盖远端对象（模拟其他设备写入目录）。 */
  putObject(key: string, body: Buffer): string;
  getObject(key: string): Buffer | null;
}

const BUCKET = "flowlet-test-bucket";

function etagOf(body: Buffer): string {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 最小 S3-compatible HTTP 服务：忽略 SigV4 签名，只验证路径/对象语义。
 * 覆盖 GET object / PUT object（If-Match）/ HEAD object / DELETE / ListObjectsV2 / HEAD bucket。
 */
export async function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, { body: Buffer; etag: string }>();
  const server: HttpServer = createServer((request, response) => {
    void handle(request, response);
  });
  const bucketPath = `/${BUCKET}`;

  const list = (prefix: string): string => {
    const contents = [...objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(
        ([key, value]) =>
          `<Contents><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(value.etag)}</ETag>` +
          `<Size>${value.body.length}</Size></Contents>`,
      )
      .join("");
    return (
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
      `<Name>${BUCKET}</Name><Prefix>${xmlEscape(prefix)}</Prefix>` +
      `<KeyCount>${[...objects.keys()].filter((key) => key.startsWith(prefix)).length}</KeyCount>` +
      `<IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`
    );
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = request.method === "PUT" ? await readRequestBody(request) : Buffer.alloc(0);
    if (url.pathname === bucketPath || url.pathname === `${bucketPath}/`) {
      if (request.method === "HEAD") {
        response.writeHead(200);
        response.end();
        return;
      }
      if (request.method === "GET") {
        const prefix = url.searchParams.get("prefix") ?? "";
        response.writeHead(200, { "content-type": "application/xml" });
        response.end(list(prefix));
        return;
      }
      response.writeHead(405);
      response.end();
      return;
    }
    if (!url.pathname.startsWith(`${bucketPath}/`)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const key = decodeURIComponent(url.pathname.slice(bucketPath.length + 1));
    const current = objects.get(key);
    if (request.method === "PUT") {
      const ifMatch = request.headers["if-match"];
      if (typeof ifMatch === "string" && current !== undefined && current.etag !== ifMatch) {
        response.writeHead(412);
        response.end();
        return;
      }
      const etag = etagOf(body);
      objects.set(key, { body, etag });
      response.writeHead(200, { etag });
      response.end();
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      if (current === undefined) {
        response.writeHead(404, { "content-type": "application/xml" });
        response.end("<Error><Code>NoSuchKey</Code><RequestId>req-missing</RequestId></Error>");
        return;
      }
      response.writeHead(200, {
        etag: current.etag,
        "content-length": String(current.body.length),
      });
      response.end(request.method === "HEAD" ? undefined : current.body);
      return;
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(405);
    response.end();
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake S3 server failed to bind");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    bucket: BUCKET,
    objects,
    async close() {
      // 断开 fetch keep-alive 连接，否则 close() 会一直等待空闲 socket。
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
    putObject(key, body) {
      const etag = etagOf(body);
      objects.set(key, { body, etag });
      return etag;
    },
    getObject(key) {
      return objects.get(key)?.body ?? null;
    },
  };
}
