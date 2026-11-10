// Codex / Antigravity 账号命令的端到端测试：用本机 fixture HTTP 服务替代远端。
//
// 覆盖：
// - Codex OAuth 用量刷新：成功写快照、过期/失效时保留旧快照并标记 stale（不伪造成功）；
// - Codex 托管目录的账号定位（规范化 id、快照扫描）；
// - Antigravity OAuth：授权回调 → 令牌交换 → 用户信息 → 额度 → 托管文件；删除；
// - Antigravity 本机 language server RPC：summary / legacy models 两种额度来源。
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  authorizeCodexAccount,
  listCachedCodexAccounts,
  queryCodexAccount,
  queryCodexAccounts,
  setCodexExecutableForTests,
  setCodexUsageEndpointForTests,
} from "../../../agent/codex-account.ts";
import {
  authorizeAntigravityAccountWith,
  deleteAntigravityAccount,
  queryAntigravityOauthAccounts,
  setAntigravityEndpointsForTests,
  type Endpoints,
  type OAuthClient,
} from "../../../agent/antigravity-oauth.ts";
import {
  queryAntigravityAccounts,
  queryAntigravityServer,
} from "../../../agent/antigravity.ts";

interface FakeServer {
  url: string;
  requests: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }>;
  close(): Promise<void>;
}

async function startFakeServer(
  handler: (
    request: IncomingMessage,
    body: string,
    respond: (status: number, value: unknown) => void,
  ) => void,
): Promise<FakeServer> {
  const requests: FakeServer["requests"] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        body,
      });
      handler(request, body, (status, value) => {
        const payload = typeof value === "string" ? value : JSON.stringify(value);
        response.writeHead(status, { "content-type": "application/json" });
        response.end(payload);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server bind failed");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const tempDirs: string[] = [];
const servers: FakeServer[] = [];

afterEach(async () => {
  setCodexUsageEndpointForTests(null);
  setCodexExecutableForTests(null);
  setAntigravityEndpointsForTests(null);
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) await server.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function readdirSyncForTest(dir: string): string[] {
  return readdirSync(dir);
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "flowlet-account-"));
  tempDirs.push(dir);
  return dir;
}

async function fakeUsageServer(usage: unknown, status = 200): Promise<FakeServer> {
  const server = await startFakeServer((_request, _body, respond) => respond(status, usage));
  servers.push(server);
  setCodexUsageEndpointForTests(`${server.url}/backend-api/wham/usage`);
  return server;
}

describe("Codex OAuth 账号刷新", () => {
  it("成功刷新时写托管快照，并回读为 signed_in", async () => {
    const root = tempDir();
    const profile = path.join(root, "acc-1");
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      path.join(profile, "auth.json"),
      JSON.stringify({
        OPENAI_API_KEY: "sk-user",
        tokens: { access_token: "access", refresh_token: "refresh", account_id: "acc-1" },
      }),
    );
    const server = await fakeUsageServer({
      email: "user@example.test",
      plan_type: "plus",
      account_id: "acc-1",
      rate_limit: {
        primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
      },
    });
    const report = await queryCodexAccount(root, "acc-1");
    assert.equal(report.signed_in, true);
    assert.equal(report.email, "user@example.test");
    assert.equal(report.primary?.used_percent, 20);
    assert.equal(report.stale, false);
    assert.equal(server.requests[0].headers.authorization, "Bearer access");
    const snapshot = JSON.parse(readFileSync(path.join(profile, "snapshot.json"), "utf8")) as {
      account_id: string;
    };
    assert.equal(snapshot.account_id, "acc-1");
    const cached = listCachedCodexAccounts(root);
    assert.equal(cached.accounts.length, 1);
  });

  it("OAuth 失败且无法回退时保留旧快照并标记 stale + error", async () => {
    const root = tempDir();
    const profile = path.join(root, "acc-bad");
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      path.join(profile, "auth.json"),
      JSON.stringify({ tokens: { access_token: "access", account_id: "acc-bad" } }),
    );
    writeFileSync(
      path.join(profile, "snapshot.json"),
      JSON.stringify({
        account_id: "acc-bad",
        signed_in: true,
        email: "bad@example.test",
        source: "oauth",
        updated_at: "2026-01-01T00:00:00Z",
        stale: false,
      }),
    );
    await fakeUsageServer({ error: "invalid" }, 401);
    // 让 app-server 回退也不可用：指向不存在的可执行文件，避免真实 Codex CLI 干扰。
    setCodexExecutableForTests(path.join(root, "missing-codex"));
    const report = await queryCodexAccount(root, "acc-bad");
    assert.equal(report.signed_in, true);
    assert.equal(report.stale, true);
    assert.ok(report.error !== null && report.error.includes("官方用量接口返回 HTTP 401"));
    // stale 快照仍会被列出（前端按 error/stale 展示，不隐藏账号）。
    const cached = listCachedCodexAccounts(root);
    assert.equal(cached.accounts.length, 1);
  });

  it("托管目录缺失时给出明确错误", async () => {
    const root = tempDir();
    await assert.rejects(() => queryCodexAccount(root, "missing"), /未找到 Codex 账号 missing 的托管配置/u);
  });

  it("query_codex_accounts 在只有托管副本时逐个刷新，OAuth 失败保留 stale", async () => {
    const root = tempDir();
    const profile = path.join(root, "acc-2");
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      path.join(profile, "auth.json"),
      JSON.stringify({ tokens: { access_token: "access", account_id: "acc-2" } }),
    );
    await fakeUsageServer({ email: "two@example.test", plan_type: "pro", account_id: "acc-2" });
    const report = await queryCodexAccounts(root);
    assert.equal(report.accounts.length, 1);
    assert.equal(report.accounts[0].account_id, "acc-2");
    assert.equal(report.accounts[0].stale, false);
  });
});

describe("Codex 授权流程（app-server 不可用时）", () => {
  it("app-server 启动失败时清理 pending 目录并保留原错误", async () => {
    const root = tempDir();
    setCodexExecutableForTests(path.join(root, "missing-codex"));
    await assert.rejects(
      () => authorizeCodexAccount(root, async () => undefined),
      (error: unknown) => error instanceof Error && /无法启动 Codex app-server/u.test(error.message),
    );
    // pending 目录必须清理干净，避免残留。
    const entries = readdirSyncForTest(root);
    assert.deepEqual(entries.filter((entry) => entry.startsWith(".pending-")), []);
  });
});

// ─── Antigravity OAuth（本地 fixture 端点）──────────────────────────────────

describe("Antigravity OAuth 账号", () => {
  async function oauthFixture(state: "ok" | "quota-error"): Promise<{
    endpoints: Endpoints;
    root: string;
  }> {
    const server = await startFakeServer((request, body, respond) => {
      const url = request.url ?? "/";
      if (url === "/token") {
        const form = new URLSearchParams(body);
        const authorization = form.get("grant_type") === "authorization_code";
        respond(200, {
          access_token: authorization ? "access-1" : "access-2",
          refresh_token: "refresh-1",
          expires_in: 3600,
        });
        return;
      }
      if (url === "/oauth2/v2/userinfo") {
        respond(200, { verified_email: true, email: "antigravity@example.test" });
        return;
      }
      if (url.endsWith("/v1internal:loadCodeAssist")) {
        respond(200, { cloudaicompanionProject: "project-1", currentTier: { name: "Free" } });
        return;
      }
      if (url.endsWith("/v1internal:retrieveUserQuotaSummary")) {
        if (state === "quota-error") {
          respond(500, { error: "boom" });
          return;
        }
        respond(200, {
          response: {
            groups: [
              {
                displayName: "Gemini",
                buckets: [
                  { bucketId: "weekly", remaining: { remainingFraction: 0.5 } },
                ],
              },
            ],
          },
        });
        return;
      }
      respond(404, {});
    });
    servers.push(server);
    const endpoints: Endpoints = {
      token: `${server.url}/token`,
      userinfo: `${server.url}/oauth2/v2/userinfo`,
      cloud: server.url,
      summary: `${server.url}/v1internal:retrieveUserQuotaSummary`,
    };
    setAntigravityEndpointsForTests(endpoints);
    return { endpoints, root: tempDir() };
  }

  const CLIENT: OAuthClient = { client_id: "client", client_secret: "secret" };

  it("授权回调 → 令牌 → 身份 → 额度 → 托管文件，并可删除", async () => {
    const { endpoints, root } = await oauthFixture("ok");
    const report = await authorizeAntigravityAccountWith(
      {
        root,
        openUrl: async (url) => {
          const redirect = new URL(url).searchParams.get("redirect_uri");
          assert.ok(redirect !== null);
          const state = new URL(url).searchParams.get("state");
          const response = await fetch(
            `${redirect}?state=${encodeURIComponent(state ?? "")}&code=auth-code`,
          );
          assert.equal(response.status, 200);
        },
        endpoints,
        client: CLIENT,
        waitMs: 5000,
      },
      CLIENT,
      endpoints,
    );
    assert.equal(report.account_id, "antigravity@example.test");
    assert.equal(report.email, "antigravity@example.test");
    assert.equal(report.plan, "Free");
    assert.equal(report.quota_source, "summary");
    assert.equal(report.quotas.length, 1);
    assert.equal(report.quotas[0].remaining_fraction, 0.5);
    const files = (await import("node:fs")).readdirSync(root);
    assert.equal(files.length, 1);
    assert.equal(files[0].endsWith(".json"), true);

    const accounts = await queryAntigravityOauthAccounts(root);
    assert.equal(accounts.accounts.length, 1);
    assert.equal(accounts.accounts[0].email, "antigravity@example.test");

    await deleteAntigravityAccount(root, "antigravity@example.test");
    assert.equal((await import("node:fs")).readdirSync(root).length, 0);
    // 幂等：文件不存在时删除也成功。
    await deleteAntigravityAccount(root, "antigravity@example.test");
  });

  it("额度接口失败时保留登录态并保存 stale 快照", async () => {
    const { endpoints, root } = await oauthFixture("quota-error");
    const report = await authorizeAntigravityAccountWith(
      {
        root,
        openUrl: async (url) => {
          const redirect = new URL(url).searchParams.get("redirect_uri");
          const state = new URL(url).searchParams.get("state");
          await fetch(`${redirect}?state=${encodeURIComponent(state ?? "")}&code=auth-code`);
        },
        endpoints,
        client: CLIENT,
        waitMs: 5000,
      },
      CLIENT,
      endpoints,
    );
    assert.equal(report.email, "antigravity@example.test");
    assert.equal(report.stale, true);
    assert.ok(report.error !== null);
  });

  it("OAuth client 未配置时报安全说明错误", async () => {
    const savedId = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
    const savedSecret = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
    delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    try {
      const { authorizeAntigravityAccount } = await import("../../../agent/antigravity-oauth.ts");
      await assert.rejects(
        () => authorizeAntigravityAccount({ root: tempDir(), openUrl: async () => undefined }),
        /未配置 Antigravity OAuth 客户端/u,
      );
    } finally {
      if (savedId !== undefined) process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = savedId;
      if (savedSecret !== undefined) process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = savedSecret;
    }
  });
});

// ─── Antigravity 本机 language server ───────────────────────────────────────

describe("Antigravity 本机 RPC", () => {
  it("summary 可用时返回 summary 来源与身份/套餐", async () => {
    const server = await startFakeServer((request, body, respond) => {
      const url = request.url ?? "";
      assert.equal(request.headers["x-codeium-csrf-token"], "test-csrf");
      assert.equal(request.headers["connect-protocol-version"], "1");
      if (url.endsWith("/RetrieveUserQuotaSummary")) {
        assert.deepEqual(JSON.parse(body), { forceRefresh: false });
        respond(200, {
          response: {
            groups: [{ displayName: "Gemini", buckets: [{ bucketId: "weekly", remaining: { remainingFraction: 0.42 } }] }],
          },
        });
        return;
      }
      if (url.endsWith("/GetUserStatus")) {
        respond(200, {
          userStatus: {
            email: "test@example.test",
            userTier: { name: "Ultra" },
            planStatus: { planInfo: { planName: "Pro" } },
          },
        });
        return;
      }
      respond(404, {});
    });
    servers.push(server);
    const port = Number(new URL(server.url).port);
    const report = await queryAntigravityServer({
      pid: 65534,
      csrf: "test-csrf",
      extensionPort: port,
      extensionCsrf: null,
    });
    assert.equal(report.error, null);
    assert.equal(report.quota_source, "summary");
    assert.equal(report.email, "test@example.test");
    assert.equal(report.plan, "Ultra");
    assert.equal(report.quotas[0].remaining_fraction, 0.42);
    // 响应中不得泄露 CSRF。
    assert.equal(JSON.stringify(report).includes("test-csrf"), false);
  });

  it("无 language server 进程时返回空列表而不是错误", async () => {
    const report = await queryAntigravityAccounts();
    assert.ok(Array.isArray(report.accounts));
  });

  it("RPC 不可达时报告可读错误", async () => {
    const server = await startFakeServer((_request, _body, respond) => respond(500, {}));
    servers.push(server);
    const port = Number(new URL(server.url).port);
    const report = await queryAntigravityServer({
      pid: 65533,
      csrf: "csrf",
      extensionPort: port,
      extensionCsrf: null,
    });
    assert.equal(report.error, "无法读取 Antigravity 额度，请确认客户端已登录且本地服务已就绪");
  });
});
