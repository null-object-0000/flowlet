// 管理台 OIDC（GitLab）登录提供方：自助配置 + 登录方式开关。
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/auth-oidc-provider.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer } from "node:http";

import { AdminAuth, adminAuthConfigFromEnv } from "../auth.ts";
import {
  LOGIN_MODE_META_KEY,
  OIDC_PROVIDER_META_KEY,
  checkOidcProvider,
  deleteOidcProvider,
  readLoginMode,
  readOidcProviderOverride,
  readOidcProviderSummary,
  saveLoginMode,
  saveOidcProvider,
} from "../auth-oidc-provider.ts";
import { dispatch } from "../commands.ts";
import type { WebContext } from "../context.ts";

const SECRET_BOX = {
  encrypt: (plaintext: string) => `v1:${Buffer.from(plaintext, "utf8").toString("base64")}`,
  decrypt: (encoded: string) => {
    if (!encoded.startsWith("v1:")) throw new Error("bad ciphertext");
    return Buffer.from(encoded.slice(3), "base64").toString("utf8");
  },
};

function fakeStorage() {
  const meta = new Map<string, string>();
  return {
    getAppMeta: (key: string) => meta.get(key) ?? null,
    setAppMeta: (key: string, value: string) => {
      meta.set(key, value);
    },
    meta,
  } as any;
}

/** 内网 GitLab 那种部署：issuer 是 http，discovery 显式走 https。 */
const ENV = {
  FLOWLET_ADMIN_AUTH_MODE: "oidc",
  FLOWLET_PUBLIC_WEB_URL: "http://10.0.0.5:20134",
  FLOWLET_OIDC_ISSUER: "http://git.intra.example.com",
  FLOWLET_OIDC_DISCOVERY_URL: "https://git.intra.example.com/.well-known/openid-configuration",
  FLOWLET_OIDC_ALLOW_HTTP_ISSUER: "1",
  FLOWLET_OIDC_CLIENT_ID: "app-id",
  FLOWLET_OIDC_CLIENT_SECRET: "app-secret",
  FLOWLET_OIDC_ALLOWED_SUBS: "94",
  FLOWLET_OIDC_ADMIN_SUBS: "94",
};

function makeAuth(env: Record<string, string> = ENV): AdminAuth {
  return AdminAuth.fromConfig(adminAuthConfigFromEnv(env, undefined));
}

function makeCtx(storage = fakeStorage(), auth = makeAuth()) {
  const ctx = {
    storage,
    secrets: SECRET_BOX,
    auth,
    proxy: { status: () => ({}) },
    runtimeConfig: { snapshot: () => ({}) },
    catalogDir: "/tmp",
    configPath: "/tmp/config.json",
    adminToken: "",
    clientToken: "",
    staticDir: "",
    publicProxyUrl: "",
    deviceIdentity: {},
    config: {},
    channelsConfig: {},
    cliAuth: {},
    upstreamProxy: {},
    logCapture: {},
  } as unknown as WebContext;
  return { ctx, storage, auth };
}

describe("OIDC 提供方：谁能登录 / 谁能管理", () => {
  it("环境变量种子出现在摘要里，且标记 source=env", () => {
    const summary = readOidcProviderSummary(fakeStorage(), makeAuth().config.oidc);
    assert.equal(summary.source, "env");
    assert.equal(summary.configured, true);
    assert.equal(summary.issuer, "http://git.intra.example.com");
    assert.deepEqual(summary.allowed_subs, ["94"]);
    assert.equal(summary.secret_set, true);
  });

  it("保存准入名单 + 管理员名单：立即热替换，secret 不再需要重填", () => {
    const storage = fakeStorage();
    const auth = makeAuth();
    const override = saveOidcProvider(
      storage,
      {
        client_id: "app-id",
        // 留空 = 沿用环境变量种子里的 secret
        allowed_subs: ["101", "102"],
        allowed_groups: ["platform/infra"],
        admin_subs: ["101"],
        allow_http_issuer: true,
      },
      auth.config.oidc,
    );
    auth.applyOidcRuntimeConfig(override);
    assert.deepEqual(auth.config.oidc?.allowedSubs, ["101", "102"]);
    // 部署级字段不动
    assert.equal(auth.config.oidc?.issuer, "http://git.intra.example.com");
    assert.equal(auth.config.oidc?.clientSecret, "app-secret");

    const summary = readOidcProviderSummary(storage, auth.config.oidc);
    assert.equal(summary.source, "stored");
    assert.deepEqual(summary.admin_subs, ["101"]);
    assert.equal(summary.secret_set, true);

    // 组准入者默认只读，管理员名单里的人是 admin
    const stored = readOidcProviderOverride(storage);
    assert.deepEqual(stored?.allowedGroups, ["platform/infra"]);
  });

  it("不填准入就拒绝保存", () => {
    assert.throws(() => saveOidcProvider(fakeStorage(), {}, makeAuth().config.oidc), /必须至少配置一种准入/u);
  });

  it("部署缺失或修改部署字段时拒绝保存且不落库", () => {
    const storage = fakeStorage();
    assert.throws(() => saveOidcProvider(storage, { allowed_subs: ["1"] }), /部署/u);
    for (const input of [{ issuer: "https://other.example" }, { client_secret: "new-secret" }, { pkce: "off" }, { redirect_urls: [] }]) {
      assert.throws(() => saveOidcProvider(storage, { allowed_subs: ["1"], ...input }, makeAuth({ ...ENV, FLOWLET_OIDC_REDIRECT_URL: "https://remote.example/api/auth/callback" }).config.oidc), /部署级只读/u);
    }
    assert.equal(storage.meta.size, 0);
  });

  it("移除后写墓碑：摘要回落到环境变量种子", () => {
    const storage = fakeStorage();
    const auth = makeAuth();
    saveOidcProvider(storage, { allowed_subs: ["7"], allow_http_issuer: true }, auth.config.oidc);
    deleteOidcProvider(storage);
    assert.equal(storage.getAppMeta(OIDC_PROVIDER_META_KEY), JSON.stringify({ deleted: true }));
    assert.equal(readOidcProviderOverride(storage), null);
    assert.equal(readOidcProviderSummary(storage, auth.config.oidc).source, "env");
  });
});

describe("登录方式开关", () => {
  it("默认跟随配置：配了 OIDC 就开 OIDC", () => {
    const auth = makeAuth();
    assert.deepEqual(auth.enabledProviders(), ["oidc"]);
    const config = JSON.parse(auth.configHandler().body.toString("utf8"));
    assert.deepEqual(
      config.providers.map((item: { id: string }) => item.id),
      ["oidc"],
    );
  });

  it("只开 GitHub：登录页不再出现 OIDC，?provider=oidc 也不放行", async () => {
    const { ctx, auth } = makeCtx(fakeStorage(), makeAuth({ ...ENV, FLOWLET_GITHUB_CLIENT_ID: "gh-id", FLOWLET_GITHUB_CLIENT_SECRET: "gh-secret", FLOWLET_GITHUB_ALLOWED_LOGINS: "changen" }));
    await dispatch(ctx, "set_admin_login_mode", { enabled: ["github"] });
    assert.deepEqual(auth.enabledProviders(), ["github"]);
    const login = await auth.loginHandler({ headers: {}, url: "/api/auth/login?provider=oidc" });
    assert.equal(login.status, 404);
  });

  it("两个都关且没有静态凭据兜底时拒绝保存（不会把自己锁在门外）", async () => {
    const { ctx, auth } = makeCtx();
    await assert.rejects(dispatch(ctx, "set_admin_login_mode", { enabled: [] }), /至少/u);
    assert.deepEqual(auth.enabledProviders(), ["oidc"]);
  });

  it("开启 ALLOW_TOKEN_LOGIN 后允许两个都关，回落静态凭据", async () => {
    const storage = fakeStorage();
    const auth = makeAuth({ ...ENV, FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN: "1", FLOWLET_ADMIN_TOKEN: "0123456789abcdef0123456789" });
    const { ctx } = makeCtx(storage, auth);
    await dispatch(ctx, "set_admin_login_mode", { enabled: [] });
    assert.deepEqual(auth.enabledProviders(), []);
    const config = JSON.parse(auth.configHandler().body.toString("utf8"));
    assert.deepEqual(config.providers, []);
    assert.equal(config.token_login, true);
    assert.equal(storage.getAppMeta(LOGIN_MODE_META_KEY), JSON.stringify({ oidc: false, github: false }));
  });

  it("库里存过的开关原样读回", () => {
    const storage = fakeStorage();
    saveLoginMode(storage, { oidc: true, github: false });
    assert.deepEqual(readLoginMode(storage, { oidc: true, github: true }), {
      mode: { oidc: true, github: false },
      source: "stored",
    });
  });
});

describe("OIDC 连通性校验", () => {
  async function discoveryFixture(tokenStatus: number, errorCode: string) {
    const server = createServer((request, response) => {
      if (request.url === "/.well-known/openid-configuration") {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/oauth/authorize`,
            token_endpoint: `${base}/oauth/token`,
            jwks_uri: `${base}/oauth/discovery/keys`,
            code_challenge_methods_supported: ["S256"],
          }),
        );
        return;
      }
      if (request.url === "/oauth/token") {
        response.statusCode = tokenStatus;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: errorCode }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return { issuer: `http://127.0.0.1:${port}`, close: () => server.close() };
  }

  it("discovery 一致 + invalid_grant → 端点可达，凭据仍需实际登录", async () => {
    const fixture = await discoveryFixture(400, "invalid_grant");
    try {
      const result = await checkOidcProvider({
        issuer: fixture.issuer,
        discoveryUrl: "",
        clientId: "cid",
        clientSecret: "secret",
        insecureHttp: true,
      });
      assert.equal(result.ok, true);
      assert.match(result.message, /PKCE S256/u);
    } finally {
      fixture.close();
    }
  });

  it("invalid_client → 凭据不匹配", async () => {
    const fixture = await discoveryFixture(401, "invalid_client");
    try {
      const result = await checkOidcProvider({
        issuer: fixture.issuer,
        discoveryUrl: "",
        clientId: "cid",
        clientSecret: "wrong",
        insecureHttp: true,
      });
      assert.equal(result.ok, false);
      assert.match(result.message, /invalid_client/u);
    } finally {
      fixture.close();
    }
  });

  it("issuer 对不上就报错", async () => {
    const fixture = await discoveryFixture(400, "invalid_grant");
    try {
      const result = await checkOidcProvider({
        issuer: "http://elsewhere.example.com",
        discoveryUrl: `${fixture.issuer}/.well-known/openid-configuration`,
        clientId: "cid",
        clientSecret: "s",
        insecureHttp: true,
      });
      assert.equal(result.ok, false);
      assert.match(result.message, /issuer 不一致/u);
    } finally {
      fixture.close();
    }
  });
});

describe("OIDC 审查回归", () => {
  it("保存不改部署参数、不复制 secret，重启恢复与移除均保留回调白名单", async () => {
    const auth = makeAuth({ ...ENV, FLOWLET_OIDC_REDIRECT_URLS: "https://public.example/api/auth/callback", FLOWLET_OIDC_PKCE: "required" });
    const { ctx, storage } = makeCtx(fakeStorage(), auth);
    const deployment = structuredClone(auth.config.oidc);
    await dispatch(ctx, "set_oidc_auth_provider", { allowed_subs: ["7"], admin_subs: ["7"], display_name: "新名称" });
    assert.deepEqual(auth.config.oidc?.redirectUrls, deployment?.redirectUrls);
    assert.equal(auth.config.oidc?.pkce, "required");
    assert.equal(storage.getAppMeta(OIDC_PROVIDER_META_KEY)?.includes("secret"), false);
    const restarted = makeAuth({ ...ENV, FLOWLET_OIDC_REDIRECT_URLS: "https://public.example/api/auth/callback", FLOWLET_OIDC_PKCE: "required" });
    restarted.applyOidcRuntimeConfig(readOidcProviderOverride(storage)!);
    assert.deepEqual(restarted.config.oidc, auth.config.oidc);
    // 删除必须恢复构造时部署配置，不能受其他进程环境或覆盖值影响。
    await dispatch(ctx, "delete_oidc_auth_provider", {});
    assert.deepEqual(auth.config.oidc, deployment);
    assert.equal(readOidcProviderOverride(storage), null);
    assert.deepEqual(auth.enabledProviders(), ["oidc"]);
  });

  it("坏准入配置拒绝启动读取，不静默回落到更宽的部署默认", () => {
    const storage = fakeStorage();
    storage.setAppMeta(OIDC_PROVIDER_META_KEY, '{"allow_any":true}');
    assert.throws(() => readOidcProviderOverride(storage), /损坏/);
    storage.setAppMeta(LOGIN_MODE_META_KEY, '{"oidc":"false"}');
    assert.throws(() => readLoginMode(storage, { oidc: true, github: true }), /损坏/);
  });

  it("关闭或删除最后一个提供方前检查兜底；参数错误不写库", async () => {
    const auth = makeAuth({ ...ENV, FLOWLET_GITHUB_CLIENT_ID: "gh", FLOWLET_GITHUB_CLIENT_SECRET: "gh-secret", FLOWLET_GITHUB_ALLOWED_LOGINS: "user" });
    const { ctx, storage } = makeCtx(fakeStorage(), auth);
    await dispatch(ctx, "set_admin_login_mode", { enabled: ["github"] });
    await assert.rejects(dispatch(ctx, "delete_github_auth_provider", {}), /最后一个/);
    assert.ok(auth.config.github);
    const before = new Map(storage.meta);
    for (const args of [{}, { enabled: [true] }, { enabled: ["bad"] }, { enabled: "oidc" }]) {
      await assert.rejects(dispatch(ctx, "set_admin_login_mode", args));
    }
    await assert.rejects(dispatch(ctx, "set_oidc_auth_provider", { allowed_subs: [94] }));
    assert.deepEqual(storage.meta, before);
    await dispatch(ctx, "set_admin_login_mode", { enabled: ["oidc", "github"] });
    await dispatch(ctx, "delete_github_auth_provider", {});
    assert.equal(auth.config.github, null);
  });

  it("持久化失败保持原登录方式及自动推断语义", async () => {
    const { ctx, auth, storage } = makeCtx();
    storage.setAppMeta = () => { throw new Error("disk full"); };
    await assert.rejects(dispatch(ctx, "set_admin_login_mode", { enabled: ["oidc"] }), /disk full/);
    assert.equal(auth.config.enabledProviders, null);
    await assert.rejects(dispatch(ctx, "set_oidc_auth_provider", { allowed_subs: ["7"] }), /disk full/);
    assert.deepEqual(auth.config.oidc?.allowedSubs, ["94"]);
  });

  it("缺失 issuer、HTTP 降级、重定向与错误 token 响应均不报成功", async () => {
    const input = { issuer: "https://idp.example", discoveryUrl: "", clientId: "cid", clientSecret: "secret", insecureHttp: false };
    const doc = { issuer: input.issuer, authorization_endpoint: "https://idp.example/auth", token_endpoint: "https://idp.example/token", jwks_uri: "https://idp.example/jwks" };
    for (const patch of [{ issuer: "" }, { token_endpoint: "http://idp.example/token" }, { token_endpoint: "https://user:pass@idp.example/token" }]) {
      let count = 0;
      const result = await checkOidcProvider(input, (async () => { count++; return Response.json({ ...doc, ...patch }); }) as typeof fetch);
      assert.equal(result.ok, false);
      assert.equal(count, 1);
    }
    for (const status of [302, 404, 500]) {
      const result = await checkOidcProvider(input, (async (_url, init) => {
        assert.equal(init?.redirect, "manual");
        return init?.method === "POST" ? new Response("error", { status }) : Response.json(doc);
      }) as typeof fetch);
      assert.equal(result.ok, false);
    }
  });
});
