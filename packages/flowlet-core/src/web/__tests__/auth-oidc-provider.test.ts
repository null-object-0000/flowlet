// 管理台 OIDC（GitLab）提供方：整份配置（部署字段 + 准入/角色 + 开关）。
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/auth-oidc-provider.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer } from "node:http";

import { AdminAuth, adminAuthConfigFromEnv } from "../auth.ts";
import {
  LOGIN_MODE_META_KEY,
  OIDC_PROVIDER_META_KEY,
  applyStoredOidcOnStartup,
  checkOidcProvider,
  deleteOidcProvider,
  oidcConfigFromStored,
  readLoginMode,
  readOidcProviderSummary,
  roleForSummary,
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

const SAVE_OPTIONS = {
  envConfig: null,
  publicWebUrls: ["http://10.0.0.5:20134"],
};

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
    // http issuer + https discovery 是部署期显式给出的，界面要能看到
    assert.equal(summary.discovery_url, "https://git.intra.example.com/.well-known/openid-configuration");
  });

  it("保存准入 + 管理员名单：立即热替换，secret 沿用种子", () => {
    const storage = fakeStorage();
    const auth = makeAuth();
    const result = saveOidcProvider(
      storage,
      SECRET_BOX,
      {
        client_id: "app-id",
        allowed_subs: ["101", "102"],
        allowed_groups: ["platform/infra"],
        admin_subs: ["101"],
        allow_http_issuer: true,
      },
      { envConfig: auth.oidcDeployment, publicWebUrls: auth.config.publicWebUrls },
    );
    auth.applyOidcConfig(result.config);
    assert.deepEqual(auth.config.oidc?.allowedSubs, ["101", "102"]);
    assert.equal(auth.config.oidc?.issuer, "http://git.intra.example.com");
    assert.equal(auth.config.oidc?.clientSecret, "app-secret");
    assert.equal(result.generation, 1);

    const summary = readOidcProviderSummary(storage, auth.config.oidc);
    assert.equal(summary.source, "stored");
    assert.deepEqual(summary.admin_subs, ["101"]);
    assert.equal(summary.secret_set, true);
  });

  it("可以整份接管部署字段：新 issuer / 新 client / 新 secret", () => {
    const storage = fakeStorage();
    const result = saveOidcProvider(
      storage,
      SECRET_BOX,
      {
        issuer: "https://git.company.com/",
        client_id: "new-app",
        client_secret: "new-secret",
        allowed_domains: ["company.com"],
        allow_http_issuer: false,
      },
      { ...SAVE_OPTIONS, envConfig: makeAuth().oidcDeployment },
    );
    assert.equal(result.config.issuer, "https://git.company.com");
    assert.equal(result.config.discoveryUrl, "https://git.company.com/.well-known/openid-configuration");
    assert.equal(result.config.clientId, "new-app");
    assert.equal(result.config.clientSecret, "new-secret");
    assert.deepEqual(result.config.redirectUrls, ["http://10.0.0.5:20134/api/auth/callback"]);
    assert.equal(result.config.source, "stored");
  });

  it("只填 issuer 时接管探测到的 discovery 地址", () => {
    const result = saveOidcProvider(
      fakeStorage(),
      SECRET_BOX,
      { issuer: "http://git.intra.example.com", client_id: "cid", client_secret: "s", allowed_subs: ["1"], allow_http_issuer: true },
      {
        ...SAVE_OPTIONS,
        discovery: { discoveryUrl: "https://git.intra.example.com/.well-known/openid-configuration" },
      },
    );
    assert.equal(result.adoptedEndpoints, true);
    assert.equal(result.config.discoveryUrl, "https://git.intra.example.com/.well-known/openid-configuration");
  });

  it("显式 discovery 与 issuer 冲突时报错", () => {
    assert.throws(
      () =>
        saveOidcProvider(
          fakeStorage(),
          SECRET_BOX,
          { issuer: "https://a.example.com", client_id: "cid", client_secret: "s", allowed_subs: ["1"] },
          { ...SAVE_OPTIONS, discovery: { issuer: "https://b.example.com", discoveryUrl: "https://b.example.com/.well-known/openid-configuration" } },
        ),
      /issuer 不一致/u,
    );
  });

  it("不填准入就拒绝保存（管理台能读全部凭据）", () => {
    assert.throws(
      () =>
        saveOidcProvider(
          fakeStorage(),
          SECRET_BOX,
          { issuer: "https://idp.example.com", client_id: "cid", client_secret: "shh" },
          SAVE_OPTIONS,
        ),
      /必须至少配置一种准入/u,
    );
  });

  it("http issuer 未勾选「允许」时拒绝", () => {
    assert.throws(
      () =>
        saveOidcProvider(
          fakeStorage(),
          SECRET_BOX,
          { issuer: "http://git.intra.example.com", client_id: "cid", client_secret: "shh", allowed_subs: ["1"] },
          SAVE_OPTIONS,
        ),
      /允许 http issuer/u,
    );
  });

  it("scopes 必须含 openid；generation 不一致时拒绝覆盖", () => {
    const storage = fakeStorage();
    assert.throws(
      () =>
        saveOidcProvider(
          storage,
          SECRET_BOX,
          { issuer: "https://idp.example.com", client_id: "c", client_secret: "s", allowed_subs: ["1"], scopes: "profile" },
          SAVE_OPTIONS,
        ),
      /openid/u,
    );
    const first = saveOidcProvider(storage, SECRET_BOX, { issuer: "https://idp.example.com", client_id: "c", client_secret: "s", allowed_subs: ["1"] }, SAVE_OPTIONS);
    assert.throws(
      () =>
        saveOidcProvider(
          storage,
          SECRET_BOX,
          { issuer: "https://idp.example.com", client_id: "c", client_secret: "s", allowed_subs: ["2"], generation: first.generation - 1 },
          SAVE_OPTIONS,
        ),
      /已被其它窗口修改/u,
    );
  });

  it("重启后从数据卷恢复整份配置；墓碑后 OIDC 关闭且不回落环境变量", () => {
    const storage = fakeStorage();
    const first = makeAuth();
    const result = saveOidcProvider(
      storage,
      SECRET_BOX,
      { issuer: "https://git.company.com", client_id: "cfg", client_secret: "secret-2", allowed_groups: ["a/b"], admin_subs: ["7"] },
      { envConfig: first.oidcDeployment, publicWebUrls: first.config.publicWebUrls },
    );
    first.applyOidcConfig(result.config);

    // 「重启」：新进程只有库 + 环境变量
    const restarted = makeAuth();
    const restored = applyStoredOidcOnStartup(restarted, storage, SECRET_BOX);
    assert.equal(restored.source, "stored");
    assert.equal(restarted.config.oidc?.issuer, "https://git.company.com");
    assert.equal(restarted.config.oidc?.clientId, "cfg");
    assert.deepEqual(restarted.config.oidc?.allowedGroups, ["a/b"]);
    // 删除后 OIDC 真正不可用（不会回落到环境变量种子里那个已经过期的 issuer）
    assert.equal(restarted.oidcDeployment?.source, "env");
    assert.notEqual(restarted.oidcDeployment?.issuer, restarted.config.oidc?.issuer);

    deleteOidcProvider(storage);
    const afterTombstone = makeAuth();
    const tomb = applyStoredOidcOnStartup(afterTombstone, storage, SECRET_BOX);
    assert.equal(tomb.source, "tombstone");
    assert.equal(afterTombstone.config.oidc, null);
  });

  it("库内 secret 解不开时停用 OIDC，而不是带病放行", () => {
    const storage = fakeStorage();
    saveOidcProvider(storage, SECRET_BOX, { issuer: "https://idp.example.com", client_id: "c", client_secret: "s", allowed_subs: ["1"] }, SAVE_OPTIONS);
    const auth = makeAuth();
    const broken = { encrypt: SECRET_BOX.encrypt, decrypt: () => { throw new Error("key rotated"); } };
    assert.equal(applyStoredOidcOnStartup(auth, storage, broken).source, "invalid");
    assert.equal(auth.config.oidc, null);
  });

  it("角色预测与真实判权一致", () => {
    const summary = {
      allowed_subs: ["94"],
      allowed_groups: ["platform/infra"],
      allowed_emails: [],
      allowed_domains: ["company.com"],
      admin_subs: [],
      admin_emails: [],
      allow_any: false,
    };
    const member = { sub: "501", email: "dev@company.com", groups: ["platform/infra"] };
    const boss = { sub: "94", email: null, groups: [] };
    const stranger = { sub: "9", email: "x@other.com", groups: [] };
    assert.equal(roleForSummary(summary, member), "viewer");
    assert.equal(roleForSummary(summary, boss), "admin");
    assert.equal(roleForSummary(summary, stranger), "denied");
    assert.equal(roleForSummary({ ...summary, allowed_domains: [] }, stranger), "denied");
  });

  it("oidcConfigFromStored 生成回调白名单（每个对外地址一个）", () => {
    const storage = fakeStorage();
    saveOidcProvider(storage, SECRET_BOX, { issuer: "https://idp.example.com", client_id: "c", client_secret: "s", allowed_subs: ["1"] }, SAVE_OPTIONS);
    const parsed = JSON.parse(storage.getAppMeta(OIDC_PROVIDER_META_KEY));
    const config = oidcConfigFromStored(parsed, SECRET_BOX, ["https://a.example.com", "http://10.0.0.5:20134"]);
    assert.deepEqual(config?.redirectUrls, [
      "https://a.example.com/api/auth/callback",
      "http://10.0.0.5:20134/api/auth/callback",
    ]);
  });
});

describe("登录方式开关", () => {
  it("默认跟随配置：配了 OIDC 就开 OIDC", () => {
    const auth = makeAuth();
    assert.deepEqual(auth.enabledProviders(), ["oidc"]);
    const config = JSON.parse(auth.configHandler().body.toString("utf8"));
    assert.deepEqual(config.providers.map((item: { id: string }) => item.id), ["oidc"]);
  });

  it("只开 GitHub：登录页不再出现 OIDC，?provider=oidc 也不放行", async () => {
    const { ctx, auth } = makeCtx(
      fakeStorage(),
      makeAuth({ ...ENV, FLOWLET_GITHUB_CLIENT_ID: "gh-id", FLOWLET_GITHUB_CLIENT_SECRET: "gh-secret", FLOWLET_GITHUB_ALLOWED_LOGINS: "changen" }),
    );
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

  it("OIDC-only 时移除 GitLab 登录被拒绝（否则没人能再登录）", async () => {
    const { ctx, auth } = makeCtx();
    await assert.rejects(dispatch(ctx, "delete_oidc_auth_provider", {}), /无法再登录/u);
    assert.notEqual(auth.config.oidc, null);
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

describe("命令层：整份配置自助改", () => {
  it("set → get 返回库内记录与 generation；hot-swap 生效", async () => {
    const { ctx, auth } = makeCtx();
    const saved = (await dispatch(ctx, "set_oidc_auth_provider", {
      issuer: "https://git.company.com",
      client_id: "cfg",
      allowed_subs: ["94"],
      allowed_groups: ["platform/infra"],
      admin_subs: ["94"],
    })) as { generation: number };
    assert.equal(saved.generation, 1);
    assert.equal(auth.config.oidc?.issuer, "https://git.company.com");
    // secret 留空：沿用部署种子，不允许出现「没 secret 就保存失败」
    assert.equal(auth.config.oidc?.clientSecret, "app-secret");
    const summary = (await dispatch(ctx, "get_oidc_auth_provider", {})) as any;
    assert.equal(summary.source, "stored");
    assert.deepEqual(summary.allowed_groups, ["platform/infra"]);
    assert.equal(summary.secret_set, true);
  });

  it("从没配过 OIDC 也能在界面里直接建起来", async () => {
    const { ctx, auth } = makeCtx(
      fakeStorage(),
      makeAuth({ FLOWLET_ADMIN_AUTH_MODE: "oidc", FLOWLET_PUBLIC_WEB_URL: "http://10.0.0.5:20134", FLOWLET_GITHUB_CLIENT_ID: "g", FLOWLET_GITHUB_CLIENT_SECRET: "s", FLOWLET_GITHUB_ALLOWED_LOGINS: "x" }),
    );
    assert.equal(auth.oidcDeployed(), false);
    await dispatch(ctx, "set_oidc_auth_provider", {
      issuer: "https://git.company.com",
      client_id: "app",
      client_secret: "secret",
      allowed_domains: ["company.com"],
    });
    await dispatch(ctx, "set_admin_login_mode", { enabled: ["oidc", "github"] });
    const summary = (await dispatch(ctx, "get_oidc_auth_provider", {})) as any;
    assert.equal(summary.source, "stored");
    assert.equal(summary.issuer, "https://git.company.com");
    assert.deepEqual(summary.allowed_domains, ["company.com"]);
    assert.deepEqual(auth.enabledProviders(), ["oidc", "github"]);
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

  it("discovery 一致 + 无效 code 被识别为 invalid_grant → 凭据可用", async () => {
    const fixture = await discoveryFixture(400, "invalid_grant");
    try {
      const result = await checkOidcProvider({
        issuer: fixture.issuer,
        discoveryUrl: "",
        clientId: "cid",
        clientSecret: "secret",
        insecureHttp: true,
        redirectUrls: ["http://10.0.0.5:20134/api/auth/callback"],
      });
      assert.equal(result.ok, true);
      const keys = result.items.map((item) => item.key);
      assert.deepEqual(keys, ["issuer", "discovery", "endpoints", "pkce", "redirect", "client"]);
      assert.match(result.items.find((item) => item.key === "client")!.message, /凭据有效/u);
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
      assert.equal(result.items.find((item) => item.key === "client")!.status, "error");
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
      assert.match(result.items.find((item) => item.key === "discovery")!.message, /issuer 不一致/u);
    } finally {
      fixture.close();
    }
  });
});


describe("legacy OIDC policy upgrade", () => {
  it("migrates policy overrides with deployment credentials and survives reapply", () => {
    const storage = fakeStorage();
    const legacy = { scopes: "openid email", display_name: "Company GitLab",
      allowed_subs: ["legacy-user"], allowed_groups: [], allowed_emails: [], allowed_domains: [],
      admin_subs: ["legacy-admin"], admin_emails: [], allow_any: false };
    storage.setAppMeta(OIDC_PROVIDER_META_KEY, JSON.stringify(legacy));
    const auth = AdminAuth.fromConfig(adminAuthConfigFromEnv(ENV));
    const secret = auth.config.oidc!.clientSecret;
    assert.equal(applyStoredOidcOnStartup(auth, storage, SECRET_BOX).source, "stored");
    assert.deepEqual(auth.config.oidc!.allowedSubs, legacy.allowed_subs);
    assert.deepEqual(auth.config.oidc!.adminSubs, legacy.admin_subs);
    assert.equal(auth.config.oidc!.clientSecret, secret);
    const saved = storage.getAppMeta(OIDC_PROVIDER_META_KEY);
    assert.equal(JSON.parse(saved).client_secret_ciphertext, SECRET_BOX.encrypt(secret));
    assert.equal(applyStoredOidcOnStartup(auth, storage, SECRET_BOX).source, "stored");
    assert.equal(storage.getAppMeta(OIDC_PROVIDER_META_KEY), saved);
    storage.setAppMeta(OIDC_PROVIDER_META_KEY, JSON.stringify({ deleted: true }));
    assert.equal(applyStoredOidcOnStartup(auth, storage, SECRET_BOX).source, "tombstone");
    assert.equal(auth.config.oidc, null);
  });
  it("does not use deployment credentials for an incomplete full configuration", () => {
    const storage = fakeStorage();
    storage.setAppMeta(OIDC_PROVIDER_META_KEY, JSON.stringify({issuer:"https://bad.example", allowed_subs:[]}));
    const auth = AdminAuth.fromConfig(adminAuthConfigFromEnv(ENV));
    assert.equal(applyStoredOidcOnStartup(auth, storage, SECRET_BOX).source, "invalid");
    assert.equal(auth.config.oidc, null);
  });
});
