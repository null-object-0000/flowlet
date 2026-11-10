// Web Host 管理端鉴权（token / OIDC）测试。Owner: node-web.
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/auth.test.ts
// 覆盖：token 模式回归、token 模式 5 条 auth 路由形状、OIDC 完整登录→callback→会话→
// 受保护命令→logout、state 重放/篡改、nonce 篡改、白名单拒绝、userinfo sub 不匹配、
// PKCE、Bearer 兜底，以及启动期 env 校验（fail-closed）。
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { AdminAuth, adminAuthConfigFromEnv } from "../auth.ts";
import { createWebHost } from "../index.ts";
import { FileAdminSessionStore } from "../session-store.ts";

// ─── 基础设施 ───────────────────────────────────────────────────────────────

const ADMIN_TOKEN = "0123456789abcdef0123456789";
const CLIENT_ID = "flowlet-client";
const CLIENT_SECRET = "flowlet-secret";

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

const cleanupCallbacks: Array<() => Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanupCallbacks.reverse()) await cleanup();
  clearAuthEnv();
});

interface TestHost {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHost(env: Record<string, string>, sessionStoreFile?: string): Promise<TestHost> {
  clearAuthEnv();
  Object.assign(process.env, env);
  let port: number;
  const configuredUrl = env.FLOWLET_PUBLIC_WEB_URL;
  if (configuredUrl !== undefined) {
    port = Number(new URL(configuredUrl).port);
    assert.ok(Number.isInteger(port) && port > 0, "FLOWLET_PUBLIC_WEB_URL 必须带端口");
  } else {
    port = await freePort();
    process.env.FLOWLET_PUBLIC_WEB_URL = `http://127.0.0.1:${port}`;
  }
  if (env.FLOWLET_ADMIN_AUTH_MODE === undefined) {
    process.env.FLOWLET_ADMIN_AUTH_MODE = "token";
  }
  process.env.FLOWLET_OIDC_INSECURE_HTTP ??= "1";
  process.env.FLOWLET_OIDC_ALLOW_HTTP_ISSUER ??= "1";

  const workDir = mkdtempSync(path.join(tmpdir(), "flowlet-auth-test-"));
  const staticDir = path.join(workDir, "static");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>test</title>");
  const configPath = path.join(workDir, "config.json");
  writeFileSync(configPath, "{}\n");

  const sessionStore = sessionStoreFile === undefined ? null : new FileAdminSessionStore(sessionStoreFile);
  const auth = AdminAuth.fromEnv(process.env, undefined, sessionStore);
  const bindConfig = {
    host: "127.0.0.1",
    port: 0,
    allow_lan: false,
    default_client_token: "client-token",
  };
  const runtimeSnapshot: Record<string, unknown> = {
    channels: [],
    accounts: [],
    routes: [],
    rules: [],
    virtual_models: [],
  };
  const web = createWebHost({
    storage: {
      getAppMeta: () => null,
      setAppMeta: () => {},
      listChannelModels: () => [],
    } as unknown as never,
    proxy: {
      start: async () => {},
      stop: async () => {},
      status: () => ({ running: false, bind_addr: "127.0.0.1:0", started_at: null }),
      bindConfig: () => bindConfig,
      setBindConfig: () => {},
    },
    runtimeConfig: {
      snapshot: () => runtimeSnapshot,
      replace: () => {},
      update: (mutate: (draft: Record<string, unknown>) => void) => mutate(runtimeSnapshot),
    },
    bindConfig,
    secrets: {
      encrypt: (plaintext: string) => `v1:${Buffer.from(plaintext, "utf8").toString("base64")}`,
      decrypt: (encoded: string) => Buffer.from(encoded.replace(/^v1:/, ""), "base64").toString("utf8"),
    },
    catalogDir: workDir,
    configPath,
    adminToken: process.env.FLOWLET_ADMIN_TOKEN ?? "",
    auth,
    clientToken: "client-token",
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

interface TestResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  json: Record<string, unknown> | null;
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

function setCookies(response: TestResponse): string[] {
  return response.headers.getSetCookie();
}

function findCookie(cookies: string[], name: string): string | null {
  for (const cookie of cookies) {
    if (cookie.startsWith(`${name}=`)) return cookie.split(";")[0]!.trim();
  }
  return null;
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

// ─── Mock OIDC Provider ─────────────────────────────────────────────────────

interface MockClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  nonce?: string;
  exp?: number;
  iat?: number;
  azp?: string;
}

interface TokenRequestRecord {
  authorization: string | null;
  contentType: string | null;
  form: Record<string, string>;
}

class MockOidcProvider {
  #server: Server | null = null;
  #privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  publicJwk: Record<string, string> = {};
  issuer = "";
  claims: MockClaims = {};
  userinfo: Record<string, unknown> = { sub: "user-1" };
  tokenRequests: TokenRequestRecord[] = [];
  tokenStatus = 200;
  discoveryOverrides: Record<string, unknown> = {};
  closed = false;

  async start(): Promise<void> {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.#privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" }) as Record<string, string>;
    this.publicJwk = { ...jwk, kid: "test-key", alg: "RS256", use: "sig" };
    this.#server = createHttpServer((req, res) => {
      void this.#handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", () => {
        const address = this.#server!.address();
        const port = typeof address === "object" && address ? address.port : 0;
        this.issuer = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
    cleanupCallbacks.push(
      () =>
        new Promise<void>((resolve) => {
          if (this.closed) return resolve();
          this.closed = true;
          this.#server?.close(() => resolve());
        }),
    );
  }

  discovery(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      userinfo_endpoint: `${this.issuer}/userinfo`,
      jwks_uri: `${this.issuer}/jwks`,
      code_challenge_methods_supported: ["S256"],
      ...this.discoveryOverrides,
    };
  }

  signIdToken(overrides: MockClaims = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: overrides.iss ?? this.issuer,
      aud: overrides.aud ?? CLIENT_ID,
      sub: overrides.sub ?? "user-1",
      exp: overrides.exp ?? now + 300,
      iat: overrides.iat ?? now,
    };
    const nonce = overrides.nonce ?? this.claims.nonce;
    if (nonce !== undefined) claims.nonce = nonce;
    const azp = overrides.azp ?? this.claims.azp;
    if (azp !== undefined) claims.azp = azp;
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const header = { alg: "RS256", typ: "JWT", kid: "test-key" };
    const signingInput = `${encode(header)}.${encode(claims)}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    return `${signingInput}.${signer.sign(this.#privateKey).toString("base64url")}`;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (status: number, value: unknown): void => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, { "content-type": "application/json", "content-length": String(body.length) });
      response.end(body);
    };
    if (url.pathname === "/.well-known/openid-configuration") return send(200, this.discovery());
    if (url.pathname === "/jwks") return send(200, { keys: [this.publicJwk] });
    if (url.pathname === "/userinfo") {
      if (request.headers.authorization !== "Bearer access-token") return send(401, { error: "invalid_token" });
      return send(200, this.userinfo);
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const form: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString("utf8"))) form[key] = value;
      this.tokenRequests.push({
        authorization: request.headers.authorization ?? null,
        contentType: request.headers["content-type"] ?? null,
        form,
      });
      if (this.tokenStatus !== 200) return send(this.tokenStatus, { error: "server_error" });
      return send(200, {
        id_token: this.signIdToken(this.claims),
        access_token: "access-token",
        token_type: "Bearer",
      });
    }
    send(404, { error: "not_found" });
  }
}

function oidcEnv(provider: MockOidcProvider, publicWebUrl: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    FLOWLET_ADMIN_AUTH_MODE: "oidc",
    FLOWLET_PUBLIC_WEB_URL: publicWebUrl,
    FLOWLET_OIDC_ISSUER: provider.issuer,
    FLOWLET_OIDC_DISCOVERY_URL: `${provider.issuer}/.well-known/openid-configuration`,
    FLOWLET_OIDC_ALLOW_HTTP_ISSUER: "1",
    FLOWLET_OIDC_INSECURE_HTTP: "1",
    FLOWLET_OIDC_CLIENT_ID: CLIENT_ID,
    FLOWLET_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    FLOWLET_OIDC_ALLOWED_SUBS: "user-1",
    ...extra,
  };
}

/** 启动 mock provider + host，并让 FLOWLET_PUBLIC_WEB_URL 与 host 端口一致。 */
async function startOidcHost(
  provider: MockOidcProvider,
  extraEnv: Record<string, string> = {},
  sessionStoreFile?: string,
): Promise<TestHost> {
  const port = await freePort();
  const publicUrl = `http://127.0.0.1:${port}`;
  return startHost(oidcEnv(provider, publicUrl, extraEnv), sessionStoreFile);
}

interface LoginStart {
  state: string;
  nonce: string;
  challenge: string | null;
  browserCookie: string;
  location: URL;
}

async function beginLogin(host: TestHost): Promise<LoginStart> {
  const response = await request(host.baseUrl, "/api/auth/login");
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  const browserCookie = findCookie(setCookies(response), "flowlet-oidc-browser");
  assert.ok(browserCookie, "应下发浏览器绑定 Cookie");
  return {
    state: location.searchParams.get("state") ?? "",
    nonce: location.searchParams.get("nonce") ?? "",
    challenge: location.searchParams.get("code_challenge"),
    browserCookie,
    location,
  };
}

async function runCallback(
  host: TestHost,
  login: LoginStart,
  overrides: { code?: string; state?: string; browserCookie?: string } = {},
): Promise<{ status: number; location: string | null; sessionCookie: string | null; cookies: string[] }> {
  const response = await request(
    host.baseUrl,
    `/api/auth/callback?code=${encodeURIComponent(overrides.code ?? "valid-code")}&state=${encodeURIComponent(
      overrides.state ?? login.state,
    )}`,
    { headers: { cookie: overrides.browserCookie ?? login.browserCookie } },
  );
  const cookies = setCookies(response);
  return {
    status: response.status,
    location: response.headers.get("location"),
    sessionCookie: findCookie(cookies, "flowlet-admin"),
    cookies,
  };
}

interface SessionInfo {
  sessionCookie: string;
  csrfToken: string;
  identity: Record<string, unknown>;
}

async function loginFlow(host: TestHost, provider: MockOidcProvider, claims: MockClaims = {}): Promise<SessionInfo> {
  const login = await beginLogin(host);
  provider.claims = { ...claims, nonce: login.nonce };
  const callback = await runCallback(host, login);
  assert.equal(callback.status, 303);
  assert.equal(callback.location, "/");
  assert.ok(callback.sessionCookie, "登录成功应下发会话 Cookie");
  const session = await request(host.baseUrl, "/api/session", {
    headers: { cookie: callback.sessionCookie! },
  });
  assert.equal(session.status, 200);
  const body = session.json ?? {};
  assert.equal(body.mode, "oidc");
  assert.equal(body.authenticated, true);
  return {
    sessionCookie: callback.sessionCookie!,
    csrfToken: String(body.csrf_token),
    identity: (body.identity ?? {}) as Record<string, unknown>,
  };
}

async function postCommand(
  host: TestHost,
  session: { sessionCookie: string; csrfToken: string },
  options: { csrf?: boolean; origin?: string | null } = {},
): Promise<TestResponse> {
  const headers: Record<string, string> = {
    cookie: session.sessionCookie,
    "content-type": "application/json",
  };
  if (options.csrf !== false) headers["x-csrf-token"] = session.csrfToken;
  const origin = options.origin === undefined ? host.baseUrl : options.origin;
  if (origin !== null) headers.origin = origin;
  return request(host.baseUrl, "/api/commands/ipc_ping", { method: "POST", headers, body: "{}" });
}

// ─── token 模式回归 ─────────────────────────────────────────────────────────

describe("token 模式", () => {
  it("Bearer 鉴权 + /api/session 新形状（mode/csrf_token）", async () => {
    const host = await startHost({ FLOWLET_ADMIN_TOKEN: ADMIN_TOKEN });
    const session = await request(host.baseUrl, "/api/session", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(session.status, 200);
    assert.equal(session.headers.get("cache-control"), "no-store");
    assert.deepEqual(session.json, { authenticated: true, mode: "token", csrf_token: null });

    const bad = await request(host.baseUrl, "/api/session", {
      headers: { authorization: "Bearer wrong-token-value-000000" },
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.json?.code, "unauthorized");
    assert.equal(bad.headers.get("cache-control"), null);

    const command = await request(host.baseUrl, "/api/commands/ipc_ping", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(command.status, 200);
    assert.deepEqual(command.json, { ok: true, host: "web" });
  });

  it("/api/auth/config 返回 token 形状且 no-store", async () => {
    const host = await startHost({ FLOWLET_ADMIN_TOKEN: ADMIN_TOKEN });
    const response = await request(host.baseUrl, "/api/auth/config");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(response.json, {
      mode: "token",
      provider: { display_name: null },
      login_path: "/api/auth/login",
      token_login: true,
    });
  });

  it("login 未启用 OIDC 返回 404 auth_not_configured", async () => {
    const host = await startHost({ FLOWLET_ADMIN_TOKEN: ADMIN_TOKEN });
    const response = await request(host.baseUrl, "/api/auth/login");
    assert.equal(response.status, 404);
    assert.equal(response.json?.code, "auth_not_configured");
  });

  it("callback 缺 code/state 时 303 login_failed 并清 browser cookie", async () => {
    const host = await startHost({ FLOWLET_ADMIN_TOKEN: ADMIN_TOKEN });
    const response = await request(host.baseUrl, "/api/auth/callback");
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/?auth_error=login_failed");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(setCookies(response).some((cookie) => cookie.startsWith("flowlet-oidc-browser=;")));
  });

  it("logout：无凭据 401；Bearer 204 + no-store + 清会话 cookie", async () => {
    const host = await startHost({ FLOWLET_ADMIN_TOKEN: ADMIN_TOKEN });
    const anonymous = await request(host.baseUrl, "/api/auth/logout", { method: "POST" });
    assert.equal(anonymous.status, 401);

    const response = await request(host.baseUrl, "/api/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(setCookies(response).some((cookie) => cookie.startsWith("flowlet-admin=;")));
  });

  it("受保护路由方法错误仍走鉴权：401 带 allow，鉴权后 405 + no-store", async () => {
    const host = await startHost({ FLOWLET_ADMIN_TOKEN: ADMIN_TOKEN });
    const anonymous = await request(host.baseUrl, "/api/commands/ipc_ping");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("allow"), "POST");

    const authorized = await request(host.baseUrl, "/api/commands/ipc_ping", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(authorized.status, 405);
    assert.equal(authorized.headers.get("allow"), "POST");
    assert.equal(authorized.headers.get("cache-control"), "no-store");
  });
});

// ─── OIDC 流程 ──────────────────────────────────────────────────────────────

describe("OIDC 模式", () => {
  it("/api/auth/config 返回 OIDC 形状", async () => {
    const provider = new MockOidcProvider();
    await provider.start();
    const host = await startOidcHost(provider);
    const response = await request(host.baseUrl, "/api/auth/config");
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, {
      mode: "oidc",
      provider: { display_name: "GitLab" },
      login_path: "/api/auth/login",
      token_login: false,
    });
    // 未登录会话探测 → 401（与 Rust 中间件一致）
    const session = await request(host.baseUrl, "/api/session");
    assert.equal(session.status, 401);
  });

  it("完整登录 → callback → 会话 → 受保护命令（CSRF） → logout", async () => {
    const provider = new MockOidcProvider();
    await provider.start();
    provider.userinfo = {
      sub: "user-1",
      email: "alice@corp.example",
      preferred_username: "alice",
      name: "Alice Zhang",
      groups: ["flowlet-admins"],
    };
    const host = await startOidcHost(provider);
    const session = await loginFlow(host, provider);
    assert.equal(session.identity.email, "alice@corp.example");
    assert.equal(session.identity.username, "alice");
    assert.equal(session.identity.name, "Alice Zhang");
    assert.equal(session.identity.provider, "GitLab");
    assert.ok(session.csrfToken.length >= 32);

    const ok = await postCommand(host, session);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true, host: "web" });

    const missingCsrf = await postCommand(host, session, { csrf: false });
    assert.equal(missingCsrf.status, 403);
    assert.equal(missingCsrf.json?.code, "csrf_rejected");

    const wrongOrigin = await postCommand(host, session, { origin: "http://evil.example" });
    assert.equal(wrongOrigin.status, 403);

    const noOrigin = await postCommand(host, session, { origin: null });
    assert.equal(noOrigin.status, 403);

    const logout = await request(host.baseUrl, "/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: session.sessionCookie,
        "x-csrf-token": session.csrfToken,
        origin: host.baseUrl,
      },
    });
    assert.equal(logout.status, 204);
    assert.equal(logout.headers.get("cache-control"), "no-store");
    assert.ok(setCookies(logout).some((cookie) => cookie.startsWith("flowlet-admin=;")));

    const after = await request(host.baseUrl, "/api/session", {
      headers: { cookie: session.sessionCookie },
    });
    assert.equal(after.status, 401);
  });

  it("CSRF 先于方法路由：POST /api/session 无 CSRF → 403，有 CSRF → 405", async () => {
    const provider = new MockOidcProvider();
    await provider.start();
    provider.userinfo = { sub: "user-1", email: "alice@corp.example" };
    const host = await startOidcHost(provider);
    const session = await loginFlow(host, provider);
    const missingCsrf = await request(host.baseUrl, "/api/session", {
      method: "POST",
      headers: { cookie: session.sessionCookie, origin: host.baseUrl },
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(missingCsrf.json?.code, "csrf_rejected");
    assert.equal(missingCsrf.headers.get("cache-control"), null);

    const withCsrf = await request(host.baseUrl, "/api/session", {
      method: "POST",
      headers: {
        cookie: session.sessionCookie,
        origin: host.baseUrl,
        "x-csrf-token": session.csrfToken,
      },
    });
    assert.equal(withCsrf.status, 405);
    assert.equal(withCsrf.headers.get("allow"), "GET,HEAD");
    assert.equal(withCsrf.headers.get("cache-control"), "no-store");
  });

  it("登录参数与 token 交换（state/nonce/PKCE verifier/基本认证）", async () => {
    const provider = new MockOidcProvider();
    await provider.start();
    const host = await startOidcHost(provider);
    const login = await beginLogin(host);
    assert.equal(login.location.pathname, "/authorize");
    assert.equal(login.location.searchParams.get("response_type"), "code");
    assert.equal(login.location.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(login.location.searchParams.get("redirect_uri"), `${host.baseUrl}/api/auth/callback`);
    assert.equal(login.location.searchParams.get("scope"), "openid");
    assert.equal(login.location.searchParams.get("nonce"), login.nonce);
    assert.ok(login.challenge, "S256 应发送 PKCE challenge");
    assert.equal(login.location.searchParams.get("code_challenge_method"), "S256");

    provider.claims = { nonce: login.nonce };
    const callback = await runCallback(host, login);
    assert.equal(callback.status, 303);
    assert.equal(provider.tokenRequests.length, 1);
    const tokenRequest = provider.tokenRequests[0]!;
    assert.equal(tokenRequest.form.grant_type, "authorization_code");
    assert.equal(tokenRequest.form.code, "valid-code");
    assert.equal(tokenRequest.form.redirect_uri, `${host.baseUrl}/api/auth/callback`);
    assert.equal(tokenRequest.contentType, "application/x-www-form-urlencoded");
    assert.equal(
      tokenRequest.authorization,
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, "utf8").toString("base64")}`,
    );
    const verifier = tokenRequest.form.code_verifier ?? "";
    assert.match(verifier, /^[a-f0-9]{64}$/);
    assert.equal(sha256Base64Url(verifier), login.challenge);
  });

  it("state 篡改被拒绝；已消费 state 重放被拒绝（state_invalid）", async () => {
    const provider = new MockOidcProvider();
    await provider.start();
    const host = await startOidcHost(provider);
    const tamperedLogin = await beginLogin(host);
    const tampered = await runCallback(host, tamperedLogin, { state: "tampered-state" });
    assert.equal(tampered.status, 303);
    assert.equal(tampered.location, "/?auth_error=state_invalid");

    // 成功消费一次后，同一个 state 再次回调必须被拒（事务一次性）。
    const login = await beginLogin(host);
    provider.claims = { nonce: login.nonce };
    const first = await runCallback(host, login);
    assert.equal(first.location, "/");
    const replay = await runCallback(host, login);
    assert.equal(replay.status, 303);
    assert.equal(replay.location, "/?auth_error=state_invalid");
  });

  it("nonce 不匹配 → login_failed", async () => {
    const provider = new MockOidcProvider();
    await provider.start();
    const host = await startOidcHost(provider);
    const login = await beginLogin(host);
    provider.claims = { nonce: "tampered-nonce" };
    const callback = await runCallback(host, login);
    assert.equal(callback.status, 303);
    assert.equal(callback.location, "/?auth_error=login_failed");
  });

  it("白名单拒绝 → allowlist_denied；邮箱域名单可通过", async () => {
    const provider = new MockOidcProvider();
    await provider.start();
    const deniedHost = await startOidcHost(provider);
    provider.claims = { sub: "user-2" };
    provider.userinfo = { sub: "user-2", email: "bob@other.example" };
    const deniedLogin = await beginLogin(deniedHost);
    provider.claims = { sub: "user-2", nonce: deniedLogin.nonce };
    const denied = await runCallback(deniedHost, deniedLogin);
    assert.equal(denied.location, "/?auth_error=allowlist_denied");

    const domainHost = await startOidcHost(provider, {
      FLOWLET_OIDC_ALLOWED_SUBS: "",
      FLOWLET_OIDC_ALLOWED_DOMAINS: "corp.example",
    });
    provider.userinfo = { sub: "user-1", email: "alice@corp.example" };
    const session = await loginFlow(domainHost, provider, { sub: "user-1" });
    assert.equal(session.identity.email, "alice@corp.example");
  });

  it("userinfo sub 与 id_token 不一致 → login_failed", async () => {
    const provider = new MockOidcProvider();
    await provider.start();
    const host = await startOidcHost(provider);
    const login = await beginLogin(host);
    provider.claims = { sub: "user-1", nonce: login.nonce };
    provider.userinfo = { sub: "user-other", email: "alice@corp.example" };
    const callback = await runCallback(host, login);
    assert.equal(callback.status, 303);
    assert.equal(callback.location, "/?auth_error=login_failed");
  });

  it("PKCE=required 但 discovery 未声明 S256 → 503 provider_unavailable", async () => {
    const provider = new MockOidcProvider();
    await provider.start();
    provider.discoveryOverrides = { code_challenge_methods_supported: undefined };
    const host = await startOidcHost(provider, { FLOWLET_OIDC_PKCE: "required" });
    const response = await request(host.baseUrl, "/api/auth/login");
    assert.equal(response.status, 503);
    assert.equal(response.json?.code, "provider_unavailable");
  });

  it("token 端点非 2xx → login_failed", async () => {
    const provider = new MockOidcProvider();
    await provider.start();
    const host = await startOidcHost(provider);
    const login = await beginLogin(host);
    provider.claims = { nonce: login.nonce };
    provider.tokenStatus = 500;
    const callback = await runCallback(host, login);
    assert.equal(callback.location, "/?auth_error=login_failed");
  });

  it("OIDC 模式默认拒绝 Bearer；ALLOW_TOKEN_LOGIN=1 时命令可用但 /api/session 无身份", async () => {
    const provider = new MockOidcProvider();
    await provider.start();
    const strictHost = await startOidcHost(provider);
    const strict = await request(strictHost.baseUrl, "/api/commands/ipc_ping", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(strict.status, 401);

    const fallbackHost = await startOidcHost(provider, {
      FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN: "1",
      FLOWLET_ADMIN_TOKEN: ADMIN_TOKEN,
    });
    const command = await request(fallbackHost.baseUrl, "/api/commands/ipc_ping", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(command.status, 200);
    // Bearer 通过中间件后 /api/session 因无 Cookie 身份返回 401「会话无效」（与 Rust 一致）。
    const session = await request(fallbackHost.baseUrl, "/api/session", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(session.status, 401);
    assert.equal(session.json?.message, "会话无效");
    assert.equal(session.headers.get("cache-control"), "no-store");
  });

  it("会话持久化：同一会话文件在 host 重建后仍保持登录（Docker 升级场景）", async () => {
    const provider = new MockOidcProvider();
    await provider.start();
    provider.userinfo = { sub: "user-1", email: "alice@corp.example" };
    const storeDir = mkdtempSync(path.join(tmpdir(), "flowlet-session-store-"));
    const storeFile = path.join(storeDir, "admin-sessions.json");
    try {
      const first = await startOidcHost(provider, {}, storeFile);
      const session = await loginFlow(first, provider);
      assert.ok(existsSync(storeFile), "登录成功后会话应写入持久化文件");
      // 落盘的是会话 key 的 sha256，不应出现原始 cookie 值。
      const raw = readFileSync(storeFile, "utf8");
      assert.ok(!raw.includes(session.sessionCookie.split("=")[1] ?? "__never__"), "不得落盘原始 cookie");

      // 模拟容器重启：旧 host 关闭，新 host 用同一个会话文件。
      await first.close();
      const second = await startOidcHost(provider, {}, storeFile);
      const resumed = await request(second.baseUrl, "/api/session", {
        headers: { cookie: session.sessionCookie },
      });
      assert.equal(resumed.status, 200);
      const identity = (resumed.json?.identity ?? {}) as Record<string, unknown>;
      assert.equal(identity.email, "alice@corp.example");
      assert.equal(identity.provider, "GitLab");
      const csrf = resumed.json?.csrf_token as string | undefined;
      assert.ok(csrf, "恢复的会话应带回 CSRF token");
      // 恢复后的会话仍可执行受保护命令（CSRF 校验通过）。
      const command = await request(second.baseUrl, "/api/commands/ipc_ping", {
        method: "POST",
        headers: {
          cookie: session.sessionCookie,
          origin: second.baseUrl,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: "{}",
      });
      assert.equal(command.status, 200);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
});

// ─── 启动期 env 校验（fail-closed） ────────────────────────────────────────

describe("AdminAuthConfig 启动校验", () => {
  const base = (overrides: Record<string, string>): Record<string, string> => ({
    FLOWLET_ADMIN_AUTH_MODE: "oidc",
    FLOWLET_PUBLIC_WEB_URL: "https://flowlet.example.com",
    FLOWLET_OIDC_ISSUER: "https://gitlab.example.com",
    FLOWLET_OIDC_CLIENT_ID: CLIENT_ID,
    FLOWLET_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    FLOWLET_OIDC_ALLOWED_SUBS: "user-1",
    ...overrides,
  });

  it("token 模式要求 ≥24 字符", () => {
    assert.throws(
      () => adminAuthConfigFromEnv({ FLOWLET_ADMIN_AUTH_MODE: "token", FLOWLET_ADMIN_TOKEN: "short" }),
      /FLOWLET_ADMIN_TOKEN 必须至少包含 24 个字符/,
    );
  });

  it("未知模式 / 缺失 PUBLIC_WEB_URL / 子路径 / 查询串被拒绝", () => {
    assert.throws(
      () => adminAuthConfigFromEnv({ FLOWLET_ADMIN_AUTH_MODE: "saml" }),
      /未知的 FLOWLET_ADMIN_AUTH_MODE/,
    );
    assert.throws(() => adminAuthConfigFromEnv(base({ FLOWLET_PUBLIC_WEB_URL: "" })), /必须设置 FLOWLET_PUBLIC_WEB_URL/);
    assert.throws(
      () => adminAuthConfigFromEnv(base({ FLOWLET_PUBLIC_WEB_URL: "https://flowlet.example.com/app" })),
      /不支持子路径/,
    );
    assert.throws(
      () => adminAuthConfigFromEnv(base({ FLOWLET_PUBLIC_WEB_URL: "https://flowlet.example.com?a=1" })),
      /不允许查询串或片段/,
    );
  });

  it("http issuer 需显式 ALLOW_HTTP_ISSUER + HTTPS discovery URL", () => {
    const httpIssuer = {
      FLOWLET_ADMIN_AUTH_MODE: "oidc",
      FLOWLET_PUBLIC_WEB_URL: "http://127.0.0.1:20134",
      FLOWLET_OIDC_ISSUER: "http://gitlab.internal",
      FLOWLET_OIDC_CLIENT_ID: CLIENT_ID,
      FLOWLET_OIDC_CLIENT_SECRET: CLIENT_SECRET,
      FLOWLET_OIDC_ALLOWED_SUBS: "user-1",
    };
    assert.throws(() => adminAuthConfigFromEnv(httpIssuer), /issuer 非 https/);
    assert.throws(
      () => adminAuthConfigFromEnv({ ...httpIssuer, FLOWLET_OIDC_ALLOW_HTTP_ISSUER: "1" }),
      /必须显式设置 https 的 FLOWLET_OIDC_DISCOVERY_URL/,
    );
    const ok = adminAuthConfigFromEnv({
      ...httpIssuer,
      FLOWLET_OIDC_ALLOW_HTTP_ISSUER: "1",
      FLOWLET_OIDC_DISCOVERY_URL: "https://gitlab.internal/.well-known/openid-configuration",
    });
    assert.equal(ok.oidc?.issuer, "http://gitlab.internal");
  });

  it("准入名单 fail-closed、会话时间关系、SIGNING_ALGS 校验", () => {
    assert.throws(
      () => adminAuthConfigFromEnv(base({ FLOWLET_OIDC_ALLOWED_SUBS: "" })),
      /必须配置准入名单/,
    );
    assert.throws(
      () => adminAuthConfigFromEnv(base({ FLOWLET_ADMIN_SESSION_IDLE_MINUTES: "540", FLOWLET_ADMIN_SESSION_TTL_HOURS: "8" })),
      /空闲超时不能大于绝对超时/,
    );
    assert.throws(
      () => adminAuthConfigFromEnv(base({ FLOWLET_OIDC_SIGNING_ALGS: "RS256,ES256" })),
      /当前实现只支持 RS256 ID token/,
    );
    assert.throws(
      () =>
        adminAuthConfigFromEnv(
          base({ FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN: "1", FLOWLET_ADMIN_TOKEN: "short" }),
        ),
      /开启 ALLOW_TOKEN_LOGIN 时 FLOWLET_ADMIN_TOKEN 必须至少包含 24 个字符/,
    );
  });

  it("cookie Secure：默认按 URL scheme，always/never 可覆盖；全部默认值对齐 Rust", () => {
    const https = adminAuthConfigFromEnv(base({}));
    assert.equal(https.cookieSecure, true);
    assert.equal(https.sessionIdleMs, 30 * 60 * 1000);
    assert.equal(https.sessionTtlMs, 8 * 3600 * 1000);
    assert.equal(https.oidc?.displayName, "GitLab");
    assert.equal(https.oidc?.emailClaim, "email");
    assert.equal(https.oidc?.pkce, "auto");
    assert.equal(https.oidc?.nonce, "required");

    const httpNever = adminAuthConfigFromEnv(
      base({ FLOWLET_PUBLIC_WEB_URL: "http://127.0.0.1:20134", FLOWLET_ADMIN_COOKIE_SECURE: "never" }),
    );
    assert.equal(httpNever.cookieSecure, false);

    const httpsAlways = adminAuthConfigFromEnv(base({ FLOWLET_ADMIN_COOKIE_SECURE: "always" }));
    assert.equal(httpsAlways.cookieSecure, true);

    // 非法数值回落默认值（Rust parse::<u64>().ok().unwrap_or(30)）
    const invalid = adminAuthConfigFromEnv(
      base({ FLOWLET_ADMIN_SESSION_IDLE_MINUTES: "abc", FLOWLET_ADMIN_SESSION_TTL_HOURS: "-3" }),
    );
    assert.equal(invalid.sessionIdleMs, 30 * 60 * 1000);
    assert.equal(invalid.sessionTtlMs, 8 * 3600 * 1000);
  });
});
