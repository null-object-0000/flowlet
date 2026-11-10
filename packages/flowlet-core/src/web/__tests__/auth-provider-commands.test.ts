// 管理台「登录与访问」命令：get / set / delete / check 的 dispatch 级验证。
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/auth-provider-commands.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AdminAuth, adminAuthConfigFromEnv } from "../auth.ts";
import { GITHUB_PROVIDER_META_KEY } from "../auth-providers.ts";
import { dispatch } from "../commands.ts";
import type { WebContext } from "../context.ts";

function fakeStorage() {
  const meta = new Map<string, string>();
  return {
    getAppMeta: (key: string) => meta.get(key) ?? null,
    setAppMeta: (key: string, value: string) => {
      meta.set(key, value);
    },
    meta,
  } as unknown as WebContext["storage"] & { meta: Map<string, string> };
}

const secrets = {
  encrypt: (plaintext: string) => `v1:${Buffer.from(plaintext, "utf8").toString("base64")}`,
  decrypt: (encoded: string) =>
    Buffer.from(encoded.replace(/^v1:/, ""), "base64").toString("utf8"),
};

function makeCtx() {
  const storage = fakeStorage();
  const auth = AdminAuth.fromConfig(
    adminAuthConfigFromEnv(
      { FLOWLET_ADMIN_AUTH_MODE: "token", FLOWLET_ADMIN_TOKEN: "0123456789abcdef0123456789" },
      undefined,
    ),
  );
  const ctx = {
    storage,
    secrets,
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

describe("登录提供方命令", () => {
  it("未配置时 get 返回 configured=false", async () => {
    const { ctx } = makeCtx();
    const summary = (await dispatch(ctx, "get_github_auth_provider", {})) as Record<string, unknown>;
    assert.equal(summary.configured, false);
    assert.equal(summary.secret_set, false);
  });

  it("set 后立即热替换 auth，且 get 不回传 secret", async () => {
    const { ctx, auth } = makeCtx();
    await dispatch(ctx, "set_github_auth_provider", {
      client_id: "Ov23liX",
      client_secret: "shhh",
      allowed_logins: ["changen"],
    });
    assert.equal(auth.config.github?.clientId, "Ov23liX");
    assert.equal(auth.config.github?.clientSecret, "shhh");

    const summary = (await dispatch(ctx, "get_github_auth_provider", {})) as Record<string, unknown>;
    assert.equal(summary.configured, true);
    assert.equal(summary.client_id, "Ov23liX");
    assert.equal(summary.secret_set, true);
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes("shhh"), "命令返回里不能有 secret 明文");
    assert.ok(!serialized.includes("v1:"), "命令返回里不能有 secret 密文");
  });

  it("set 不配准入 → 400 且不落库", async () => {
    const { ctx, storage } = makeCtx();
    await assert.rejects(
      () => dispatch(ctx, "set_github_auth_provider", { client_id: "Ov1", client_secret: "s" }),
      /必须至少配置一种准入/,
    );
    assert.equal(storage.getAppMeta(GITHUB_PROVIDER_META_KEY), null);
  });

  it("delete 后关闭并提供方置空", async () => {
    const { ctx, auth } = makeCtx();
    await dispatch(ctx, "set_github_auth_provider", {
      client_id: "Ov23liX",
      client_secret: "shhh",
      allowed_logins: ["changen"],
    });
    await dispatch(ctx, "delete_github_auth_provider", {});
    assert.equal(auth.config.github, null);
    assert.equal(
      ((await dispatch(ctx, "get_github_auth_provider", {})) as Record<string, unknown>).configured,
      false,
    );
  });
});