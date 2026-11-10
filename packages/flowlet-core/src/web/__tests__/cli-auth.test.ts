// CLI 浏览器授权（`flowlet login`）测试。Owner: node-web.
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/cli-auth.test.ts
// 覆盖：redirectUri/state/PKCE 校验、授权码一次性与过期、exchange 签发、
// token 作用域（只允许 export_service_credentials）、撤销后立即失效、
// 管理列表不含明文/哈希，以及 HTTP 层的公开路由与错误形状。
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { JsonRow } from "../../types.ts";
import { createWebHost } from "../index.ts";
import {
  CLI_TOKEN_PREFIX,
  CLI_TOKEN_SCOPE,
  createCliAuth,
  type CliAuthStorage,
} from "../cli-auth.ts";

// 与其它 auth 测试一致：干净的 OIDC 环境变量（token 模式宿主用不到）。
const AUTH_ENV_KEYS = [
  "FLOWLET_ADMIN_AUTH_MODE",
  "FLOWLET_ADMIN_TOKEN",
  "FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN",
  "FLOWLET_PUBLIC_WEB_URL",
  "FLOWLET_OIDC_ISSUER",
  "FLOWLET_OIDC_DISCOVERY_URL",
  "FLOWLET_OIDC_ALLOW_HTTP_ISSUER",
  "FLOWLET_OIDC_INSECURE_HTTP",
  "FLOWLET_OIDC_CLIENT_ID",
  "FLOWLET_OIDC_CLIENT_SECRET",
  "FLOWLET_OIDC_SCOPES",
  "FLOWLET_OIDC_DISPLAY_NAME",
  "FLOWLET_OIDC_ALLOWED_SUBS",
  "FLOWLET_OIDC_ALLOW_EMAILS",
  "FLOWLET_OIDC_ALLOWED_EMAILS",
  "FLOWLET_OIDC_ALLOWED_DOMAINS",
  "FLOWLET_OIDC_ALLOWED_GROUPS",
  "FLOWLET_OIDC_ALLOW_ANY",
  "FLOWLET_OIDC_PKCE",
  "FLOWLET_OIDC_NONCE",
  "FLOWLET_OIDC_SIGNING_ALGS",
  "FLOWLET_OIDC_REDIRECT_URL",
  "FLOWLET_ADMIN_SESSION_IDLE_MINUTES",
  "FLOWLET_ADMIN_SESSION_TTL_HOURS",
  "FLOWLET_ADMIN_COOKIE_SECURE",
];

function clearAuthEnv(): void {
  for (const key of AUTH_ENV_KEYS) delete process.env[key];
}

const cleanupCallbacks: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanupCallbacks.reverse()) await cleanup();
  clearAuthEnv();
});

/** 内存版 cli_auth_tokens（接口与 node-storage 一致）。 */
class FakeCliAuthStorage implements CliAuthStorage {
  rows: JsonRow[] = [];
  inserted = 0;

  insertCliAuthToken(row: {
    id?: string;
    name: string;
    tokenHash: string;
    scope: string;
    expiresAt: string;
  }): JsonRow {
    this.inserted += 1;
    const stored: JsonRow = {
      id: row.id ?? `token-${this.inserted}`,
      name: row.name,
      token_hash: row.tokenHash,
      scope: row.scope,
      created_at: rfc3339Seconds(new Date()),
      expires_at: row.expiresAt,
      last_used_at: null,
    };
    this.rows.push(stored);
    return stored;
  }

  listCliAuthTokens(): JsonRow[] {
    return [...this.rows];
  }

  findCliAuthTokenByHash(tokenHash: string): JsonRow | null {
    return this.rows.find((row) => row.token_hash === tokenHash) ?? null;
  }

  touchCliAuthToken(id: string): void {
    const row = this.rows.find((item) => item.id === id);
    if (row !== undefined) row.last_used_at = rfc3339Seconds(new Date());
  }

  deleteCliAuthToken(id: string): boolean {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.id !== id);
    return this.rows.length !== before;
  }

  deleteExpiredCliAuthTokens(): number {
    const now = Date.now();
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => Date.parse(String(row.expires_at)) > now);
    return before - this.rows.length;
  }
}

function rfc3339Seconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 生成一对 PKCE verifier/challenge（S256）。 */
function pkcePair(): { verifier: string; challenge: string } {
  // 每次新 verifier：PKCE 不匹配用例必须拿到与 challenge 不同的值。
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier, "utf8").digest());
  return { verifier, challenge };
}

const REDIRECT = "http://127.0.0.1:45999/callback";
const STATE = "state-0123456789abcdef";

function authorizeInput(challenge: string): {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  name: string;
} {
  return {
    redirectUri: REDIRECT,
    state: STATE,
    codeChallenge: challenge,
    name: "agent-box",
  };
}

function codeOf(redirectUrl: string): string {
  const url = new URL(redirectUrl);
  const code = url.searchParams.get("code");
  assert.ok(code !== null && code !== "", "redirectUrl 必须带 code");
  return code;
}

/** 可注入时钟的 cliAuth（授权码 120s 过期用得到）。 */
function withClock(storage: CliAuthStorage): {
  auth: ReturnType<typeof createCliAuth>;
  advance: (ms: number) => void;
} {
  let current = Date.now();
  const auth = createCliAuth(storage, () => current);
  return { auth, advance: (ms: number) => (current += ms) };
}

// ─── 纯函数 / 单元 ──────────────────────────────────────────────────────────

describe("createCliAuth 参数校验", () => {
  it("startPage 只接受 loopback 回调与 S256 challenge", () => {
    const auth = createCliAuth(new FakeCliAuthStorage());
    const { challenge } = pkcePair();
    const valid = new URLSearchParams({
      redirect_uri: REDIRECT,
      state: STATE,
      code_challenge: challenge,
    });
    assert.equal(auth.startPage(valid).status, 200);

    const remote = new URLSearchParams({
      redirect_uri: "http://evil.example.com/callback",
      state: STATE,
      code_challenge: challenge,
    });
    assert.equal(auth.startPage(remote).status, 400);

    const httpsLoopback = new URLSearchParams({
      redirect_uri: "https://127.0.0.1:1/callback",
      state: STATE,
      code_challenge: challenge,
    });
    assert.equal(auth.startPage(httpsLoopback).status, 400);

    const badChallenge = new URLSearchParams({
      redirect_uri: REDIRECT,
      state: STATE,
      code_challenge: "short",
    });
    assert.equal(auth.startPage(badChallenge).status, 400);

    const plainMethod = new URLSearchParams({
      redirect_uri: REDIRECT,
      state: STATE,
      code_challenge: challenge,
      code_challenge_method: "plain",
    });
    assert.equal(auth.startPage(plainMethod).status, 400);

    const missingState = new URLSearchParams({
      redirect_uri: REDIRECT,
      code_challenge: challenge,
    });
    assert.equal(auth.startPage(missingState).status, 400);
  });

  it("startPage 不回显未转义参数（HTML 注入）", () => {
    const auth = createCliAuth(new FakeCliAuthStorage());
    const { challenge } = pkcePair();
    const params = new URLSearchParams({
      redirect_uri: REDIRECT,
      state: STATE,
      code_challenge: challenge,
      name: "<script>alert(1)</script>",
    });
    const page = auth.startPage(params);
    assert.equal(page.status, 200);
    assert.ok(!page.html.includes("<script>alert(1)</script>"), "name 必须被转义");
    assert.ok(page.html.includes("&lt;script&gt;"), "转义后的 name 应出现");
    assert.ok(page.html.includes('"codeChallenge"'), "PKCE challenge 需要进入页面脚本");
  });

  it("authorize 生成带 code 与 state 的回调地址，exchange 用 verifier 换 token", () => {
    const storage = new FakeCliAuthStorage();
    const auth = createCliAuth(storage);
    const { verifier, challenge } = pkcePair();
    const { redirectUrl } = auth.authorize(authorizeInput(challenge));
    const url = new URL(redirectUrl);
    assert.equal(url.origin + url.pathname, REDIRECT);
    assert.equal(url.searchParams.get("state"), STATE);
    const code = codeOf(redirectUrl);

    const issued = auth.exchange({ code, codeVerifier: verifier });
    assert.ok(issued.token.startsWith(CLI_TOKEN_PREFIX));
    assert.equal(issued.token.length, CLI_TOKEN_PREFIX.length + 43);
    // 30 天有效期
    const ttl = Date.parse(issued.expiresAt) - Date.now();
    assert.ok(ttl > 29 * 24 * 3600_000 && ttl <= 30 * 24 * 3600_000, `ttl=${ttl}`);
    assert.equal(storage.rows.length, 1);
    assert.equal(storage.rows[0]!.scope, CLI_TOKEN_SCOPE);
    assert.notEqual(storage.rows[0]!.token_hash, issued.token, "库内不能存明文 token");

    // 认证通过并刷新 last_used_at
    const row = auth.authenticate({ authorization: `Bearer ${issued.token}` });
    assert.ok(row !== null);
    assert.equal(row!.last_used_at !== null, true);

    // 无 Bearer / 非 flwcli 前缀不查库
    assert.equal(auth.authenticate({}), null);
    assert.equal(auth.authenticate({ authorization: "Bearer some-admin-token" }), null);
  });

  it("PKCE 不匹配、重放、过期授权码都拒绝", () => {
    const { auth, advance } = withClock(new FakeCliAuthStorage());
    const { verifier, challenge } = pkcePair();

    // verifier 不匹配
    const first = codeOf(auth.authorize(authorizeInput(challenge)).redirectUrl);
    assert.throws(
      () => auth.exchange({ code: first, codeVerifier: pkcePair().verifier }),
      /授权码无效或已过期/,
    );
    // 失败也作废：正确 verifier 不能再换
    assert.throws(() => auth.exchange({ code: first, codeVerifier: verifier }), /授权码无效或已过期/);

    // 成功一次后重放失败
    const second = codeOf(auth.authorize(authorizeInput(challenge)).redirectUrl);
    const issued = auth.exchange({ code: second, codeVerifier: verifier });
    assert.ok(issued.token.startsWith(CLI_TOKEN_PREFIX));
    assert.throws(() => auth.exchange({ code: second, codeVerifier: verifier }), /授权码无效或已过期/);

    // 过期（> 120s）
    const third = codeOf(auth.authorize(authorizeInput(challenge)).redirectUrl);
    advance(121_000);
    assert.throws(() => auth.exchange({ code: third, codeVerifier: verifier }), /授权码无效或已过期/);

    // 字段缺失 → invalid_request
    assert.throws(() => auth.exchange({ code: third }), /必填/);
    assert.throws(() => auth.exchange("nope"), /JSON 对象/);
  });

  it("token 过期后 authenticate 返回 null 并删除死行", () => {
    const storage = new FakeCliAuthStorage();
    const auth = createCliAuth(storage);
    const { verifier, challenge } = pkcePair();
    const code = codeOf(auth.authorize(authorizeInput(challenge)).redirectUrl);
    const issued = auth.exchange({ code, codeVerifier: verifier });
    // 直接改库模拟过期
    storage.rows[0]!.expires_at = rfc3339Seconds(new Date(Date.now() - 1000));
    assert.equal(auth.authenticate({ authorization: `Bearer ${issued.token}` }), null);
    assert.equal(storage.rows.length, 0, "过期 token 应被删除");
  });

  it("list 不含明文/哈希，revoke 幂等且立即失效", () => {
    const storage = new FakeCliAuthStorage();
    const auth = createCliAuth(storage);
    const { verifier, challenge } = pkcePair();
    const code = codeOf(auth.authorize(authorizeInput(challenge)).redirectUrl);
    const issued = auth.exchange({ code, codeVerifier: verifier });

    const list = auth.list();
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]!).sort(), [
      "createdAt",
      "expiresAt",
      "id",
      "lastUsedAt",
      "name",
      "scope",
    ]);
    assert.ok(!JSON.stringify(list).includes(issued.token));
    assert.ok(!JSON.stringify(list).includes(String(storage.rows[0]!.token_hash)));
    assert.equal(list[0]!.name, "agent-box");

    auth.revoke(String(list[0]!.id));
    assert.equal(auth.list().length, 0);
    assert.equal(auth.authenticate({ authorization: `Bearer ${issued.token}` }), null);
    // 幂等
    assert.equal(auth.revoke(String(list[0]!.id)), null);
  });
});

// ─── HTTP 层 ────────────────────────────────────────────────────────────────

const ADMIN_TOKEN = "flowlet-cli-auth-test-admin-0123456789";
const CLIENT_TOKEN = "flowlet-cli-auth-test-client-0123456789";

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

interface TestResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  json: Record<string, unknown> | null;
}

async function startTokenHost(
  extraEnv: Record<string, string> = {},
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  clearAuthEnv();
  const port = await freePort();
  process.env.FLOWLET_ADMIN_AUTH_MODE = "token";
  process.env.FLOWLET_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.FLOWLET_PUBLIC_WEB_URL = `http://127.0.0.1:${port}`;
  Object.assign(process.env, extraEnv);
  const workDir = mkdtempSync(path.join(tmpdir(), "flowlet-cli-auth-"));
  const staticDir = path.join(workDir, "static");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>test</title>");
  const configPath = path.join(workDir, "config.json");
  writeFileSync(configPath, "{}\n");

  const credentialRow: JsonRow = {
    id: "cred-1",
    name: "公司 Dockhand",
    provider: "dockhand",
    base_url: "http://10.177.40.105:3000",
    secret_ciphertext: "v1:tabc",
    secret_hint: "••••9x8y",
    kind: "cli_token",
    note: null,
    env_prefix: "DOCKHAND_NA",
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_verified_at: null,
    last_error: null,
  };

  const runtimeSnapshot: JsonRow = {
    channels: [],
    accounts: [],
    routes: [],
    rules: [],
    virtual_models: [],
  };
  // 真实内存语义的 cli_auth_tokens + 只读凭证（token 作用域端到端可验证）。
  class FakeHostStorage extends FakeCliAuthStorage {
    listServiceCredentials(): JsonRow[] {
      return [credentialRow];
    }
    getAppMeta(): string | null {
      return null;
    }
    setAppMeta(): void {}
    listChannelModels(): JsonRow[] {
      return [];
    }
  }
  const web = createWebHost({
    storage: new FakeHostStorage() as unknown as never,
    proxy: {
      start: async () => {},
      stop: async () => {},
      status: () => ({ running: false, bind_addr: "127.0.0.1:0", started_at: null }),
      bindConfig: () => ({ host: "127.0.0.1", port: 0, allow_lan: false, default_client_token: CLIENT_TOKEN }),
      setBindConfig: () => {},
    },
    runtimeConfig: {
      snapshot: () => runtimeSnapshot,
      replace: () => {},
      update: (mutate: (draft: JsonRow) => void) => mutate(runtimeSnapshot),
    },
    bindConfig: { host: "127.0.0.1", port: 0, allow_lan: false, default_client_token: CLIENT_TOKEN },
    secrets: {
      encrypt: (plaintext: string) => `v1:${Buffer.from(plaintext, "utf8").toString("base64")}`,
      decrypt: (encoded: string) =>
        Buffer.from(encoded.replace(/^v1:/, ""), "base64").toString("utf8"),
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
  await web.listen(`127.0.0.1:${port}`);
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = async (): Promise<void> => {
    await web.close();
    rmSync(workDir, { recursive: true, force: true });
  };
  cleanupCallbacks.push(close);
  return { baseUrl, close };
}

async function request(
  baseUrl: string,
  pathname: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<TestResponse> {
  const response = await fetch(baseUrl + pathname, {
    method: options.method ?? "GET",
    redirect: "manual",
    headers: options.headers ?? {},
    body: options.body,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let json: Record<string, unknown> | null = null;
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      json = JSON.parse(buffer.toString("utf8")) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  return { status: response.status, headers: response.headers, body: buffer, json };
}

/** 用管理 Bearer 签发授权码（token 模式下等价于浏览器点「授权」）。 */
async function issueViaHttp(
  baseUrl: string,
  challenge: string,
): Promise<{ code: string; redirectUrl: string }> {
  const response = await request(baseUrl, "/api/commands/create_cli_auth_code", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(authorizeInput(challenge)),
  });
  assert.equal(response.status, 200, response.body.toString("utf8"));
  const redirectUrl = String(response.json?.redirectUrl ?? "");
  return { code: codeOf(redirectUrl), redirectUrl };
}

describe("HTTP：CLI 授权端点与作用域", () => {
  it("/api/auth/cli/start 公开可访问，参数错误 400 + no-store", async () => {
    const { baseUrl } = await startTokenHost();
    const { challenge } = pkcePair();
    const ok = await request(
      baseUrl,
      `/api/auth/cli/start?redirect_uri=${encodeURIComponent(REDIRECT)}&state=${STATE}&code_challenge=${challenge}`,
    );
    assert.equal(ok.status, 200);
    assert.ok((ok.headers.get("content-type") ?? "").includes("text/html"));
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal(ok.headers.get("x-frame-options"), "DENY");

    const bad = await request(baseUrl, "/api/auth/cli/start?redirect_uri=http%3A%2F%2Fevil.test%2Fcb");
    assert.equal(bad.status, 400);
    assert.ok(bad.body.toString("utf8").includes("无法完成授权"));

    // 方法限制
    const post = await request(baseUrl, "/api/auth/cli/start", { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET,HEAD");
  });

  it("create_cli_auth_code 需要管理鉴权；exchange 换 token 后只能导出凭据", async () => {
    const { baseUrl } = await startTokenHost();
    const { verifier, challenge } = pkcePair();

    // 未鉴权不能签发授权码
    const unauth = await request(baseUrl, "/api/commands/create_cli_auth_code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(authorizeInput(challenge)),
    });
    assert.equal(unauth.status, 401);

    const { code } = await issueViaHttp(baseUrl, challenge);

    // exchange 公开但必须带 PKCE verifier
    const exchange = await request(baseUrl, "/api/auth/cli/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
    assert.equal(exchange.status, 200, exchange.body.toString("utf8"));
    const token = String(exchange.json?.token ?? "");
    assert.ok(token.startsWith(CLI_TOKEN_PREFIX));
    assert.equal(typeof exchange.json?.expiresAt, "string");
    assert.equal(exchange.headers.get("cache-control"), "no-store");

    // 同一授权码不能重放
    const replay = await request(baseUrl, "/api/auth/cli/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
    assert.equal(replay.status, 400);
    assert.equal(replay.json?.code, "invalid_grant");

    // 白名单命令可用
    const exported = await request(baseUrl, "/api/commands/export_service_credentials", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(exported.status, 200, exported.body.toString("utf8"));
    assert.ok(Array.isArray(exported.json));

    // 其它命令 403
    const other = await request(baseUrl, "/api/commands/list_service_credentials", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(other.status, 403);
    assert.equal(other.json?.code, "forbidden");

    // 不能用于 /api/session，也不能当管理凭据
    const session = await request(baseUrl, "/api/session", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(session.status, 401);

    // 不存在的 token → 401
    const bogus = await request(baseUrl, "/api/commands/export_service_credentials", {
      method: "POST",
      headers: { authorization: `Bearer ${CLI_TOKEN_PREFIX}bogus`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(bogus.status, 401);
  });

  it("exchange 缺字段/非法 JSON 的形状稳定", async () => {
    const { baseUrl } = await startTokenHost();
    const missing = await request(baseUrl, "/api/auth/cli/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json?.code, "invalid_request");

    const badJson = await request(baseUrl, "/api/auth/cli/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(badJson.status, 400);

    const wrongContentType = await request(baseUrl, "/api/auth/cli/exchange", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongContentType.status, 415);
  });
});

describe("HTTP：OIDC 模式下不放开管理 Bearer", () => {
  it("静态管理 token 不能签发授权码（CLI 授权只走已登录浏览器会话）", async () => {
    const { baseUrl } = await startTokenHost({
      FLOWLET_ADMIN_AUTH_MODE: "oidc",
      FLOWLET_OIDC_ISSUER: "http://idp.example.test",
      FLOWLET_OIDC_DISCOVERY_URL: "https://idp.example.test/.well-known/openid-configuration",
      FLOWLET_OIDC_ALLOW_HTTP_ISSUER: "1",
      FLOWLET_OIDC_CLIENT_ID: "cli-auth-test-client",
      FLOWLET_OIDC_CLIENT_SECRET: "cli-auth-test-secret",
      FLOWLET_OIDC_ALLOWED_SUBS: "test-sub",
      FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN: "0",
    });
    const { challenge } = pkcePair();
    const viaBearer = await request(baseUrl, "/api/commands/create_cli_auth_code", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(authorizeInput(challenge)),
    });
    assert.equal(viaBearer.status, 401, "OIDC 模式默认拒绝 Bearer（不打开 ALLOW_TOKEN_LOGIN）");

    const config = await request(baseUrl, "/api/auth/config");
    assert.equal(config.json?.mode, "oidc");
    assert.equal(config.json?.token_login, false);
  });
});
