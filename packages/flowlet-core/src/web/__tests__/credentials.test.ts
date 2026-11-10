// 三方服务凭据（GitLab）测试。Owner: node-web.
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/credentials.test.ts
// 覆盖：URL 归一/子路径/绝对 URL 拒绝、GitLab 10.8.7 /user+/version 语义（403 降级）、
// save 先校验后落库、编辑空 token 保留原值、掩码不泄明文、test 写回验证时间/错误、
// delete、export 仅 enabled 明文、envKeys、分页头。
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { after, describe, it } from "node:test";

import type { JsonRow } from "../../types.ts";
import type { WebContext } from "../context.ts";
import type { SecretBoxLike } from "../context.ts";
import {
  checkDockhand,
  checkGitlab,
  defaultEnvPrefix,
  deleteCredential,
  envKeys,
  exportCredentials,
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

const VALID_TOKEN = "glpat-valid-token-1a2b";
const ADMIN_TOKEN = "glpat-admin-token-9z8y";
const DOCKHAND_TOKEN = "dockhand-test-fixture-token-9x8y";

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
        defaultEnvPrefix: "GITLAB",
        available: true,
      },
      {
        id: "dockhand",
        label: "Dockhand",
        baseUrlHint: "http://dockhand.example.com:3000",
        tokenLabel: "API Token（Dockhand 设置 → API 令牌）",
        defaultEnvPrefix: "DOCKHAND",
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
      /暂不支持的服务类型：github（当前支持 gitlab、dockhand）/,
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
      () => save(ctx, { name: "x", provider: "github", baseUrl: "http://host", token: "t" } as never, false),
      /暂不支持的服务类型：github（当前支持 gitlab、dockhand）/,
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
    assert.equal(normalizeEnvPrefix("", "gitlab"), "GITLAB");
    assert.equal(normalizeEnvPrefix("   ", "dockhand"), "DOCKHAND");
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
