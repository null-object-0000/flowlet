// 「AI 生成环境前缀」SSE 端点（`POST /api/ai/env-prefix`）测试。Owner: node-web.
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/env-prefix-ai.test.ts
// 覆盖：模型选择优先级、请求形状（system/user prompt、stream、include_usage）、
// 流式进度事件（start/progress/done 与 token 统计）、输出清洗失败、上游错误、
// 无可用模型、缺名称、未鉴权/CLI token 拒绝。
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
import { exposedModelNames, parseSegment, pickSuggestionModel } from "../env-prefix.ts";

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

describe("exposedModelNames / pickSuggestionModel / parseSegment", () => {
  it("prefers lightweight exposed models and skips disabled routes/models", () => {
    const snapshot: JsonRow = {
      // 生产里 virtual_models 常为空，真正开放的是路由行的 virtual_model_id。
      virtual_models: [],
      routes: [
        { virtual_model_id: "gpt-6.1-sol", client_protocol: "openai", enabled: 1 },
        { virtual_model_id: "qwen3.8-flash", client_protocol: "openai", enabled: 1 },
        { virtual_model_id: "deepseek-v4-pro", client_protocol: "openai", enabled: 0 },
        { virtual_model_id: "kimi-k3", client_protocol: "anthropic", enabled: 1 },
      ],
    };
    assert.deepEqual(exposedModelNames(snapshot), ["gpt-6.1-sol", "qwen3.8-flash"]);
    assert.equal(pickSuggestionModel(exposedModelNames(snapshot)), "qwen3.8-flash");

    const tableOnly: JsonRow = {
      virtual_models: [{ name: "glm-4.5-air", enabled: true }],
      routes: [],
    };
    assert.equal(pickSuggestionModel(exposedModelNames(tableOnly)), "glm-4.5-air");
    assert.equal(pickSuggestionModel(exposedModelNames({ virtual_models: [], routes: [] })), null);
  });

  it("cleans model output into a legal uppercase segment", () => {
    assert.equal(parseSegment("NA_PROD"), "NA_PROD");
    assert.equal(parseSegment("  `na prod`  "), "NA");
    assert.equal(parseSegment("```text\nSELF\n```"), "SELF");
    assert.equal(parseSegment("北美生产"), null);
    assert.equal(parseSegment(""), null);
    const long = parseSegment("north_america_production_instance");
    assert.ok(long !== null && long.length <= 20, String(long));
  });
});

// ─── HTTP 层（mock 本地模型入口 = proxy bindConfig 指向的端口） ──────────────

interface ModelCall {
  authorization: string | undefined;
  body: JsonRow;
}

type MockReply =
  | { kind: "json"; status: number; body: string }
  | { kind: "sse"; status: number; chunks: string[]; delayMs?: number };

function sseChunks(deltas: Array<{ content?: string; reasoning?: string }>, completionTokens?: number): string[] {
  const chunks = deltas.map((delta) => {
    const payload: JsonRow = { choices: [{ index: 0, delta: {} }] };
    const inner = (payload.choices as JsonRow[])[0]!.delta as JsonRow;
    if (delta.reasoning !== undefined) inner.reasoning_content = delta.reasoning;
    if (delta.content !== undefined) inner.content = delta.content;
    return `data: ${JSON.stringify(payload)}\n\n`;
  });
  if (completionTokens !== undefined) {
    chunks.push(
      `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: completionTokens } })}\n\n`,
    );
  }
  chunks.push("data: [DONE]\n\n");
  return chunks;
}

function startMockModel(reply: MockReply | ((call: ModelCall) => MockReply)): Promise<{
  port: number;
  calls: ModelCall[];
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
            authorization:
              typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
            body,
          };
          calls.push(call);
          const result = typeof reply === "function" ? reply(call) : reply;
          if (result.kind === "json") {
            response.writeHead(result.status, { "content-type": "application/json" });
            response.end(result.body);
            return;
          }
          response.writeHead(result.status, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
          });
          const delay = result.delayMs ?? 0;
          const writeNext = (index: number): void => {
            if (index >= result.chunks.length) {
              response.end();
              return;
            }
            response.write(result.chunks[index]);
            if (delay === 0) {
              writeNext(index + 1);
            } else {
              setTimeout(() => writeNext(index + 1), delay);
            }
          };
          writeNext(0);
        });
      },
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
      resolve({ port, calls });
    });
  });
}

interface HostOptions {
  reply?: MockReply | ((call: ModelCall) => MockReply);
  routes?: JsonRow[];
  virtualModels?: JsonRow[];
}

async function startHost(options: HostOptions = {}): Promise<{ baseUrl: string; calls: ModelCall[] }> {
  clearEnv();
  const webPort = await freePort();
  process.env.FLOWLET_ADMIN_AUTH_MODE = "token";
  process.env.FLOWLET_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.FLOWLET_PUBLIC_WEB_URL = `http://127.0.0.1:${webPort}`;

  const workDir = mkdtempSync(path.join(tmpdir(), "flowlet-envprefix-ai-"));
  const staticDir = path.join(workDir, "static");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>test</title>");
  const configPath = path.join(workDir, "config.json");
  writeFileSync(configPath, "{}\n");

  const mock = await startMockModel(
    options.reply ?? {
      kind: "sse",
      status: 200,
      chunks: sseChunks(
        [{ reasoning: "思考" }, { content: "NA" }, { content: "_PROD" }],
        3,
      ),
    },
  );
  const bindConfig = {
    host: "127.0.0.1",
    port: mock.port,
    allow_lan: false,
    default_client_token: CLIENT_TOKEN,
  };
  const snapshot: JsonRow = {
    channels: [],
    accounts: [],
    routes:
      options.routes ?? [{ virtual_model_id: "deepseek-v4.1-flash", client_protocol: "openai", enabled: 1 }],
    rules: [],
    virtual_models: options.virtualModels ?? [],
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
      const stored = {
        ...row,
        token_hash: row.tokenHash,
        expires_at: row.expiresAt,
        created_at: "x",
        last_used_at: null,
      };
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

const INPUT = {
  provider: "dockhand",
  providerDefault: "DOCKHAND",
  name: "公司北美 Dockhand 正式",
  note: "生产环境",
  used: ["DOCKHAND_SELF"],
};

/** 读 SSE 响应，返回解析后的事件数组。 */
async function readEvents(response: Response): Promise<JsonRow[]> {
  const text = await response.text();
  const events: JsonRow[] = [];
  for (const block of text.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data:")) continue;
    events.push(JSON.parse(line.slice("data:".length).trim()) as JsonRow);
  }
  return events;
}

async function postStream(
  baseUrl: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; contentType: string; events: JsonRow[]; text: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}/api/ai/env-prefix`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const text = await response.text();
    return { status: response.status, contentType, events: [], text };
  }
  const events = await readEvents(response);
  return { status: response.status, contentType, events, text: "" };
}

describe("HTTP：POST /api/ai/env-prefix（SSE）", () => {
  it("streams start/progress/done with token stats from the local model", async () => {
    const { baseUrl, calls } = await startHost({
      reply: {
        kind: "sse",
        status: 200,
        delayMs: 80,
        chunks: sseChunks(
          [{ reasoning: "思考" }, { content: "NA" }, { content: "_PROD" }],
          3,
        ),
      },
    });
    const result = await postStream(baseUrl, INPUT, ADMIN_TOKEN);
    assert.equal(result.status, 200);
    assert.match(result.contentType, /text\/event-stream/);

    const types = result.events.map((event) => event.type);
    assert.equal(types[0], "start");
    assert.equal(types[types.length - 1], "done");
    assert.ok(types.includes("progress"), "长一点的生成应至少有一个进度事件");

    const start = result.events[0]!;
    assert.equal(start.model, "deepseek-v4.1-flash");
    const progresses = result.events.filter((event) => event.type === "progress");
    // tokens 单调递增
    const counters = progresses.map((event) => Number(event.tokens));
    assert.deepEqual(
      counters,
      [...counters].sort((a, b) => a - b),
    );
    assert.ok(Math.max(...counters) >= 1);

    const done = result.events[result.events.length - 1]!;
    assert.equal(done.segment, "NA_PROD");
    assert.equal(done.completionTokens, 3);
    assert.equal(typeof done.elapsedMs, "number");
    assert.equal(typeof done.tokPerSec, "number");

    // 请求形状：client token 鉴权、流式、带 usage、prompt 含名称/备注/占用前缀
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.authorization, `Bearer ${CLIENT_TOKEN}`);
    assert.equal(call.body.model, "deepseek-v4.1-flash");
    assert.equal(call.body.stream, true);
    assert.deepEqual(call.body.stream_options, { include_usage: true });
    const messages = call.body.messages as Array<{ role: string; content: string }>;
    assert.equal(messages[0]!.role, "system");
    assert.match(messages[1]!.content, /实例名称：公司北美 Dockhand 正式/);
    assert.match(messages[1]!.content, /备注：生产环境/);
    assert.match(messages[1]!.content, /已占用前缀：DOCKHAND_SELF/);
  });

  it("emits an error event when the model output is unusable", async () => {
    const { baseUrl } = await startHost({
      reply: { kind: "sse", status: 200, chunks: sseChunks([{ content: "北美生产环境" }]) },
    });
    const result = await postStream(baseUrl, INPUT, ADMIN_TOKEN);
    assert.equal(result.status, 200);
    const last = result.events[result.events.length - 1]!;
    assert.equal(last.type, "error");
    assert.match(String(last.message), /没有给出可用的英文片段/);
  });

  it("emits an error event on upstream failure, and rejects before streaming when no model", async () => {
    const failing = await startHost({
      reply: { kind: "json", status: 500, body: '{"error":{"message":"upstream boom"}}' },
    });
    const failed = await postStream(failing.baseUrl, INPUT, ADMIN_TOKEN);
    const failedLast = failed.events[failed.events.length - 1]!;
    assert.equal(failedLast.type, "error");
    assert.match(String(failedLast.message), /模型返回 HTTP 500/);

    const empty = await startHost({ routes: [], virtualModels: [] });
    const noModel = await postStream(empty.baseUrl, INPUT, ADMIN_TOKEN);
    assert.equal(noModel.status, 409);
    assert.match(noModel.text, /没有可用的开放模型/);

    const missingName = await startHost();
    const bad = await postStream(missingName.baseUrl, { ...INPUT, name: "  " }, ADMIN_TOKEN);
    assert.equal(bad.status, 400);
    assert.match(bad.text, /填写名称/);
  });

  it("requires admin auth; CLI token cannot spend model calls", async () => {
    const { baseUrl, calls } = await startHost();
    const anonymous = await postStream(baseUrl, INPUT);
    assert.equal(anonymous.status, 401);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const issue = await fetch(`${baseUrl}/api/commands/create_cli_auth_code`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({
        redirectUri: "http://127.0.0.1:45999/cb",
        state: "state-ai-1",
        codeChallenge: challenge,
        name: "agent-box",
      }),
    });
    const redirect = new URL(String(((await issue.json()) as JsonRow).redirectUrl ?? ""));
    const code = redirect.searchParams.get("code") ?? "";
    const exchange = await fetch(`${baseUrl}/api/auth/cli/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
    const token = String(((await exchange.json()) as JsonRow).token ?? "");
    assert.ok(token.startsWith("flwcli_"));

    const forbidden = await postStream(baseUrl, INPUT, token);
    assert.equal(forbidden.status, 401);
    assert.equal(calls.length, 0, "CLI token 不应触发模型调用");
  });
});