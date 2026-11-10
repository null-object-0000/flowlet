// 三方服务凭据（GitLab / Dockhand / Jenkins / Beszel）测试。Owner: node-web.
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/credentials.test.ts
// 覆盖：URL 归一/子路径/绝对 URL 拒绝、GitLab 10.8.7 /user+/version 语义（403 降级）、
// save 先校验后落库、编辑空 token 保留原值、掩码不泄明文、test 写回验证时间/错误、
// delete、export 仅 enabled 明文、envKeys、分页头、服务和邮箱凭据的 username 列。
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { after, describe, it } from "node:test";

import type { JsonRow } from "../../types.ts";
import type { WebContext } from "../context.ts";
import type { SecretBoxLike } from "../context.ts";
import {
  checkBeszel,
  checkDockhand,
  checkGitlab,
  checkJenkins,
  defaultEnvPrefix,
  deleteCredential,
  envKeys,
  exportCredentials,
  isSupportedProvider,
  list,
  maskSecret,
  normalizeEnvPrefix,
  nowRfc3339,
  providers,
  save,
  test as testCredential,
  validateEnvPrefixConflict,
} from "../credentials.ts";
import { GitlabClient, normalizeBaseUrl, resolveApiPath } from "../gitlab.ts";
import { basicAuthorization as registryBasicAuthorization } from "../registry.ts";

const VALID_TOKEN = "glpat-valid-token-1a2b";
const ADMIN_TOKEN = "glpat-admin-token-9z8y";
const DOCKHAND_TOKEN = "dockhand-test-fixture-token-9x8y";
const JENKINS_USERNAME = "ci-bot";
const JENKINS_TOKEN = "jenkins-test-fixture-token-9q8w";
const BESZEL_EMAIL = "ops@example.com";
const BESZEL_PASSWORD = "beszel-test-fixture-password-9k7j";
const BESZEL_TOKEN = "pb-fixture-token-4c5d";
// Harbor robot account 形态：`$` 与 `+` 必须被接受。
const REGISTRY_USERNAME = "robot$flowlet+pull";
const REGISTRY_PASSWORD = "registry-test-fixture-token-4b3c";
const REGISTRY_BEARER_TOKEN = "registry-test-bearer-token-1z2y";

// ─── Fake storage（node-storage 最后提供真实实现；这里验证编排语义） ────────

class FakeCredentialStorage {
  rows = new Map<string, JsonRow>();
  upserts = 0;

  listServiceCredentials(): JsonRow[] {
    return [...this.rows.values()].sort((a, b) => {
      const created = String(a.created_at).localeCompare(String(b.created_at));
      return created !== 0 ? created : String(a.name).localeCompare(String(b.name));
    });
  }

  getServiceCredential(id: string): JsonRow | null {
    return this.rows.get(id) ?? null;
  }

  upsertServiceCredential(row: JsonRow): void {
    this.upserts += 1;
    const existing = this.rows.get(String(row.id));
    this.rows.set(
      String(row.id),
      existing === undefined ? { ...row } : { ...row, created_at: existing.created_at },
    );
  }

  updateServiceCredentialVerification(
    id: string,
    verifiedAt: string | null,
    lastError: string | null,
  ): void {
    const row = this.rows.get(id);
    if (row === undefined) return;
    if (verifiedAt !== null) row.last_verified_at = verifiedAt;
    row.last_error = lastError;
    row.updated_at = nowRfc3339();
  }

  deleteServiceCredential(id: string): boolean {
    return this.rows.delete(id);
  }
}

function fakeSecrets(): SecretBoxLike {
  // 模拟真实 ChaCha20-Poly1305 的随机 nonce：同一明文每次密文不同。
  let counter = 0;
  return {
    encrypt: (plaintext: string) => {
      counter += 1;
      return `v1:${counter}:${Buffer.from(plaintext, "utf8").toString("base64")}`;
    },
    decrypt: (encoded: string) => {
      const match = /^v1:([^:]+):(.*)$/.exec(encoded);
      if (match === null) throw new Error("凭据密文版本不支持，请重新保存该凭据");
      return Buffer.from(match[2]!, "base64").toString("utf8");
    },
  };
}

function makeCtx(storage: FakeCredentialStorage, secrets: SecretBoxLike = fakeSecrets()): WebContext {
  return {
    storage: storage as unknown as never,
    secrets,
    proxy: {} as never,
    runtimeConfig: { snapshot: () => ({}), replace: () => {}, update: () => undefined },
    catalogDir: "",
    configPath: "",
    adminToken: "",
    clientToken: "",
    staticDir: "",
    publicProxyUrl: "",
    deviceIdentity: {
      schema_version: 1,
      device_id: "11111111-1111-4111-8111-111111111111",
      created_at: "2026-01-01T00:00:00Z",
      display_name: "Flowlet Host",
      platform: "linux",
    },
    config: {},
    channelsConfig: {},
    logCapture: {
      capture_req_headers: true,
      capture_req_body: true,
      capture_res_headers: true,
      capture_res_body: true,
      max_body_bytes: 1024,
      redact_sensitive_headers: false,
      body_retention_days: 7,
      body_max_size_mb: 1024,
      body_prune_ratio: 0.1,
    },
    upstreamProxy: { enabled: false, url: "" },
    customScrapeChannels: null,
    // 凭据编排不用 CLI 授权：给一个不落库的占位实现（cliAuth 的用例在 cli-auth.test.ts）。
    cliAuth: {
      startPage: () => ({ status: 400, html: "" }),
      authorize: () => ({ redirectUrl: "" }),
      exchange: () => {
        throw new Error("未使用");
      },
      authenticate: () => null,
      list: () => [],
      revoke: () => null,
    },
  };
}

// ─── Mock GitLab CE 10.8.7 ─────────────────────────────────────────────────

interface GitlabMockOptions {
  username?: string;
  version?: string;
  /** /version 返回的状态码；403/404 时 Rust `version()` 静默降级为 null。 */
  versionStatus?: number;
  /** true 时模拟旧实例没有 /version 路由（404）。 */
  hideVersion?: boolean;
}

class MockGitlab {
  #server: Server | null = null;
  baseUrl = "";
  // 子路径部署：所有端点都在 /gitlab/api/v4/... 下。
  subpath = "/gitlab";
  options: GitlabMockOptions = {};
  privateTokens: string[] = [];
  requests: Array<{ method: string; path: string }> = [];
  projectsPages: JsonRow[][] = [];

  async start(): Promise<void> {
    this.#server = createHttpServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", () => {
        const address = this.#server!.address();
        const port = typeof address === "object" && address ? address.port : 0;
        this.baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          this.#server?.close(() => resolve());
        }),
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponseLike): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = request.headers["private-token"];
    this.requests.push({ method: request.method ?? "GET", path: `${url.pathname}${url.search}` });
    if (typeof token === "string") this.privateTokens.push(token);
    const send = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(body.length),
        ...headers,
      });
      response.end(body);
    };

    const suffix = url.pathname.startsWith(this.subpath)
      ? url.pathname.slice(this.subpath.length)
      : url.pathname;
    if (suffix === "/api/v4/user") {
      if (token !== VALID_TOKEN) return send(401, { message: "401 Unauthorized" });
      return send(200, { id: 42, username: this.options.username ?? "alice", name: "Alice" });
    }
    if (suffix === "/api/v4/version") {
      if (this.options.hideVersion) return send(404, { message: "404 Not Found" });
      if (this.options.versionStatus !== undefined && this.options.versionStatus !== 200) {
        return send(this.options.versionStatus, { message: `${this.options.versionStatus} Forbidden` });
      }
      if (token !== VALID_TOKEN) return send(401, { message: "401 Unauthorized" });
      return send(200, { version: this.options.version ?? "10.8.7" });
    }
    if (suffix === "/api/v4/projects") {
      if (token !== VALID_TOKEN) return send(401, { message: "401 Unauthorized" });
      const page = Number(url.searchParams.get("page") ?? "1");
      const batch = this.projectsPages[page - 1] ?? [];
      const headers: Record<string, string> = { "x-page": String(page) };
      if (page < this.projectsPages.length) headers["x-next-page"] = String(page + 1);
      headers["x-total"] = String(this.projectsPages.flat().length);
      return send(200, batch, headers);
    }
    send(404, { message: "404 Not Found" });
  }
}

interface ServerResponseLike {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: Buffer): void;
}

// ─── Mock Dockhand 1.0.57 ──────────────────────────────────────────────────

class MockDockhand {
  #server: Server | null = null;
  baseUrl = "";
  // 子路径部署：所有端点都在 /dockhand/api/... 下。
  subpath = "/dockhand";
  environments: unknown = [
    {
      id: 2,
      name: "[CentOS] 10.0.0.60",
      host: "10.0.0.60",
      port: 2375,
      protocol: "http",
    },
    { id: 3, name: "本地 Docker", host: "10.0.0.61", port: 2375, protocol: "http" },
  ];
  authorizations: Array<string | undefined> = [];
  requests: Array<{ method: string; path: string }> = [];

  async start(): Promise<void> {
    this.#server = createHttpServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", () => {
        const address = this.#server!.address();
        const port = typeof address === "object" && address ? address.port : 0;
        this.baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          this.#server?.close(() => resolve());
        }),
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponseLike): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const authorization = request.headers.authorization;
    this.requests.push({ method: request.method ?? "GET", path: `${url.pathname}${url.search}` });
    this.authorizations.push(typeof authorization === "string" ? authorization : undefined);
    const send = (status: number, value: unknown): void => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(body.length),
      });
      response.end(body);
    };

    const suffix = url.pathname.startsWith(this.subpath)
      ? url.pathname.slice(this.subpath.length)
      : url.pathname;
    if (suffix === "/api/environments") {
      // 认证失败返回 401 JSON（实测行为）；/health 匿名可访问但不可用于校验 token。
      if (authorization !== `Bearer ${DOCKHAND_TOKEN}`) return send(401, { message: "Unauthorized" });
      return send(200, this.environments);
    }
    send(404, { message: "404 Not Found" });
  }
}

// ─── Mock Jenkins LTS（`/me/api/json` 身份端点） ──────────────────────────

class MockJenkins {
  #server: Server | null = null;
  baseUrl = "";
  // Jenkins 上下文路径部署：所有端点都在 /jenkins/... 下。
  subpath = "/jenkins";
  version = "2.452.1";
  fullName = "CI Bot";
  id = "ci-bot";
  authorizations: Array<string | undefined> = [];
  requests: Array<{ method: string; path: string }> = [];

  async start(): Promise<void> {
    this.#server = createHttpServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", () => {
        const address = this.#server!.address();
        const port = typeof address === "object" && address ? address.port : 0;
        this.baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          this.#server?.close(() => resolve());
        }),
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponseLike): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const authorization = request.headers.authorization;
    this.requests.push({ method: request.method ?? "GET", path: `${url.pathname}${url.search}` });
    this.authorizations.push(typeof authorization === "string" ? authorization : undefined);
    const send = (
      status: number,
      value: unknown,
      headers: Record<string, string> = {},
    ): void => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(body.length),
        ...headers,
      });
      response.end(body);
    };

    const suffix = url.pathname.startsWith(this.subpath)
      ? url.pathname.slice(this.subpath.length)
      : url.pathname;
    if (suffix === "/me/api/json") {
      // Basic 认证：token 不匹配即 401，与真实 Jenkins 一致。
      const encoded = typeof authorization === "string" ? authorization.replace(/^Basic /, "") : "";
      const decoded = encoded === "" ? "" : Buffer.from(encoded, "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      const username = separator < 0 ? "" : decoded.slice(0, separator);
      const token = separator < 0 ? "" : decoded.slice(separator + 1);
      if (token !== JENKINS_TOKEN || username.trim() === "") {
        return send(401, { message: "Unauthorized" });
      }
      return send(
        200,
        { id: this.id, fullName: this.fullName },
        { "x-jenkins": this.version },
      );
    }
    send(404, { message: "404 Not Found" });
  }
}

// ─── Mock Beszel Hub（PocketBase 邮箱+密码认证 / info / systems 集合） ──────

class MockBeszel {
  #server: Server | null = null;
  baseUrl = "";
  /** info 响应里的 v；null 表示响应体不含 v（info 失败不致命场景）。 */
  version: string | null = "0.21.1";
  totalItems = 3;
  /** auth 端点强制失败时的状态；null 表示按邮箱/密码判断。 */
  authStatus: number | null = null;
  /** systems 端点强制失败时的状态。 */
  systemsStatus: number | null = null;
  /** auth 记录里的 email；undefined 表示回显 identity，空串用于测试回退入参邮箱。 */
  recordEmail: string | undefined = undefined;
  requests: Array<{
    method: string;
    path: string;
    authorization: string | undefined;
    userAgent: string | undefined;
    body: string;
  }> = [];

  async start(): Promise<void> {
    this.#server = createHttpServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", () => {
        const address = this.#server!.address();
        const port = typeof address === "object" && address ? address.port : 0;
        this.baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          this.#server?.close(() => resolve());
        }),
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponseLike): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    const body = Buffer.concat(chunks).toString("utf8");
    this.requests.push({
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      authorization:
        typeof request.headers.authorization === "string"
          ? request.headers.authorization
          : undefined,
      userAgent:
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"]
          : undefined,
      body,
    });
    const send = (status: number, value: unknown): void => {
      const payload = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(payload.length),
      });
      response.end(payload);
    };
    const authorized = request.headers.authorization === BESZEL_TOKEN;

    if (url.pathname === "/api/collections/users/auth-with-password") {
      if (this.authStatus !== null) {
        return send(this.authStatus, { code: this.authStatus, message: "Failed to authenticate." });
      }
      let parsed: JsonRow = {};
      try {
        parsed = JSON.parse(body) as JsonRow;
      } catch {
        parsed = {};
      }
      // 密码错误或 identity 不是邮箱 → PocketBase 返回 400（不是 401）。
      if (
        parsed.password !== BESZEL_PASSWORD ||
        typeof parsed.identity !== "string" ||
        !parsed.identity.includes("@")
      ) {
        return send(400, { code: 400, message: "Failed to authenticate." });
      }
      return send(200, {
        token: BESZEL_TOKEN,
        record: {
          id: "user-1",
          email: this.recordEmail === undefined ? parsed.identity : this.recordEmail,
          name: "Ops",
          role: "admin",
        },
      });
    }
    if (url.pathname === "/api/beszel/info") {
      if (!authorized) return send(401, { code: 401, message: "Unauthorized" });
      return send(200, this.version === null ? { publicKey: "x" } : { v: this.version });
    }
    if (url.pathname === "/api/collections/systems/records") {
      if (!authorized) return send(401, { code: 401, message: "Unauthorized" });
      if (this.systemsStatus !== null) {
        return send(this.systemsStatus, { code: this.systemsStatus, message: "systems-boom" });
      }
      return send(200, {
        page: 1,
        perPage: Number(url.searchParams.get("perPage") ?? "0"),
        totalItems: this.totalItems,
        totalPages: 1,
        items: [{ id: "sys-1", name: "prod-1", host: "10.0.0.1", status: "up", port: "45876" }],
      });
    }
    send(404, { code: 404, message: "404 Not Found" });
  }
}

// ─── Mock OCI Registry V2（`/v2/` + token 端点，契约 §4） ──────────────────

class MockRegistry {
  #server: Server | null = null;
  baseUrl = "";
  /** open：Basic 正确即 200；bearer：Basic 只能换 token，需 Bearer 重试才算通过。 */
  mode: "open" | "bearer" = "open";
  version: string | null = "registry/2.0";
  requests: Array<{ method: string; path: string; authorization: string | undefined }> = [];

  async start(): Promise<void> {
    this.#server = createHttpServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", () => {
        const address = this.#server!.address();
        const port = typeof address === "object" && address ? address.port : 0;
        this.baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          this.#server?.close(() => resolve());
        }),
    );
  }

  /** 用户名任意，密码必须是 fixture 密码（编辑测试会换用户名）。 */
  #authorizedBasic(authorization: string | undefined): boolean {
    if (typeof authorization !== "string" || !authorization.startsWith("Basic ")) return false;
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator <= 0) return false;
    return decoded.slice(separator + 1) === REGISTRY_PASSWORD;
  }

  async #handle(request: IncomingMessage, response: ServerResponseLike): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const authorization =
      typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
    this.requests.push({
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      authorization,
    });
    const send = (
      status: number,
      value: unknown,
      headers: Record<string, string> = {},
    ): void => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(body.length),
        ...headers,
      });
      response.end(body);
    };
    const versionHeaders: Record<string, string> =
      this.version === null ? {} : { "docker-distribution-api-version": this.version };

    if (url.pathname === "/v2/") {
      if (this.#authorizedBasic(authorization)) {
        if (this.mode === "open") return send(200, {}, versionHeaders);
        // 标准 Bearer 质询：realm 指向本 mock 的 /token。
        return send(401, {}, {
          "www-authenticate": `Bearer realm="${this.baseUrl}/token",service="registry.example.com",scope="repository:library/nginx:pull"`,
        });
      }
      if (this.mode === "bearer" && authorization === `Bearer ${REGISTRY_BEARER_TOKEN}`) {
        return send(200, {}, versionHeaders);
      }
      return send(401, {}, { "www-authenticate": 'Basic realm="registry"' });
    }
    if (url.pathname === "/token") {
      if (!this.#authorizedBasic(authorization)) return send(401, {});
      return send(200, { token: REGISTRY_BEARER_TOKEN });
    }
    send(404, {});
  }
}

const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

async function startMock(options: GitlabMockOptions = {}): Promise<MockGitlab> {
  const mock = new MockGitlab();
  mock.options = options;
  await mock.start();
  return mock;
}

async function startMockDockhand(): Promise<MockDockhand> {
  const mock = new MockDockhand();
  await mock.start();
  return mock;
}

async function startMockJenkins(): Promise<MockJenkins> {
  const mock = new MockJenkins();
  await mock.start();
  return mock;
}

async function startMockBeszel(): Promise<MockBeszel> {
  const mock = new MockBeszel();
  await mock.start();
  return mock;
}

async function startMockRegistry(): Promise<MockRegistry> {
  const mock = new MockRegistry();
  await mock.start();
  return mock;
}

function inputFor(mock: MockGitlab, overrides: Partial<JsonRow> = {}): JsonRow {
  return {
    name: "GitLab 主实例",
    provider: "gitlab",
    baseUrl: `${mock.baseUrl}/gitlab`,
    token: VALID_TOKEN,
    ...overrides,
  };
}

// ─── URL / 客户端基础 ──────────────────────────────────────────────────────

describe("GitLab 客户端基础", () => {
  it("normalizeBaseUrl：去尾斜杠/剥 /api/v4/保留子路径/拒绝非法输入", () => {
    assert.equal(normalizeBaseUrl("https://gitlab.example.com"), "https://gitlab.example.com");
    assert.equal(normalizeBaseUrl("https://gitlab.example.com/"), "https://gitlab.example.com");
    assert.equal(normalizeBaseUrl("https://gitlab.example.com/gitlab/"), "https://gitlab.example.com/gitlab");
    assert.equal(normalizeBaseUrl("https://gitlab.example.com/api/v4"), "https://gitlab.example.com");
    assert.equal(
      normalizeBaseUrl("https://gitlab.example.com/gitlab/api/v4/"),
      "https://gitlab.example.com/gitlab",
    );
    assert.equal(normalizeBaseUrl("https://GitLab.Example.com:443/"), "https://gitlab.example.com");
    assert.throws(() => normalizeBaseUrl(""), /GitLab 地址不能为空/);
    assert.throws(() => normalizeBaseUrl("ftp://gitlab.example.com"), /必须是 http 或 https/);
    assert.throws(() => normalizeBaseUrl("gitlab.example.com"), /GitLab 地址无法解析/);
    assert.throws(() => normalizeBaseUrl("https://gitlab.example.com/?a=1"), /不能带查询参数或锚点/);
    assert.throws(() => normalizeBaseUrl("https://gitlab.example.com/#x"), /不能带查询参数或锚点/);
  });

  it("resolveApiPath：相对路径/子路径/拒绝绝对 URL", () => {
    assert.equal(
      resolveApiPath("https://host/gitlab", "/projects"),
      "https://host/gitlab/api/v4/projects",
    );
    assert.equal(resolveApiPath("https://host", "projects"), "https://host/api/v4/projects");
    assert.equal(
      resolveApiPath("https://host", "/api/v4/projects"),
      "https://host/api/v4/projects",
    );
    assert.throws(
      () => resolveApiPath("https://host", "https://evil.example.com/x"),
      /不接受绝对 URL/,
    );
    assert.throws(() => resolveApiPath("https://host", ""), /API 路径不能为空/);
  });

  it("providers() 与 Rust 元数据一致", () => {
    assert.deepEqual(providers(), [
      {
        id: "gitlab",
        label: "GitLab",
        baseUrlHint: "https://gitlab.example.com",
        tokenLabel: "Personal Access Token（需要 api scope）",
        usernameLabel: null,
        defaultEnvPrefix: "GITLAB",
        available: true,
      },
      {
        id: "dockhand",
        label: "Dockhand",
        baseUrlHint: "http://dockhand.example.com:3000",
        tokenLabel: "API Token（Dockhand 设置 → API 令牌）",
        usernameLabel: null,
        defaultEnvPrefix: "DOCKHAND",
        available: true,
      },
      {
        id: "jenkins",
        label: "Jenkins",
        baseUrlHint: "https://jenkins.example.com",
        tokenLabel: "API Token（Jenkins 用户设置 → API Token）",
        usernameLabel: "用户名",
        defaultEnvPrefix: "JENKINS",
        available: true,
      },
      {
        id: "uptime-kuma",
        label: "Uptime Kuma",
        baseUrlHint: "https://uptime-kuma.example.com/uptime-kuma",
        tokenLabel: "API Key（设置 → API 密钥；仅用于读取 /metrics 指标）",
        usernameLabel: null,
        defaultEnvPrefix: "UPTIME_KUMA",
        available: true,
      },
      {
        id: "beszel",
        label: "Beszel",
        baseUrlHint: "http://beszel.example.com:8090",
        tokenLabel: "登录密码（Beszel 用户密码）",
        usernameLabel: "邮箱",
        defaultEnvPrefix: "BESZEL",
        available: true,
      },
      {
        id: "registry",
        label: "OCI 镜像仓库",
        baseUrlHint: "https://hub.example.com（只填仓库地址，不要带路径）",
        tokenLabel: "密码 / Token（docker login 的密码；Harbor robot account 填其 token）",
        usernameLabel: "用户名",
        defaultEnvPrefix: "REGISTRY",
        available: true,
      },
    ]);
  });

  it("maskSecret：≤4 位全掩码，其余保留末 4 位（按 code point）", () => {
    assert.equal(maskSecret(""), "••••");
    assert.equal(maskSecret("abc"), "••••");
    assert.equal(maskSecret("abcd"), "••••");
    assert.equal(maskSecret("abcde"), "••••bcde");
    assert.equal(maskSecret("glpat-valid-token-1a2b"), "••••1a2b");
    assert.equal(maskSecret("😀😀😀😀😀"), "••••😀😀😀😀");
  });

  it("checkGitlab：成功返回 username/version；403 时 version 降级为 null", async () => {
    const mock = await startMock();
    const ok = await checkGitlab(`${mock.baseUrl}/gitlab`, VALID_TOKEN, false);
    assert.deepEqual(ok, { ok: true, username: "alice", version: "10.8.7", detail: null, error: null });

    const restricted = await startMock({ versionStatus: 403 });
    const degraded = await checkGitlab(`${restricted.baseUrl}/gitlab`, VALID_TOKEN, false);
    assert.equal(degraded.ok, true);
    assert.equal(degraded.username, "alice");
    assert.equal(degraded.version, null);
  });

  it("projects()：X-Next-Page 分页、limit 截断、search 百分号编码", async () => {
    const mock = await startMock();
    mock.projectsPages = [
      [
        { id: 1, path_with_namespace: "g/a", name: "a", default_branch: "main" },
        { id: 2, path_with_namespace: "g/b", name: "b" },
      ],
      [{ id: 3, path_with_namespace: "g/c", name: "c" }],
    ];
    const client = new GitlabClient(`${mock.baseUrl}/gitlab`, VALID_TOKEN);
    const projects = await client.projects("my project", false, 10);
    assert.equal(projects.length, 3);
    assert.equal(projects[2]!.id, 3);
    assert.ok(
      mock.requests.some(
        (item) =>
          item.path.includes("/api/v4/projects") &&
          (item.path.includes("search=my%20project") || item.path.includes("search=my+project")),
      ),
    );
    const limited = await client.projects(null, true, 2);
    assert.equal(limited.length, 2);
  });
});

// ─── save / list / test / delete / export ──────────────────────────────────

describe("服务凭据编排", () => {
  it("save：先校验后落库，返回掩码视图且落库为密文", async () => {
    const mock = await startMock();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const view = await save(ctx, inputFor(mock) as never, false);
    assert.equal(view.name, "GitLab 主实例");
    assert.equal(view.provider, "gitlab");
    assert.equal(view.baseUrl, `${mock.baseUrl}/gitlab`);
    assert.equal(view.kind, "cli_token");
    assert.equal(view.enabled, true);
    assert.equal(view.secretHint, "••••1a2b");
    assert.match(view.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(view.updatedAt, view.createdAt);
    assert.equal(view.lastVerifiedAt, view.createdAt);
    assert.equal(view.lastError, null);
    assert.equal(storage.upserts, 1);

    const row = storage.getServiceCredential(view.id)!;
    assert.notEqual(row.secret_ciphertext, VALID_TOKEN);
    assert.equal(ctx.secrets.decrypt(String(row.secret_ciphertext)), VALID_TOKEN);
    // list/inline 视图永远不包含明文
    assert.ok(!JSON.stringify(list(ctx)).includes(VALID_TOKEN));
    assert.equal(list(ctx).length, 1);
  });

  it("save 校验失败时不落库，错误文案对齐 Rust", async () => {
    const mock = await startMock();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    await assert.rejects(
      () => save(ctx, inputFor(mock, { token: "glpat-wrong-token" }) as never, false),
      (error: Error) => {
        assert.match(error.message, /^校验失败，未保存：GitLab API 401: 401 Unauthorized（token 无效或已过期/);
        return true;
      },
    );
    assert.equal(storage.upserts, 0);
    assert.equal(storage.listServiceCredentials().length, 0);
  });

  it("save 入参校验：名称/服务类型/地址/新建缺 token", async () => {
    const mock = await startMock();
    const ctx = makeCtx(new FakeCredentialStorage());
    await assert.rejects(() => save(ctx, inputFor(mock, { name: "  " }) as never, false), /凭据名称不能为空/);
    await assert.rejects(
      () => save(ctx, inputFor(mock, { name: "x".repeat(65) }) as never, false),
      /凭据名称不能超过 64 个字符/,
    );
    await assert.rejects(
      () => save(ctx, inputFor(mock, { provider: "github" }) as never, false),
      /暂不支持的服务类型：github（当前支持 gitlab、dockhand、jenkins、uptime-kuma、beszel、registry）/,
    );
    await assert.rejects(
      () => save(ctx, inputFor(mock, { baseUrl: "ftp://example.com" }) as never, false),
      /GitLab 地址必须是 http 或 https/,
    );
    await assert.rejects(
      () => save(ctx, inputFor(mock, { token: "" }) as never, false),
      /新建凭据时必须填写 token/,
    );
    await assert.rejects(
      () => save(ctx, { ...inputFor(mock), id: "missing-id" } as never, false),
      /凭据不存在：missing-id/,
    );
  });

  it("编辑时空 token 保留原值，created_at 不变、token 不变", async () => {
    const mock = await startMock();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const created = await save(ctx, inputFor(mock) as never, false);
    const createdRow = storage.getServiceCredential(created.id)!;
    const originalCiphertext = String(createdRow.secret_ciphertext);
    mock.privateTokens = [];

    const edited = await save(
      ctx,
      inputFor(mock, { id: created.id, name: "改名了", token: "" }) as never,
      false,
    );
    assert.equal(edited.id, created.id);
    assert.equal(edited.name, "改名了");
    assert.equal(edited.createdAt, created.createdAt);
    assert.equal(storage.getServiceCredential(created.id)!.created_at, created.createdAt);
    assert.equal(mock.privateTokens.at(-1), VALID_TOKEN);
    // 重新加密产生新密文，但明文仍是原 token
    const editedRow = storage.getServiceCredential(created.id)!;
    assert.notEqual(String(editedRow.secret_ciphertext), originalCiphertext);
    assert.equal(ctx.secrets.decrypt(String(editedRow.secret_ciphertext)), VALID_TOKEN);
  });

  it("编辑时可显式替换 token，并更新 lastVerifiedAt", async () => {
    const mock = await startMock();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const created = await save(ctx, inputFor(mock) as never, false);
    mock.privateTokens = [];
    const updated = await save(
      ctx,
      inputFor(mock, { id: created.id, token: VALID_TOKEN }) as never,
      false,
    );
    assert.equal(mock.privateTokens.at(-1), VALID_TOKEN);
    assert.equal(updated.secretHint, "••••1a2b");
    assert.ok(!JSON.stringify(updated).includes(VALID_TOKEN));
  });

  it("test：成功后写 lastVerifiedAt 且清 lastError", async () => {
    const mock = await startMock();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const created = await save(ctx, inputFor(mock) as never, false);
    storage.getServiceCredential(created.id)!.last_error = "旧错误";

    const check = await testCredential(ctx, created.id, false);
    assert.deepEqual(check, {
      ok: true,
      username: "alice",
      version: "10.8.7",
      detail: null,
      error: null,
    });
    const row = storage.getServiceCredential(created.id)!;
    assert.equal(row.last_error, null);
    assert.equal(typeof row.last_verified_at, "string");
  });

  it("test：失败写 lastError 且保留上一次验证时间", async () => {
    const mock = await startMock();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const created = await save(ctx, inputFor(mock) as never, false);
    const row = storage.getServiceCredential(created.id)!;
    const previousVerified = "2026-01-01T00:00:00Z";
    row.last_verified_at = previousVerified;
    row.secret_ciphertext = ctx.secrets.encrypt("glpat-wrong-token");

    const check = await testCredential(ctx, created.id, false);
    assert.equal(check.ok, false);
    assert.match(String(check.error), /^GitLab API 401: /);
    const after = storage.getServiceCredential(created.id)!;
    assert.equal(after.last_verified_at, previousVerified);
    assert.match(String(after.last_error), /token 无效或已过期/);
  });

  it("test：凭据不存在 / 密文无法解密 / 非 gitlab provider", async () => {
    const mock = await startMock();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    await assert.rejects(() => testCredential(ctx, "nope", false), /凭据不存在：nope/);

    storage.upsertServiceCredential({
      id: "broken",
      name: "broken",
      provider: "gitlab",
      base_url: `${mock.baseUrl}/gitlab`,
      secret_ciphertext: "bogus",
      secret_hint: "••••",
      kind: "cli_token",
      note: null,
      enabled: true,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      last_verified_at: null,
      last_error: null,
    });
    await assert.rejects(() => testCredential(ctx, "broken", false), /凭据无法解密：/);

    storage.upsertServiceCredential({
      id: "github-row",
      name: "gh",
      provider: "github",
      base_url: "https://github.com",
      secret_ciphertext: ctx.secrets.encrypt("x"),
      secret_hint: "••••",
      kind: "cli_token",
      note: null,
      enabled: true,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      last_verified_at: null,
      last_error: null,
    });
    await assert.rejects(() => testCredential(ctx, "github-row", false), /暂不支持测试该服务类型：github/);
  });

  it("delete：存在删除成功、不存在报错", async () => {
    const mock = await startMock();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const created = await save(ctx, inputFor(mock) as never, false);
    assert.equal(deleteCredential(ctx, created.id), null);
    assert.equal(storage.listServiceCredentials().length, 0);
    assert.throws(() => deleteCredential(ctx, created.id), /凭据不存在：/);
  });

  it("export：仅 enabled 返回明文，envKeys 映射 GITLAB_URL/GITLAB_TOKEN", async () => {
    const mock = await startMock();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const enabled = await save(ctx, inputFor(mock) as never, false);
    await save(
      ctx,
      inputFor(mock, { name: "disabled-cred", enabled: false }) as never,
      false,
    );
    const exported = exportCredentials(ctx);
    assert.equal(exported.length, 1);
    assert.deepEqual(exported[0], {
      name: enabled.name,
      provider: "gitlab",
      baseUrl: enabled.baseUrl,
      username: null,
      envPrefix: "GITLAB",
      token: VALID_TOKEN,
    });
    assert.deepEqual(envKeys(exported[0]!), [
      ["GITLAB_URL", enabled.baseUrl, "service"],
      ["GITLAB_TOKEN", VALID_TOKEN, "cli_token"],
    ]);
    // 多实例：前缀不同 → 生成不同环境变量名。
    assert.deepEqual(envKeys({ ...exported[0]!, envPrefix: "GITLAB_NA" }), [
      ["GITLAB_NA_URL", enabled.baseUrl, "service"],
      ["GITLAB_NA_TOKEN", VALID_TOKEN, "cli_token"],
    ]);
    // 旧服务端的导出没有 envPrefix → 回退 provider 默认；未登记 provider 不导出。
    assert.deepEqual(envKeys({ ...exported[0]!, envPrefix: "" }), [
      ["GITLAB_URL", enabled.baseUrl, "service"],
      ["GITLAB_TOKEN", VALID_TOKEN, "cli_token"],
    ]);
    assert.deepEqual(envKeys({ ...exported[0]!, provider: "github" }), []);
  });

  it("list 返回 camelCase 视图且永不包含明文/密文", async () => {
    const mock = await startMock();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const created = await save(ctx, inputFor(mock) as never, false);
    const items = list(ctx);
    assert.equal(items.length, 1);
    const row = storage.getServiceCredential(created.id)!;
    const text = JSON.stringify(items);
    assert.ok(!text.includes(VALID_TOKEN));
    assert.ok(!text.includes(String(row.secret_ciphertext)));
    assert.deepEqual(Object.keys(items[0]!).sort(), [
      "baseUrl",
      "createdAt",
      "enabled",
      "envPrefix",
      "id",
      "kind",
      "lastError",
      "lastVerifiedAt",
      "name",
      "note",
      "provider",
      "secretHint",
      "updatedAt",
      "username",
    ]);
    // 校验时间戳为秒级 RFC3339（无毫秒）
    assert.ok(!String(items[0]!.createdAt).includes("."));
  });

  it("解密失败（密钥更换）时 list 仍可用，export 报错", async () => {
    const mock = await startMock();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    await save(ctx, inputFor(mock) as never, false);
    const brokenCtx = makeCtx(storage, {
      encrypt: () => "v1:broken",
      decrypt: () => {
        throw new Error("凭据解密失败（密钥可能已更换）");
      },
    });
    assert.equal(list(brokenCtx).length, 1);
    assert.throws(
      () => exportCredentials(brokenCtx),
      /凭据 GitLab 主实例 无法解密：凭据解密失败（密钥可能已更换）/,
    );
  });
});
// ─── Dockhand provider（与 Rust `check_dockhand` / save/test 分发对齐） ─────

function dockhandInputFor(mock: MockDockhand, overrides: Partial<JsonRow> = {}): JsonRow {
  return {
    name: "Dockhand 面板",
    provider: "dockhand",
    baseUrl: `${mock.baseUrl}${mock.subpath}`,
    token: DOCKHAND_TOKEN,
    ...overrides,
  };
}

describe("Dockhand 凭据", () => {
  it("checkDockhand：成功时 username/version 为 null、detail 为环境数量；401 返回 Display 文案", async () => {
    const mock = await startMockDockhand();
    const ok = await checkDockhand(`${mock.baseUrl}${mock.subpath}`, DOCKHAND_TOKEN, false);
    assert.deepEqual(ok, {
      ok: true,
      username: null,
      version: null,
      detail: "2 个环境",
      error: null,
    });
    assert.equal(mock.requests[0]!.path, "/dockhand/api/environments");
    assert.equal(mock.authorizations[0], `Bearer ${DOCKHAND_TOKEN}`);

    const denied = await checkDockhand(`${mock.baseUrl}${mock.subpath}`, "wrong-token", false);
    assert.equal(denied.ok, false);
    assert.equal(denied.detail, null);
    assert.equal(
      denied.error,
      "Dockhand API 401: Unauthorized（token 无效或已过期，请到 Dockhand 生成新的 API Token）",
    );

    // 地址非法时也返回结构化错误，不抛异常。
    const invalid = await checkDockhand("ftp://host:3000", DOCKHAND_TOKEN, false);
    assert.equal(invalid.ok, false);
    assert.match(String(invalid.error), /Dockhand 地址必须是 http 或 https/);
  });

  it("save(dockhand)：先校验后落库，返回掩码视图且落库为密文", async () => {
    const mock = await startMockDockhand();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const view = await save(ctx, dockhandInputFor(mock) as never, false);
    assert.equal(view.provider, "dockhand");
    assert.equal(view.baseUrl, `${mock.baseUrl}${mock.subpath}`);
    assert.equal(view.kind, "cli_token");
    assert.equal(view.secretHint, "••••9x8y");
    assert.equal(view.lastError, null);
    assert.equal(storage.upserts, 1);
    // 只有校验通过后才写库：请求确实打过 /environments。
    assert.ok(mock.requests.some((item) => item.path === "/dockhand/api/environments"));

    const row = storage.getServiceCredential(view.id)!;
    assert.notEqual(row.secret_ciphertext, DOCKHAND_TOKEN);
    assert.equal(ctx.secrets.decrypt(String(row.secret_ciphertext)), DOCKHAND_TOKEN);
    assert.ok(!JSON.stringify(list(ctx)).includes(DOCKHAND_TOKEN));
  });

  it("save(dockhand) 校验失败时不落库，错误文案对齐 Rust", async () => {
    const mock = await startMockDockhand();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    await assert.rejects(
      () => save(ctx, dockhandInputFor(mock, { token: "wrong-token" }) as never, false),
      (error: Error) => {
        assert.match(error.message, /^校验失败，未保存：Dockhand API 401: Unauthorized（token 无效或已过期/);
        return true;
      },
    );
    assert.equal(storage.upserts, 0);
    assert.equal(storage.listServiceCredentials().length, 0);
  });

  it("编辑 dockhand 凭据时空 token 保留原值并重新校验", async () => {
    const mock = await startMockDockhand();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const created = await save(ctx, dockhandInputFor(mock) as never, false);
    const original = storage.getServiceCredential(created.id)!;
    const originalCiphertext = String(original.secret_ciphertext);
    mock.authorizations = [];

    const edited = await save(
      ctx,
      dockhandInputFor(mock, { id: created.id, name: "改名了", token: "" }) as never,
      false,
    );
    assert.equal(edited.id, created.id);
    assert.equal(edited.name, "改名了");
    assert.equal(edited.createdAt, created.createdAt);
    assert.equal(mock.authorizations.at(-1), `Bearer ${DOCKHAND_TOKEN}`);
    const editedRow = storage.getServiceCredential(created.id)!;
    assert.notEqual(String(editedRow.secret_ciphertext), originalCiphertext);
    assert.equal(ctx.secrets.decrypt(String(editedRow.secret_ciphertext)), DOCKHAND_TOKEN);
  });

  it("test(dockhand)：成功写 lastVerifiedAt/detail；失败写 lastError 且保留上一验证时间", async () => {
    const mock = await startMockDockhand();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const created = await save(ctx, dockhandInputFor(mock) as never, false);
    storage.getServiceCredential(created.id)!.last_error = "旧错误";

    const check = await testCredential(ctx, created.id, false);
    assert.deepEqual(check, {
      ok: true,
      username: null,
      version: null,
      detail: "2 个环境",
      error: null,
    });
    const row = storage.getServiceCredential(created.id)!;
    assert.equal(row.last_error, null);
    assert.equal(typeof row.last_verified_at, "string");

    const previousVerified = "2026-01-01T00:00:00Z";
    row.last_verified_at = previousVerified;
    row.secret_ciphertext = ctx.secrets.encrypt("wrong-token");
    const failed = await testCredential(ctx, created.id, false);
    assert.equal(failed.ok, false);
    assert.equal(failed.detail, null);
    assert.match(String(failed.error), /^Dockhand API 401: /);
    const after = storage.getServiceCredential(created.id)!;
    assert.equal(after.last_verified_at, previousVerified);
    assert.match(String(after.last_error), /token 无效或已过期/);
  });

  it("envKeys：Dockhand 映射 DOCKHAND_URL/DOCKHAND_TOKEN（URL 先、TOKEN 后）", () => {
    assert.deepEqual(
      envKeys({
        name: "面板",
        provider: "dockhand",
        baseUrl: "http://host:3000",
        username: null,
        envPrefix: "DOCKHAND",
        token: DOCKHAND_TOKEN,
      }),
      [
        ["DOCKHAND_URL", "http://host:3000", "service"],
        ["DOCKHAND_TOKEN", DOCKHAND_TOKEN, "cli_token"],
      ],
    );
  });

  it("save 按 provider 选择 URL 归一文案；未知 provider 文案含两种", async () => {
    const ctx = makeCtx(new FakeCredentialStorage());
    await assert.rejects(
      () => save(ctx, { name: "x", provider: "dockhand", baseUrl: "ftp://host:3000", token: "t" } as never, false),
      /Dockhand 地址必须是 http 或 https/,
    );
    await assert.rejects(
      () => save(ctx, { name: "x", provider: "gitlab", baseUrl: "ftp://host:3000", token: "t" } as never, false),
      /GitLab 地址必须是 http 或 https/,
    );
    await assert.rejects(
      () => save(ctx, { name: "x", provider: "beszel", baseUrl: "ftp://host:8090", token: "t" } as never, false),
      /Beszel 地址必须是 http 或 https/,
    );
    await assert.rejects(
      () => save(ctx, { name: "x", provider: "github", baseUrl: "http://host", token: "t" } as never, false),
      /暂不支持的服务类型：github（当前支持 gitlab、dockhand、jenkins、uptime-kuma、beszel、registry）/,
    );
  });
});

// ─── Jenkins provider（与 Rust `check_jenkins` / save/test 分发对齐） ──────

function jenkinsInputFor(mock: MockJenkins, overrides: Partial<JsonRow> = {}): JsonRow {
  return {
    name: "Jenkins 主实例",
    provider: "jenkins",
    baseUrl: `${mock.baseUrl}${mock.subpath}`,
    username: JENKINS_USERNAME,
    token: JENKINS_TOKEN,
    ...overrides,
  };
}

function jenkinsAuthorization(username: string, token: string): string {
  return `Basic ${Buffer.from(`${username}:${token}`, "utf8").toString("base64")}`;
}

describe("Jenkins 凭据", () => {
  it("checkJenkins：成功返回 username/version 与 Basic 头；401/地址非法返回结构化错误", async () => {
    const mock = await startMockJenkins();
    const ok = await checkJenkins(
      `${mock.baseUrl}${mock.subpath}`,
      JENKINS_USERNAME,
      JENKINS_TOKEN,
      false,
    );
    assert.deepEqual(ok, {
      ok: true,
      username: "CI Bot",
      version: "2.452.1",
      detail: null,
      error: null,
    });
    assert.equal(mock.requests[0]!.path, "/jenkins/me/api/json");
    assert.equal(mock.authorizations[0], jenkinsAuthorization(JENKINS_USERNAME, JENKINS_TOKEN));

    const denied = await checkJenkins(
      `${mock.baseUrl}${mock.subpath}`,
      JENKINS_USERNAME,
      "wrong-token",
      false,
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.username, null);
    assert.equal(denied.version, null);
    assert.equal(
      denied.error,
      "Jenkins API 401: Unauthorized（用户名或 API Token 无效，请到 Jenkins 用户设置页确认 API Token）",
    );

    // 地址非法/用户名为空时也返回结构化错误，不抛异常。
    const invalid = await checkJenkins("ftp://host", JENKINS_USERNAME, JENKINS_TOKEN, false);
    assert.equal(invalid.ok, false);
    assert.match(String(invalid.error), /Jenkins 地址必须是 http 或 https/);
    const missingUser = await checkJenkins(`${mock.baseUrl}${mock.subpath}`, "  ", JENKINS_TOKEN, false);
    assert.equal(missingUser.ok, false);
    assert.equal(missingUser.error, "Jenkins 用户名不能为空");
  });

  it("save(jenkins)：username 明文落库并回显，token 仍加密", async () => {
    const mock = await startMockJenkins();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const view = await save(ctx, jenkinsInputFor(mock) as never, false);
    assert.equal(view.provider, "jenkins");
    assert.equal(view.username, JENKINS_USERNAME);
    assert.equal(view.envPrefix, "JENKINS");
    assert.equal(view.secretHint, "••••9q8w");
    assert.equal(view.lastError, null);
    assert.equal(storage.upserts, 1);
    // 只有校验通过后才写库：请求确实打过 /me/api/json（Basic 认证）。
    assert.equal(mock.requests.at(-1)!.path, "/jenkins/me/api/json");
    assert.equal(mock.authorizations.at(-1), jenkinsAuthorization(JENKINS_USERNAME, JENKINS_TOKEN));

    const row = storage.getServiceCredential(view.id)!;
    assert.equal(row.username, JENKINS_USERNAME);
    assert.notEqual(row.secret_ciphertext, JENKINS_TOKEN);
    assert.equal(ctx.secrets.decrypt(String(row.secret_ciphertext)), JENKINS_TOKEN);
    // 列表视图只给 username（明文）与 token 掩码，不含 token 明文。
    const listed = list(ctx)[0]!;
    assert.equal(listed.username, JENKINS_USERNAME);
    assert.ok(!JSON.stringify(listed).includes(JENKINS_TOKEN));
    // 导出（pull 用）带 username。
    const exported = exportCredentials(ctx);
    assert.equal(exported.length, 1);
    assert.equal(exported[0]!.username, JENKINS_USERNAME);
  });

  it("save(jenkins)：username 必填/长度/冒号空格控制字符校验，失败不落库", async () => {
    const mock = await startMockJenkins();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    await assert.rejects(
      () => save(ctx, jenkinsInputFor(mock, { username: undefined }) as never, false),
      /Jenkins 需要填写用户名（API Token 必须与用户名一起认证）/,
    );
    await assert.rejects(
      () => save(ctx, jenkinsInputFor(mock, { username: "   " }) as never, false),
      /Jenkins 需要填写用户名（API Token 必须与用户名一起认证）/,
    );
    await assert.rejects(
      () => save(ctx, jenkinsInputFor(mock, { username: "a".repeat(65) }) as never, false),
      /Jenkins 用户名不能超过 64 个字符/,
    );
    for (const bad of ["al ice", "al:ice", "al\u0001ice"]) {
      await assert.rejects(
        () => save(ctx, jenkinsInputFor(mock, { username: bad }) as never, false),
        /Jenkins 用户名不能包含冒号、空格或控制字符/,
      );
    }
    assert.equal(storage.upserts, 0);
    assert.equal(storage.listServiceCredentials().length, 0);
  });

  it("save(jenkins)：编辑时空 username 保留原值；显式传值更新；非 jenkins 忽略 username", async () => {
    const mock = await startMockJenkins();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const created = await save(ctx, jenkinsInputFor(mock) as never, false);

    const kept = await save(
      ctx,
      jenkinsInputFor(mock, { id: created.id, name: "改名了", username: "" }) as never,
      false,
    );
    assert.equal(kept.id, created.id);
    assert.equal(kept.username, JENKINS_USERNAME);
    assert.equal(storage.getServiceCredential(created.id)!.username, JENKINS_USERNAME);

    const updated = await save(
      ctx,
      jenkinsInputFor(mock, { id: created.id, username: "  ci-bot-2  " }) as never,
      false,
    );
    assert.equal(updated.username, "ci-bot-2");
    assert.equal(storage.getServiceCredential(created.id)!.username, "ci-bot-2");

    // 非 jenkins：入参 username 被忽略，落库 NULL。
    const gitlab = await startMock();
    const ignored = await save(
      ctx,
      inputFor(gitlab, { username: "should-be-ignored" }) as never,
      false,
    );
    assert.equal(ignored.username, null);
    assert.equal(storage.getServiceCredential(ignored.id)!.username ?? null, null);
  });

  it("test(jenkins)：成功写 lastVerifiedAt（username/version）；失败写 lastError", async () => {
    const mock = await startMockJenkins();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const created = await save(ctx, jenkinsInputFor(mock) as never, false);
    storage.getServiceCredential(created.id)!.last_error = "旧错误";

    const check = await testCredential(ctx, created.id, false);
    assert.deepEqual(check, {
      ok: true,
      username: "CI Bot",
      version: "2.452.1",
      detail: null,
      error: null,
    });
    const row = storage.getServiceCredential(created.id)!;
    assert.equal(row.last_error, null);
    assert.equal(typeof row.last_verified_at, "string");

    const previousVerified = "2026-01-01T00:00:00Z";
    row.last_verified_at = previousVerified;
    row.secret_ciphertext = ctx.secrets.encrypt("wrong-token");
    const failed = await testCredential(ctx, created.id, false);
    assert.equal(failed.ok, false);
    assert.match(String(failed.error), /^Jenkins API 401: /);
    const after = storage.getServiceCredential(created.id)!;
    assert.equal(after.last_verified_at, previousVerified);
    assert.match(String(after.last_error), /用户名或 API Token 无效/);
  });

  it("envKeys：Jenkins 输出 URL/USER/TOKEN（USER 取 username，缺失为空串）", () => {
    assert.deepEqual(
      envKeys({
        name: "Jenkins",
        provider: "jenkins",
        baseUrl: "https://jenkins.example.com",
        username: JENKINS_USERNAME,
        envPrefix: "JENKINS",
        token: JENKINS_TOKEN,
      }),
      [
        ["JENKINS_URL", "https://jenkins.example.com", "service"],
        ["JENKINS_USER", JENKINS_USERNAME, "service"],
        ["JENKINS_TOKEN", JENKINS_TOKEN, "cli_token"],
      ],
    );
    // 多实例/旧导出没有 username：USER 为空串，仍是三把键。
    assert.deepEqual(
      envKeys({
        name: "Jenkins NA",
        provider: "jenkins",
        baseUrl: "https://jenkins-na.example.com",
        username: null,
        envPrefix: "JENKINS_NA",
        token: JENKINS_TOKEN,
      }),
      [
        ["JENKINS_NA_URL", "https://jenkins-na.example.com", "service"],
        ["JENKINS_NA_USER", "", "service"],
        ["JENKINS_NA_TOKEN", JENKINS_TOKEN, "cli_token"],
      ],
    );
  });
});

// ─── Beszel provider（与 Rust `check_beszel` / save/test 分发对齐） ────────

function beszelInputFor(mock: MockBeszel, overrides: Partial<JsonRow> = {}): JsonRow {
  return {
    name: "Beszel 监控 Hub",
    provider: "beszel",
    baseUrl: mock.baseUrl,
    username: BESZEL_EMAIL,
    token: BESZEL_PASSWORD,
    ...overrides,
  };
}

describe("Beszel 凭据", () => {
  it("checkBeszel：auth → info → systems，username 取记录邮箱、detail 为系统数量", async () => {
    const mock = await startMockBeszel();
    const ok = await checkBeszel(mock.baseUrl, BESZEL_EMAIL, BESZEL_PASSWORD, false);
    assert.deepEqual(ok, {
      ok: true,
      username: BESZEL_EMAIL,
      version: "0.21.1",
      detail: "3 台系统",
      error: null,
    });
    // 一次命令只认证一次：auth 用 identity/password，后续请求带 PocketBase 原生 token。
    const authRequests = mock.requests.filter(
      (request) => request.path === "/api/collections/users/auth-with-password",
    );
    assert.equal(authRequests.length, 1);
    assert.deepEqual(JSON.parse(authRequests[0]!.body), {
      identity: BESZEL_EMAIL,
      password: BESZEL_PASSWORD,
    });
    const infoRequest = mock.requests.find((request) => request.path === "/api/beszel/info")!;
    assert.equal(infoRequest.authorization, BESZEL_TOKEN);
    assert.ok(!String(infoRequest.authorization).startsWith("Bearer "));
    assert.equal(infoRequest.userAgent, "flowlet/0.2.0");
    // 校验只需要 totalItems，systems 用 perPage=1。
    const systemsRequest = mock.requests.find((request) =>
      request.path.startsWith("/api/collections/systems/records"),
    )!;
    assert.equal(
      new URL(systemsRequest.path, "http://localhost").searchParams.get("perPage"),
      "1",
    );

    // 服务端记录没有 email 时回退入参邮箱。
    const noEmail = await startMockBeszel();
    noEmail.recordEmail = "";
    const fallback = await checkBeszel(noEmail.baseUrl, BESZEL_EMAIL, BESZEL_PASSWORD, false);
    assert.equal(fallback.username, BESZEL_EMAIL);
  });

  it("checkBeszel：info 失败不致命（version 为 null），auth/systems 失败即失败", async () => {
    const degraded = await startMockBeszel();
    degraded.version = null;
    const ok = await checkBeszel(degraded.baseUrl, BESZEL_EMAIL, BESZEL_PASSWORD, false);
    assert.deepEqual(ok, {
      ok: true,
      username: BESZEL_EMAIL,
      version: null,
      detail: "3 台系统",
      error: null,
    });

    const denied = await startMockBeszel();
    const badAuth = await checkBeszel(denied.baseUrl, BESZEL_EMAIL, "wrong-password", false);
    assert.equal(badAuth.ok, false);
    assert.equal(badAuth.username, null);
    assert.equal(badAuth.version, null);
    assert.equal(badAuth.detail, null);
    assert.equal(
      badAuth.error,
      "Beszel API 400: Failed to authenticate.（邮箱或密码错误，请确认是 Beszel 用户账号（不是 PocketBase 超级管理员））",
    );

    const broken = await startMockBeszel();
    broken.systemsStatus = 500;
    const badSystems = await checkBeszel(broken.baseUrl, BESZEL_EMAIL, BESZEL_PASSWORD, false);
    assert.equal(badSystems.ok, false);
    assert.equal(
      badSystems.error,
      "Beszel API 500: systems-boom（请检查邮箱、密码、实例地址与网络连通性）",
    );

    // 地址非法/邮箱为空时也返回结构化错误，不抛异常。
    const invalid = await checkBeszel("ftp://host", BESZEL_EMAIL, BESZEL_PASSWORD, false);
    assert.equal(invalid.ok, false);
    assert.match(String(invalid.error), /Beszel 地址必须是 http 或 https/);
    const missingEmail = await checkBeszel(broken.baseUrl, "  ", BESZEL_PASSWORD, false);
    assert.equal(missingEmail.ok, false);
    assert.equal(missingEmail.error, "Beszel 邮箱不能为空");
  });

  it("save(beszel)：邮箱明文落库、密码加密；地址归一剥 /api 与 /_/", async () => {
    const mock = await startMockBeszel();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const view = await save(
      ctx,
      beszelInputFor(mock, { baseUrl: `${mock.baseUrl}/api/` }) as never,
      false,
    );
    assert.equal(view.provider, "beszel");
    assert.equal(view.baseUrl, mock.baseUrl);
    assert.equal(view.username, BESZEL_EMAIL);
    assert.equal(view.envPrefix, "BESZEL");
    assert.equal(view.secretHint, "••••9k7j");
    assert.equal(view.lastError, null);
    assert.equal(storage.upserts, 1);
    // 只有校验通过后才写库。
    assert.ok(
      mock.requests.some((request) => request.path === "/api/collections/users/auth-with-password"),
    );

    const row = storage.getServiceCredential(view.id)!;
    assert.equal(row.username, BESZEL_EMAIL);
    assert.equal(row.env_prefix, "BESZEL");
    assert.notEqual(row.secret_ciphertext, BESZEL_PASSWORD);
    assert.equal(ctx.secrets.decrypt(String(row.secret_ciphertext)), BESZEL_PASSWORD);
    // 列表/导出带邮箱，但不含密码明文。
    const listed = list(ctx)[0]!;
    assert.equal(listed.username, BESZEL_EMAIL);
    assert.ok(!JSON.stringify(listed).includes(BESZEL_PASSWORD));
    const exported = exportCredentials(ctx);
    assert.equal(exported.length, 1);
    assert.equal(exported[0]!.username, BESZEL_EMAIL);
    assert.equal(exported[0]!.token, BESZEL_PASSWORD);

    // PocketBase 管理面板地址后缀也要剥掉。
    const second = await save(
      ctx,
      beszelInputFor(mock, {
        name: "Beszel 面板地址",
        baseUrl: `${mock.baseUrl}/_/`,
        envPrefix: "BESZEL_PANEL",
      }) as never,
      false,
    );
    assert.equal(second.baseUrl, mock.baseUrl);
  });

  it("save(beszel)：邮箱必填/长度/基本 @ 校验，失败不落库也不发请求", async () => {
    const mock = await startMockBeszel();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    await assert.rejects(
      () => save(ctx, beszelInputFor(mock, { username: undefined }) as never, false),
      /Beszel 需要填写邮箱（Beszel 用邮箱 \+ 密码登录）/,
    );
    await assert.rejects(
      () => save(ctx, beszelInputFor(mock, { username: "   " }) as never, false),
      /Beszel 需要填写邮箱（Beszel 用邮箱 \+ 密码登录）/,
    );
    await assert.rejects(
      () => save(ctx, beszelInputFor(mock, { username: `${"a".repeat(250)}@example.com` }) as never, false),
      /Beszel 邮箱不能超过 254 个字符/,
    );
    for (const bad of ["no-at-sign", "@example.com", "you@", "a@b@c.com"]) {
      await assert.rejects(
        () => save(ctx, beszelInputFor(mock, { username: bad }) as never, false),
        /Beszel 邮箱格式不正确/,
      );
    }
    assert.equal(storage.upserts, 0);
    assert.equal(storage.listServiceCredentials().length, 0);
    // 校验在发网络请求之前完成。
    assert.equal(mock.requests.length, 0);
  });

  it("save(beszel)：编辑时空 username 保留原邮箱；显式传值更新", async () => {
    const mock = await startMockBeszel();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const created = await save(ctx, beszelInputFor(mock) as never, false);

    const kept = await save(
      ctx,
      beszelInputFor(mock, {
        id: created.id,
        name: "改名的 Hub",
        username: "",
        token: "",
      }) as never,
      false,
    );
    assert.equal(kept.id, created.id);
    assert.equal(kept.username, BESZEL_EMAIL);
    assert.equal(storage.getServiceCredential(created.id)!.username, BESZEL_EMAIL);
    // 空 token 也保留原密码（解密后重新认证仍成功）。
    assert.equal(ctx.secrets.decrypt(String(storage.getServiceCredential(created.id)!.secret_ciphertext)), BESZEL_PASSWORD);

    const updated = await save(
      ctx,
      beszelInputFor(mock, { id: created.id, username: "  other@example.com  " }) as never,
      false,
    );
    assert.equal(updated.username, "other@example.com");
    assert.equal(storage.getServiceCredential(created.id)!.username, "other@example.com");
  });

  it("test(beszel)：成功写 lastVerifiedAt（邮箱/版本/系统数）；失败写 lastError", async () => {
    const mock = await startMockBeszel();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const created = await save(ctx, beszelInputFor(mock) as never, false);
    storage.getServiceCredential(created.id)!.last_error = "旧错误";

    const check = await testCredential(ctx, created.id, false);
    assert.deepEqual(check, {
      ok: true,
      username: BESZEL_EMAIL,
      version: "0.21.1",
      detail: "3 台系统",
      error: null,
    });
    const row = storage.getServiceCredential(created.id)!;
    assert.equal(row.last_error, null);
    assert.equal(typeof row.last_verified_at, "string");

    const previousVerified = "2026-01-01T00:00:00Z";
    row.last_verified_at = previousVerified;
    row.secret_ciphertext = ctx.secrets.encrypt("wrong-password");
    const failed = await testCredential(ctx, created.id, false);
    assert.equal(failed.ok, false);
    assert.match(String(failed.error), /^Beszel API 400: /);
    const after = storage.getServiceCredential(created.id)!;
    assert.equal(after.last_verified_at, previousVerified);
    assert.match(String(after.last_error), /邮箱或密码错误/);
  });

  it("envKeys：Beszel 输出 URL/EMAIL/PASSWORD（EMAIL 取 username，缺失为空串）", () => {
    assert.deepEqual(
      envKeys({
        name: "Beszel",
        provider: "beszel",
        baseUrl: "http://beszel.example.com:8090",
        username: BESZEL_EMAIL,
        envPrefix: "BESZEL",
        token: BESZEL_PASSWORD,
      }),
      [
        ["BESZEL_URL", "http://beszel.example.com:8090", "service"],
        ["BESZEL_EMAIL", BESZEL_EMAIL, "service"],
        ["BESZEL_PASSWORD", BESZEL_PASSWORD, "cli_token"],
      ],
    );
    // 多实例/旧服务端 export 没有 username：EMAIL 为空串，仍是三把键。
    assert.deepEqual(
      envKeys({
        name: "Beszel 北美",
        provider: "beszel",
        baseUrl: "http://beszel-na.example.com:8090",
        username: null,
        envPrefix: "BESZEL_NA",
        token: BESZEL_PASSWORD,
      }),
      [
        ["BESZEL_NA_URL", "http://beszel-na.example.com:8090", "service"],
        ["BESZEL_NA_EMAIL", "", "service"],
        ["BESZEL_NA_PASSWORD", BESZEL_PASSWORD, "cli_token"],
      ],
    );
  });
});

// ─── Registry provider（OCI 镜像仓库；与 Rust `check_registry` / save/test 分发对齐） ──

function registryInputFor(mock: MockRegistry, overrides: Partial<JsonRow> = {}): JsonRow {
  return {
    name: "OCI 镜像仓库",
    provider: "registry",
    baseUrl: mock.baseUrl,
    username: REGISTRY_USERNAME,
    token: REGISTRY_PASSWORD,
    ...overrides,
  };
}

describe("Registry 凭据", () => {
  it("元数据：provider 追加在 beszel 之后、supported、默认前缀 REGISTRY", () => {
    assert.deepEqual(
      providers().map((item) => item.id),
      ["gitlab", "dockhand", "jenkins", "uptime-kuma", "beszel", "registry"],
    );
    assert.equal(isSupportedProvider("registry"), true);
    assert.equal(isSupportedProvider("github"), false);
    assert.equal(defaultEnvPrefix("registry"), "REGISTRY");
  });

  it("save(registry)：/v2/ Basic 200 才落库；地址归一为主机；username 明文、token 加密", async () => {
    const mock = await startMockRegistry();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    // 用户把文档里的 /v2/ 一起粘贴进来也要归一成 origin。
    const view = await save(
      ctx,
      registryInputFor(mock, { baseUrl: `${mock.baseUrl}/v2/` }) as never,
      false,
    );
    assert.equal(view.provider, "registry");
    assert.equal(view.baseUrl, mock.baseUrl);
    assert.equal(view.username, REGISTRY_USERNAME);
    assert.equal(view.envPrefix, "REGISTRY");
    assert.equal(view.secretHint, "••••4b3c");
    assert.equal(view.lastError, null);
    assert.equal(storage.upserts, 1);
    // 只有校验通过才写库：请求确实打过标准 /v2/（Basic）。
    assert.equal(mock.requests.at(-1)!.path, "/v2/");
    assert.equal(
      mock.requests.at(-1)!.authorization,
      registryBasicAuthorization(REGISTRY_USERNAME, REGISTRY_PASSWORD),
    );

    const row = storage.getServiceCredential(view.id)!;
    assert.equal(row.username, REGISTRY_USERNAME);
    assert.equal(row.env_prefix, "REGISTRY");
    assert.notEqual(row.secret_ciphertext, REGISTRY_PASSWORD);
    assert.equal(ctx.secrets.decrypt(String(row.secret_ciphertext)), REGISTRY_PASSWORD);
    // 列表/导出带 username，但不含密码/token 明文。
    const listed = list(ctx)[0]!;
    assert.equal(listed.username, REGISTRY_USERNAME);
    assert.ok(!JSON.stringify(listed).includes(REGISTRY_PASSWORD));
    const exported = exportCredentials(ctx);
    assert.equal(exported.length, 1);
    assert.equal(exported[0]!.username, REGISTRY_USERNAME);
    assert.equal(exported[0]!.baseUrl, mock.baseUrl);
  });

  it("save(registry)：401 Bearer 质询 → 换 token → Bearer 重试通过后才落库", async () => {
    const mock = await startMockRegistry();
    mock.mode = "bearer";
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const view = await save(ctx, registryInputFor(mock) as never, false);
    assert.equal(view.username, REGISTRY_USERNAME);
    assert.deepEqual(
      mock.requests.map((item) => item.path.split("?")[0]!),
      ["/v2/", "/token", "/v2/"],
    );
    assert.equal(mock.requests.at(-1)!.authorization, `Bearer ${REGISTRY_BEARER_TOKEN}`);
    assert.equal(storage.upserts, 1);
  });

  it("save(registry)：非法 token 不落库，错误文案对齐契约 §4", async () => {
    const mock = await startMockRegistry();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    await assert.rejects(
      () => save(ctx, registryInputFor(mock, { token: "wrong-token" }) as never, false),
      (error: Error) => {
        assert.match(error.message, /^校验失败，未保存：用户名或 token 无效（registry 认证失败）$/);
        return true;
      },
    );
    assert.equal(storage.upserts, 0);
    assert.equal(storage.listServiceCredentials().length, 0);
  });

  it("save(registry)：用户名必填/长度/字符校验，robot account 放行，失败不落库也不发请求", async () => {
    const mock = await startMockRegistry();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    await assert.rejects(
      () => save(ctx, registryInputFor(mock, { username: undefined }) as never, false),
      /镜像仓库需要填写用户名（docker login 需要用户名 \+ 密码\/token）/,
    );
    await assert.rejects(
      () => save(ctx, registryInputFor(mock, { username: "   " }) as never, false),
      /镜像仓库需要填写用户名（docker login 需要用户名 \+ 密码\/token）/,
    );
    await assert.rejects(
      () => save(ctx, registryInputFor(mock, { username: "a".repeat(256) }) as never, false),
      /用户名不能超过 255 个字符/,
    );
    for (const bad of ["al:ice", "al ice", "al\u0001ice"]) {
      await assert.rejects(
        () => save(ctx, registryInputFor(mock, { username: bad }) as never, false),
        /用户名不能包含冒号、空格或控制字符/,
      );
    }
    assert.equal(storage.upserts, 0);
    assert.equal(mock.requests.length, 0, "用户名规则属于配置错误，不该先发网络请求");
    // Harbor robot account 字符 `$`/`+`/`_`/`-` 必须放行。
    const saved = await save(
      ctx,
      registryInputFor(mock, { username: "  robot$proj+name_pull-1  " }) as never,
      false,
    );
    assert.equal(saved.username, "robot$proj+name_pull-1");
  });

  it("save(registry)：编辑时空 username 保留原值，显式传值更新", async () => {
    const mock = await startMockRegistry();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const created = await save(ctx, registryInputFor(mock) as never, false);

    const kept = await save(
      ctx,
      registryInputFor(mock, { id: created.id, name: "改名了", username: "", token: "" }) as never,
      false,
    );
    assert.equal(kept.id, created.id);
    assert.equal(kept.username, REGISTRY_USERNAME);
    assert.equal(storage.getServiceCredential(created.id)!.username, REGISTRY_USERNAME);
    // 空 token 保留原密码（解密后重新认证仍通过）。
    assert.equal(
      ctx.secrets.decrypt(String(storage.getServiceCredential(created.id)!.secret_ciphertext)),
      REGISTRY_PASSWORD,
    );

    const updated = await save(
      ctx,
      registryInputFor(mock, { id: created.id, username: "  robot$other+pull  " }) as never,
      false,
    );
    assert.equal(updated.username, "robot$other+pull");
    assert.equal(storage.getServiceCredential(created.id)!.username, "robot$other+pull");
  });

  it("test(registry)：成功写 lastVerifiedAt/version；失败写 lastError 且保留上次验证时间", async () => {
    const mock = await startMockRegistry();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const created = await save(ctx, registryInputFor(mock) as never, false);
    storage.getServiceCredential(created.id)!.last_error = "旧错误";

    const check = await testCredential(ctx, created.id, false);
    assert.deepEqual(check, {
      ok: true,
      username: REGISTRY_USERNAME,
      version: "registry/2.0",
      detail: null,
      error: null,
    });
    const row = storage.getServiceCredential(created.id)!;
    assert.equal(row.last_error, null);
    assert.equal(typeof row.last_verified_at, "string");

    const previousVerified = "2026-01-01T00:00:00Z";
    row.last_verified_at = previousVerified;
    row.secret_ciphertext = ctx.secrets.encrypt("wrong-token");
    const failed = await testCredential(ctx, created.id, false);
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "用户名或 token 无效（registry 认证失败）");
    const after = storage.getServiceCredential(created.id)!;
    assert.equal(after.last_verified_at, previousVerified);
    assert.match(String(after.last_error), /用户名或 token 无效（registry 认证失败）/);
  });

  it("envKeys：三把键 HOST/USER/TOKEN（HOST 去 scheme、带端口；username 缺失写空串）", () => {
    // 默认前缀 REGISTRY：地址键是 `_HOST`（避免 REGISTRY_REGISTRY）。
    assert.deepEqual(
      envKeys({
        name: "镜像仓库",
        provider: "registry",
        baseUrl: "https://hub.17usoft.com",
        username: REGISTRY_USERNAME,
        envPrefix: "REGISTRY",
        token: REGISTRY_PASSWORD,
      }),
      [
        ["REGISTRY_HOST", "hub.17usoft.com", "service"],
        ["REGISTRY_USER", REGISTRY_USERNAME, "service"],
        ["REGISTRY_TOKEN", REGISTRY_PASSWORD, "cli_token"],
      ],
    );
    // 带端口 + 多实例前缀：`{PREFIX}_<属性>` 公式不变。
    assert.deepEqual(
      envKeys({
        name: "镜像仓库 北美",
        provider: "registry",
        baseUrl: "http://10.1.1.1:5000",
        username: "robot$na+pull",
        envPrefix: "REGISTRY_NA",
        token: REGISTRY_PASSWORD,
      }),
      [
        ["REGISTRY_NA_HOST", "10.1.1.1:5000", "service"],
        ["REGISTRY_NA_USER", "robot$na+pull", "service"],
        ["REGISTRY_NA_TOKEN", REGISTRY_PASSWORD, "cli_token"],
      ],
    );
    // 旧服务端导出没有 username：USER 写空串，仍是三把键。
    assert.deepEqual(
      envKeys({
        name: "旧导出",
        provider: "registry",
        baseUrl: "https://legacy.example.com",
        username: null,
        envPrefix: "REGISTRY",
        token: REGISTRY_PASSWORD,
      }),
      [
        ["REGISTRY_HOST", "legacy.example.com", "service"],
        ["REGISTRY_USER", "", "service"],
        ["REGISTRY_TOKEN", REGISTRY_PASSWORD, "cli_token"],
      ],
    );
    // 旧服务端的导出没有 envPrefix → 回退 REGISTRY 默认。
    assert.deepEqual(
      envKeys({
        name: "旧导出 2",
        provider: "registry",
        baseUrl: "https://legacy.example.com",
        username: null,
        envPrefix: "",
        token: REGISTRY_PASSWORD,
      }),
      [
        ["REGISTRY_HOST", "legacy.example.com", "service"],
        ["REGISTRY_USER", "", "service"],
        ["REGISTRY_TOKEN", REGISTRY_PASSWORD, "cli_token"],
      ],
    );
  });

  it("save(registry)：地址归一文案走 registry 分支", async () => {
    const ctx = makeCtx(new FakeCredentialStorage());
    await assert.rejects(
      () =>
        save(
          ctx,
          { name: "x", provider: "registry", baseUrl: "ftp://hub.example.com", username: "u", token: "t" } as never,
          false,
        ),
      /镜像仓库地址必须是 http 或 https/,
    );
    await assert.rejects(
      () =>
        save(
          ctx,
          { name: "x", provider: "registry", baseUrl: "https://hub.example.com/repo", username: "u", token: "t" } as never,
          false,
        ),
      /镜像仓库地址只能是主机（可带端口），不能包含路径/,
    );
  });
});

// ─── 环境前缀 / 多实例（phase2-spec §1） ────────────────────────────────────

function credentialRow(overrides: JsonRow = {}): JsonRow {
  return {
    id: "row-1",
    name: "默认 GitLab",
    provider: "gitlab",
    base_url: "https://gitlab.example.com",
    secret_ciphertext: "v1:fake",
    secret_hint: "••••a1b2",
    kind: "cli_token",
    note: null,
    enabled: true,
    created_at: "2026-11-10T00:00:00Z",
    updated_at: "2026-11-10T00:00:00Z",
    last_verified_at: null,
    last_error: null,
    env_prefix: null,
    ...overrides,
  };
}

describe("环境前缀 / 多实例", () => {
  it("defaultEnvPrefix / normalizeEnvPrefix：默认/大写/trim/长度/字符规则", () => {
    assert.equal(defaultEnvPrefix("gitlab"), "GITLAB");
    assert.equal(defaultEnvPrefix("dockhand"), "DOCKHAND");
    assert.equal(defaultEnvPrefix("jenkins"), "JENKINS");
    assert.equal(defaultEnvPrefix("uptime-kuma"), "UPTIME_KUMA");
    assert.equal(defaultEnvPrefix("beszel"), "BESZEL");
    assert.equal(defaultEnvPrefix("registry"), "REGISTRY");
    assert.equal(normalizeEnvPrefix("", "gitlab"), "GITLAB");
    assert.equal(normalizeEnvPrefix("   ", "dockhand"), "DOCKHAND");
    assert.equal(normalizeEnvPrefix("", "jenkins"), "JENKINS");
    assert.equal(normalizeEnvPrefix(null, "gitlab"), "GITLAB");
    assert.equal(normalizeEnvPrefix(undefined, "dockhand"), "DOCKHAND");
    assert.equal(normalizeEnvPrefix(" na ", "dockhand"), "NA");
    assert.equal(normalizeEnvPrefix("na_sz_1", "dockhand"), "NA_SZ_1");
    assert.equal(normalizeEnvPrefix("A".repeat(24), "dockhand"), "A".repeat(24));
    assert.throws(
      () => normalizeEnvPrefix("A".repeat(25), "dockhand"),
      /环境前缀不能超过 24 个字符/,
    );
    assert.throws(
      () => normalizeEnvPrefix("1NA", "dockhand"),
      /环境前缀只能包含字母、数字和下划线，且以字母开头/,
    );
    assert.throws(
      () => normalizeEnvPrefix("NA-SZ", "dockhand"),
      /环境前缀只能包含字母、数字和下划线，且以字母开头/,
    );
    // Rust `to_ascii_uppercase` 不做 Unicode 上标：`ß` 不会变成 `SS`，必须报字符错误。
    assert.throws(
      () => normalizeEnvPrefix("ß", "dockhand"),
      /环境前缀只能包含字母、数字和下划线，且以字母开头/,
    );
  });

  it("validateEnvPrefixConflict：只看启用行/排除自己/不同 provider 同前缀也冲突", () => {
    const rows = [
      credentialRow({ id: "gitlab-row", name: "GitLab 主实例" }),
      credentialRow({
        id: "dockhand-row",
        name: "Dockhand 面板",
        provider: "dockhand",
        env_prefix: "DOCKHAND",
      }),
      credentialRow({ id: "disabled-row", name: "停用的实例", enabled: false, env_prefix: "SELF" }),
    ];
    // 不同 provider、同一前缀 → 冲突（环境变量名相同）。
    assert.equal(
      validateEnvPrefixConflict(rows, null, "dockhand", "GITLAB"),
      "环境前缀已被「GitLab 主实例」占用：GITLAB（同一前缀会生成相同的环境变量名）",
    );
    // 编辑自己时排除自身。
    assert.equal(validateEnvPrefixConflict(rows, "gitlab-row", "gitlab", "GITLAB"), null);
    // 未启用行不参与唯一性检查。
    assert.equal(validateEnvPrefixConflict(rows, null, "gitlab", "SELF"), null);
    assert.equal(validateEnvPrefixConflict(rows, null, "dockhand", "NA"), null);
    assert.equal(
      validateEnvPrefixConflict(rows, null, "gitlab", "DOCKHAND"),
      "环境前缀已被「Dockhand 面板」占用：DOCKHAND（同一前缀会生成相同的环境变量名）",
    );
  });

  it("save：默认/自定义前缀落库为大写，view/export/envKeys 全部带解析后前缀", async () => {
    const gitlab = await startMock();
    const dockhand = await startMockDockhand();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);

    const first = await save(ctx, inputFor(gitlab) as never, false);
    assert.equal(first.envPrefix, "GITLAB");
    assert.equal(storage.getServiceCredential(first.id)!.env_prefix, "GITLAB");

    const second = await save(
      ctx,
      dockhandInputFor(dockhand, { name: "Dockhand 北美", envPrefix: "na" }) as never,
      false,
    );
    assert.equal(second.envPrefix, "NA");
    assert.equal(storage.getServiceCredential(second.id)!.env_prefix, "NA");

    const exported = exportCredentials(ctx);
    assert.deepEqual(
      exported.map((item) => [item.provider, item.envPrefix]).sort(),
      [
        ["dockhand", "NA"],
        ["gitlab", "GITLAB"],
      ],
    );
    const northAmerica = exported.find((item) => item.provider === "dockhand")!;
    assert.deepEqual(envKeys(northAmerica), [
      ["NA_URL", `${dockhand.baseUrl}${dockhand.subpath}`, "service"],
      ["NA_TOKEN", DOCKHAND_TOKEN, "cli_token"],
    ]);
    // list 视图直接给解析后前缀，前端无需再判断 provider。
    assert.deepEqual(
      list(ctx).map((item) => item.envPrefix).sort(),
      ["GITLAB", "NA"],
    );
  });

  it("save：启用中的前缀冲突（含跨 provider）在发网络请求前就报错且不落库", async () => {
    const gitlab = await startMock();
    const dockhand = await startMockDockhand();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    await save(ctx, inputFor(gitlab) as never, false);
    const upsertsAfterFirst = storage.upserts;
    gitlab.requests = [];
    dockhand.requests = [];

    await assert.rejects(
      () => save(ctx, inputFor(gitlab, { name: "另一个 GitLab" }) as never, false),
      (error: Error) => {
        assert.equal(
          error.message,
          "环境前缀已被「GitLab 主实例」占用：GITLAB（同一前缀会生成相同的环境变量名）",
        );
        return true;
      },
    );
    assert.equal(storage.upserts, upsertsAfterFirst);
    assert.equal(gitlab.requests.length, 0, "冲突属于配置错误，不应先发网络请求");

    // 不同 provider 同前缀也算冲突。
    await assert.rejects(
      () =>
        save(
          ctx,
          dockhandInputFor(dockhand, { name: "Dockhand 借用", envPrefix: "GITLAB" }) as never,
          false,
        ),
      /环境前缀已被「GitLab 主实例」占用：GITLAB（同一前缀会生成相同的环境变量名）/,
    );
    assert.equal(dockhand.requests.length, 0);

    // 保存为停用不检查冲突；之后再启用时才检查。
    const disabled = await save(
      ctx,
      inputFor(gitlab, { name: "停用副本", enabled: false }) as never,
      false,
    );
    assert.equal(disabled.envPrefix, "GITLAB");
    await assert.rejects(
      () => save(ctx, inputFor(gitlab, { id: disabled.id, name: "停用副本", enabled: true }) as never, false),
      /环境前缀已被「GitLab 主实例」占用：GITLAB/,
    );
  });

  it("save：编辑自己保留前缀不冲突，改成别人的前缀才冲突；非法前缀文案对齐 spec", async () => {
    const mock = await startMock();
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    const first = await save(ctx, inputFor(mock) as never, false);
    await save(ctx, inputFor(mock, { name: "第二个", envPrefix: "SECOND" }) as never, false);

    const same = await save(
      ctx,
      inputFor(mock, { id: first.id, name: "改名", envPrefix: "gitlab" }) as never,
      false,
    );
    assert.equal(same.envPrefix, "GITLAB");

    await assert.rejects(
      () => save(ctx, inputFor(mock, { id: first.id, envPrefix: "SECOND" }) as never, false),
      /环境前缀已被「第二个」占用：SECOND/,
    );
    await assert.rejects(
      () => save(ctx, inputFor(mock, { envPrefix: "9BAD" }) as never, false),
      /环境前缀只能包含字母、数字和下划线，且以字母开头/,
    );
    await assert.rejects(
      () => save(ctx, inputFor(mock, { envPrefix: "A".repeat(25) }) as never, false),
      /环境前缀不能超过 24 个字符/,
    );
  });

  it("旧行兼容：env_prefix NULL 时 view/export 返回 provider 默认前缀", async () => {
    const storage = new FakeCredentialStorage();
    const ctx = makeCtx(storage);
    storage.upsertServiceCredential(credentialRow({ id: "legacy-gitlab" }));
    storage.upsertServiceCredential(
      credentialRow({
        id: "legacy-dockhand",
        name: "旧 Dockhand",
        provider: "dockhand",
        base_url: "http://dockhand.example.com:3000",
      }),
    );
    storage.upsertServiceCredential(
      credentialRow({ id: "custom-prefix", name: "自定义", env_prefix: "NA" }),
    );

    assert.deepEqual(
      list(ctx).map((item) => [item.id, item.envPrefix]).sort(),
      [
        ["custom-prefix", "NA"],
        ["legacy-dockhand", "DOCKHAND"],
        ["legacy-gitlab", "GITLAB"],
      ],
    );
    for (const id of ["legacy-gitlab", "legacy-dockhand", "custom-prefix"]) {
      storage.getServiceCredential(id)!.secret_ciphertext = ctx.secrets.encrypt("legacy-token");
    }
    const exported = exportCredentials(ctx);
    assert.deepEqual(
      exported.map((item) => [item.name, item.envPrefix]).sort(),
      [
        ["旧 Dockhand", "DOCKHAND"],
        ["自定义", "NA"],
        ["默认 GitLab", "GITLAB"],
      ],
    );
  });
});
