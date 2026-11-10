// 「AI 生成环境前缀片段」（`suggest_env_prefix_segment`）测试。Owner: node-web.
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/env-prefix-ai.test.ts
// 覆盖：模型选择优先级、调本地模型入口的请求形状、输出清洗/校验、失败回退错误、
// 没有可用模型、名称缺失，以及 CLI token 不能调用（保持只读作用域）。
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { JsonRow } from "../../types.ts";
import { createWebHost } from "../index.ts";
import { parseSegment, pickSuggestionModel } from "../env-prefix.ts";

const ADMIN_TOKEN = "flowlet-envprefix-ai-admin-0123456789";
const CLIENT_TOKEN = "flowlet-envprefix-ai-client-0123456789";

const ENV_KEYS = [
  "FLOWLET_ADMIN_AUTH_MODE",
  "FLOWLET_ADMIN_TOKEN",
  "FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN",
  "FLOWLET_PUBLIC_WEB_URL",
  "FLOWLET_OIDC_ISSUER",
  "FLOWLET_OIDC_DISCOVERY_URL",
  "FLOWLET_OIDC_ALLOW_HTTP_ISSUER",
  "FLOWLET_OIDC_CLIENT_ID",
  "FLOWLET_OIDC_CLIENT_SECRET",
  "FLOWLET_OIDC_ALLOWED_SUBS",
];

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
  clearEnv();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// ─── 纯函数 ─────────────────────────────────────────────────────────────────

describe("pickSuggestionModel / parseSegment", () => {
  it("prefers lightweight exposed models and skips disabled rows", () => {
    const models: JsonRow[] = [
      { name: "deepseek-v4-pro", enabled: true },
      { name: "qwen3.8-flash", enabled: true },
      { name: "glm-4.5-air", enabled: false },
    ];
    assert.equal(pickSuggestionModel(models), "qwen3.8-flash");
    assert.equal(pickSuggestionModel([{ name: "gpt-6.1-sol", enabled: true }]), "gpt-6.1-sol");
    assert.equal(pickSuggestionModel([]), null);
  });

  it("cleans model output into a legal uppercase segment", () => {
    assert.equal(parseSegment("NA_PROD"), "NA_PROD");
    assert.equal(parseSegment("  `na prod`  "), "NA"); // 空格结尾的词不再拼接
    assert.equal(parseSegment("```text\nSELF\n```"), "SELF");
    assert.equal(parseSegment("北美生产"), null);
    assert.equal(parseSegment(""), null);
    // 超长片段被截断在 20 字符内
    const long = parseSegment("north_america_production_instance");
    assert.ok(long !== null && long.length <= 20, String(long));
  });
});

// ─── HTTP 层（mock 本地模型入口 = proxy bindConfig 指向的端口） ──────────────

interface ModelCall {
  authorization: string | undefined;
  body: JsonRow;
}

function startMockModel(responder: (call: ModelCall) => { status: number; body: string }): Promise<{
  port: number;
  calls: ModelCall[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const calls: ModelCall[] = [];
    const server: Server = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as JsonRow;
          const call: ModelCall = {
            authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
            body,
          };
          calls.push(call);
          const result = responder(call);
          response.writeHead(result.status, { "content-type": "application/json" });
          response.end(result.body);
        });
      },
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
      resolve({
        port,
        calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function chatCompletion(content: string): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    }),
  };
}

interface HostOptions {
  modelResponder?: (call: ModelCall) => { status: number; body: string };
  virtualModels?: JsonRow[];
}

async function startHost(options: HostOptions = {}): Promise<{
  baseUrl: string;
  calls: ModelCall[];
}> {
  clearEnv();
  const webPort = await freePort();
  const modelPort = await freePort();
  process.env.FLOWLET_ADMIN_AUTH_MODE = "token";
  process.env.FLOWLET_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.FLOWLET_PUBLIC_WEB_URL = `http://127.0.0.1:${webPort}`;

  const workDir = mkdtempSync(path.join(tmpdir(), "flowlet-envprefix-ai-"));
  const staticDir = path.join(workDir, "static");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>test</title>");
  const configPath = path.join(workDir, "config.json");
  writeFileSync(configPath, "{}\n");

  // proxy.bindConfig 指向 mock 模型入口端口（127.0.0.1:<port>）。
  const mock = await startMockModel(options.modelResponder ?? (() => chatCompletion("NA_PROD")));
  // 用同一个端口取代占位：mock 需要监听在指定端口时改造，这里直接用 mock 的端口。
  const bindConfig = {
    host: "127.0.0.1",
    port: mock.port,
    allow_lan: false,
    default_client_token: CLIENT_TOKEN,
  };

  const virtualModels: JsonRow[] = options.virtualModels ?? [
    { id: "vm-1", name: "deepseek-v4.1-flash", protocol_type: "openai", enabled: true },
  ];
  const snapshot: JsonRow = {
    channels: [],
    accounts: [],
    routes: [],
    rules: [],
    virtual_models: virtualModels,
  };

  const tokens = new Map<string, JsonRow>();
  class FakeStorage {
    getAppMeta(): string | null {
      return null;
    }
    setAppMeta(): void {}
    listChannelModels(): JsonRow[] {
      return [];
    }
    listServiceCredentials(): JsonRow[] {
      return [];
    }
    insertCliAuthToken(row: JsonRow): JsonRow {
      const stored = { ...row, token_hash: row.tokenHash, expires_at: row.expiresAt, created_at: "x", last_used_at: null };
      tokens.set(String(stored.token_hash), stored);
      return stored;
    }
    listCliAuthTokens(): JsonRow[] {
      return [...tokens.values()];
    }
    findCliAuthTokenByHash(hash: string): JsonRow | null {
      return tokens.get(hash) ?? null;
    }
    touchCliAuthToken(): void {}
    deleteCliAuthToken(): boolean {
      return false;
    }
    deleteExpiredCliAuthTokens(): number {
      return 0;
    }
  }

  const web = createWebHost({
    storage: new FakeStorage() as unknown as never,
    proxy: {
      start: async () => {},
      stop: async () => {},
      status: () => ({ running: true, bind_addr: `127.0.0.1:${mock.port}`, started_at: null }),
      bindConfig: () => bindConfig,
      setBindConfig: () => {},
    },
    runtimeConfig: {
      snapshot: () => snapshot,
      replace: () => {},
      update: (mutate: (draft: JsonRow) => void) => mutate(snapshot),
    },
    bindConfig,
    secrets: {
      encrypt: (plaintext: string) => `v1:${Buffer.from(plaintext, "utf8").toString("base64")}`,
      decrypt: (encoded: string) => Buffer.from(encoded.slice(3), "base64").toString("utf8"),
    },
    catalogDir: workDir,
    configPath,
    adminToken: ADMIN_TOKEN,
    clientToken: CLIENT_TOKEN,
    staticDir,
    publicProxyUrl: "",
    deviceIdentity: {
      schema_version: 1,
      device_id: "11111111-1111-4111-8111-111111111111",
      created_at: "2026-01-01T00:00:00+00:00",
      display_name: "Flowlet Host",
      platform: "linux",
      app_version: "test",
    },
  });
  await web.listen(`127.0.0.1:${webPort}`);
  cleanups.push(async () => {
    await web.close();
    rmSync(workDir, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${webPort}`, calls: mock.calls };
}

async function post(
  baseUrl: string,
  command: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; json: JsonRow | null; text: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}/api/commands/${command}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: JsonRow | null = null;
  try {
    json = JSON.parse(text) as JsonRow;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

const INPUT = {
  provider: "dockhand",
  providerDefault: "DOCKHAND",
  name: "公司北美 Dockhand 正式",
  note: "生产环境",
  used: ["DOCKHAND_SELF"],
};

describe("HTTP：suggest_env_prefix_segment", () => {
  it("calls the exposed model through the local proxy and returns a cleaned segment", async () => {
    const { baseUrl, calls } = await startHost();
    const result = await post(baseUrl, "suggest_env_prefix_segment", INPUT, ADMIN_TOKEN);
    assert.equal(result.status, 200, result.text);
    assert.equal(result.json?.segment, "NA_PROD");
    assert.equal(result.json?.model, "deepseek-v4.1-flash");

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.authorization, `Bearer ${CLIENT_TOKEN}`);
    assert.equal(call.body.model, "deepseek-v4.1-flash");
    assert.equal(call.body.stream, false);
    const messages = call.body.messages as Array<{ role: string; content: string }>;
    assert.equal(messages[0]!.role, "system");
    assert.match(messages[1]!.content, /实例名称：公司北美 Dockhand 正式/);
    assert.match(messages[1]!.content, /已占用前缀：DOCKHAND_SELF/);
  });

  it("falls back with a readable error when the model output is not usable", async () => {
    const { baseUrl } = await startHost({
      modelResponder: () => chatCompletion("北美生产环境"),
    });
    const result = await post(baseUrl, "suggest_env_prefix_segment", INPUT, ADMIN_TOKEN);
    assert.equal(result.status, 502);
    assert.match(String(result.json?.message ?? ""), /回退规则/);
  });

  it("reports upstream failures and missing models without leaking internals", async () => {
    const failing = await startHost({
      modelResponder: () => ({ status: 500, body: '{"error":{"message":"upstream boom"}}' }),
    });
    const failed = await post(failing.baseUrl, "suggest_env_prefix_segment", INPUT, ADMIN_TOKEN);
    assert.equal(failed.status, 502);
    assert.match(String(failed.json?.message ?? ""), /模型返回 HTTP 500/);

    const empty = await startHost({ virtualModels: [] });
    const noModel = await post(empty.baseUrl, "suggest_env_prefix_segment", INPUT, ADMIN_TOKEN);
    assert.equal(noModel.status, 409);
    assert.match(String(noModel.json?.message ?? ""), /没有可用的开放模型/);

    const missingName = await post(
      empty.baseUrl,
      "suggest_env_prefix_segment",
      { ...INPUT, name: "  " },
      ADMIN_TOKEN,
    );
    assert.equal(missingName.status, 400);
    assert.match(String(missingName.json?.message ?? ""), /填写名称/);
  });

  it("requires admin auth; CLI token cannot spend model calls", async () => {
    const { baseUrl, calls } = await startHost();
    const anonymous = await post(baseUrl, "suggest_env_prefix_segment", INPUT);
    assert.equal(anonymous.status, 401);

    // 用公开端点换一把 CLI token，再尝试调用 → 403 且没有模型调用
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const issued = await post(
      baseUrl,
      "create_cli_auth_code",
      {
        redirectUri: "http://127.0.0.1:45999/cb",
        state: "state-ai-1",
        codeChallenge: challenge,
        name: "agent-box",
      },
      ADMIN_TOKEN,
    );
    assert.equal(issued.status, 200, issued.text);
    const redirect = new URL(String(issued.json?.redirectUrl ?? ""));
    const code = redirect.searchParams.get("code") ?? "";
    const exchange = await fetch(`${baseUrl}/api/auth/cli/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
    const token = String(((await exchange.json()) as JsonRow).token ?? "");
    assert.ok(token.startsWith("flwcli_"));

    const forbidden = await post(baseUrl, "suggest_env_prefix_segment", INPUT, token);
    assert.equal(forbidden.status, 403);
    assert.equal(calls.length, 0, "CLI token 不应触发模型调用");
  });
});