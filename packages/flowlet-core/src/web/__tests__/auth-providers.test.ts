// 管理台登录提供方（GitHub）的持久化与校验。Owner: node-web.
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/auth-providers.test.ts
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, describe, it } from "node:test";

import {
  checkGithubProvider,
  deleteGithubProvider,
  readGithubProvider,
  readGithubProviderSummary,
  saveGithubProvider,
} from "../auth-providers.ts";

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/** 内存版 app_meta + 可预测的 fake SecretBox。 */
function fakeStorage() {
  const meta = new Map<string, string>();
  return {
    getAppMeta: (key: string) => meta.get(key) ?? null,
    setAppMeta: (key: string, value: string) => {
      meta.set(key, value);
    },
    meta,
  };
}

const secrets = {
  encrypt: (plaintext: string) => `v1:${Buffer.from(plaintext, "utf8").toString("base64")}`,
  decrypt: (encoded: string) =>
    Buffer.from(encoded.replace(/^v1:/, ""), "base64").toString("utf8"),
};

const BASE_INPUT = {
  client_id: "Ov23liTest",
  client_secret: "super-secret-value",
  display_name: "GitHub",
  allowed_logins: ["changen"],
};

describe("GitHub 提供方配置落库", () => {
  it("存进去能读回来，summary 不回传 secret", () => {
    const storage = fakeStorage();
    const saved = saveGithubProvider(storage, secrets, BASE_INPUT);
    assert.equal(saved.clientId, "Ov23liTest");
    assert.equal(saved.clientSecret, "super-secret-value");

    const back = readGithubProvider(storage, secrets);
    assert.equal(back?.clientId, "Ov23liTest");
    assert.equal(back?.clientSecret, "super-secret-value");
    assert.deepEqual(back?.allowedLogins, ["changen"]);

    const summary = readGithubProviderSummary(storage, null);
    assert.equal(summary.configured, true);
    assert.equal(summary.secret_set, true);
    assert.equal(summary.client_id, "Ov23liTest");
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes("super-secret-value"), "summary 里不能有 secret 明文");
    assert.ok(!serialized.includes("v1:"), "summary 里不能有 secret 密文");
  });

  it("库里存的是密文，不是明文", () => {
    const storage = fakeStorage();
    saveGithubProvider(storage, secrets, BASE_INPUT);
    const raw = [...storage.meta.values()].join("\n");
    assert.ok(!raw.includes("super-secret-value"));
    assert.ok(raw.includes("client_secret_ciphertext"));
  });

  it("编辑时 secret 留空 → 沿用旧密文", () => {
    const storage = fakeStorage();
    saveGithubProvider(storage, secrets, BASE_INPUT);
    const saved = saveGithubProvider(storage, secrets, {
      client_id: "Ov23liTest",
      client_secret: "",
      allowed_logins: ["changen", "someone-else"],
    });
    assert.equal(saved.clientSecret, "super-secret-value");
    assert.deepEqual(readGithubProvider(storage, secrets)?.allowedLogins, [
      "changen",
      "someone-else",
    ]);
  });

  it("不配准入直接拒绝保存", () => {
    const storage = fakeStorage();
    assert.throws(
      () => saveGithubProvider(storage, secrets, { client_id: "Ov1", client_secret: "s" }),
      /必须至少配置一种准入/,
    );
  });

  it("配了组织时默认带上 read:org", () => {
    const storage = fakeStorage();
    const saved = saveGithubProvider(storage, secrets, {
      client_id: "Ov1",
      client_secret: "s",
      allowed_orgs: ["acme"],
    });
    assert.equal(saved.scopes, "read:user user:email read:org");
  });

  it("删除后回落到未配置", () => {
    const storage = fakeStorage();
    saveGithubProvider(storage, secrets, BASE_INPUT);
    deleteGithubProvider(storage);
    assert.equal(readGithubProvider(storage, secrets), null);
    assert.equal(readGithubProviderSummary(storage, null).configured, false);
  });

  it("删除后即使有环境变量也不再回落（墓碑生效）", () => {
    const storage = fakeStorage();
    saveGithubProvider(storage, secrets, BASE_INPUT);
    deleteGithubProvider(storage);
    const envConfig = {
      clientId: "env-id",
      clientSecret: "env-secret",
      scopes: "read:user",
      displayName: "GitHub",
      allowedLogins: ["changen"],
      allowedEmails: [],
      allowedOrgs: [],
      adminLogins: [],
      adminEmails: [],
      allowAny: false,
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      apiBase: "https://api.github.com",
    };
    assert.equal(readGithubProvider(storage, secrets), null);
    assert.equal(readGithubProviderSummary(storage, envConfig).configured, false);
  });
});

describe("GitHub 凭据校验", () => {
  async function mockToken(errorCode: string, status = 200): Promise<string> {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: errorCode, error_description: "mock" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}/login/oauth/access_token`;
  }

  it("bad_verification_code = 凭据有效", async () => {
    const tokenUrl = await mockToken("bad_verification_code");
    const result = await checkGithubProvider({ clientId: "a", clientSecret: "b", tokenUrl });
    assert.equal(result.ok, true);
    assert.match(result.message, /凭据有效/);
  });

  it("incorrect_client_credentials = 凭据无效", async () => {
    const tokenUrl = await mockToken("incorrect_client_credentials");
    const result = await checkGithubProvider({ clientId: "a", clientSecret: "b", tokenUrl });
    assert.equal(result.ok, false);
    assert.match(result.message, /不匹配/);
  });

  it("连不上时给可读错误，不抛", async () => {
    const result = await checkGithubProvider({
      clientId: "a",
      clientSecret: "b",
      tokenUrl: "http://127.0.0.1:1/login/oauth/access_token",
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /连不上/);
  });
});