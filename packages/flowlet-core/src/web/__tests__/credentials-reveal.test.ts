// 服务凭据「查看原始 token」（`reveal_service_credential`）测试。Owner: node-web.
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/credentials-reveal.test.ts
// 覆盖：管理鉴权后返回明文、未鉴权 401、CLI token 403、凭据不存在/无法解密 400、
// 列表视图仍不含明文（只有掩码）。
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { JsonRow } from "../../types.ts";
import { createWebHost } from "../index.ts";

const ADMIN_TOKEN = "flowlet-reveal-test-admin-0123456789";
const CLIENT_TOKEN = "flowlet-reveal-test-client-0123456789";
const SECRET = "dockhand-secret-token-abc123xyz";

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

const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
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

/** 密文格式 `v1:<base64(plaintext)>` 的测试用 SecretBox。 */
const fakeSecrets = {
  encrypt: (plaintext: string) => `v1:${Buffer.from(plaintext, "utf8").toString("base64")}`,
  decrypt: (encoded: string) => {
    if (!encoded.startsWith("v1:")) throw new Error("凭据密文版本不支持，请重新保存该凭据");
    return Buffer.from(encoded.slice(3), "base64").toString("utf8");
  },
};

const CREDENTIAL: JsonRow = {
  id: "cred-reveal-1",
  name: "公司 Dockhand",
  provider: "dockhand",
  base_url: "http://10.177.40.105:3000",
  secret_ciphertext: fakeSecrets.encrypt(SECRET),
  secret_hint: "••••3xyz",
  kind: "cli_token",
  note: null,
  env_prefix: "DOCKHAND_NA",
  enabled: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_verified_at: null,
  last_error: null,
};

const BROKEN_CREDENTIAL: JsonRow = {
  ...CREDENTIAL,
  id: "cred-broken",
  name: "坏密文",
  secret_ciphertext: "garbage",
};

interface TestHost {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHost(): Promise<TestHost> {
  clearEnv();
  const port = await freePort();
  process.env.FLOWLET_ADMIN_AUTH_MODE = "token";
  process.env.FLOWLET_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.FLOWLET_PUBLIC_WEB_URL = `http://127.0.0.1:${port}`;
  const workDir = mkdtempSync(path.join(tmpdir(), "flowlet-reveal-"));
  const staticDir = path.join(workDir, "static");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>test</title>");
  const configPath = path.join(workDir, "config.json");
  writeFileSync(configPath, "{}\n");

  class FakeStorage {
    rows: JsonRow[] = [];
    tokens = new Map<string, JsonRow>();

    listServiceCredentials(): JsonRow[] {
      return this.rows.map((row) => ({ ...row, secret_ciphertext: undefined }));
    }
    getServiceCredential(id: string): JsonRow | null {
      return this.rows.find((row) => row.id === id) ?? null;
    }
    getAppMeta(): string | null {
      return null;
    }
    setAppMeta(): void {}
    listChannelModels(): JsonRow[] {
      return [];
    }
    insertCliAuthToken(row: JsonRow): JsonRow {
      // 与真实 storage 一致：返回 snake_case 行（authenticate 读 expires_at）。
      const stored = {
        ...row,
        token_hash: row.tokenHash,
        expires_at: row.expiresAt,
        created_at: "2026-01-01T00:00:00Z",
        last_used_at: null,
      };
      this.tokens.set(stored.token_hash, stored);
      return stored;
    }
    listCliAuthTokens(): JsonRow[] {
      return [...this.tokens.values()];
    }
    findCliAuthTokenByHash(hash: string): JsonRow | null {
      return this.tokens.get(hash) ?? null;
    }
    touchCliAuthToken(): void {}
    deleteCliAuthToken(id: string): boolean {
      for (const [hash, row] of this.tokens) {
        if (row.id === id) return this.tokens.delete(hash);
      }
      return false;
    }
    deleteExpiredCliAuthTokens(): number {
      return 0;
    }
  }

  const storage = new FakeStorage();
  storage.rows = [CREDENTIAL, BROKEN_CREDENTIAL];
  const bindConfig = { host: "127.0.0.1", port: 0, allow_lan: false, default_client_token: CLIENT_TOKEN };
  const snapshot: JsonRow = { channels: [], accounts: [], routes: [], rules: [], virtual_models: [] };
  const web = createWebHost({
    storage: storage as unknown as never,
    proxy: {
      start: async () => {},
      stop: async () => {},
      status: () => ({ running: false, bind_addr: "127.0.0.1:0", started_at: null }),
      bindConfig: () => bindConfig,
      setBindConfig: () => {},
    },
    runtimeConfig: {
      snapshot: () => snapshot,
      replace: () => {},
      update: (mutate: (draft: JsonRow) => void) => mutate(snapshot),
    },
    bindConfig,
    secrets: fakeSecrets,
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
  const close = async (): Promise<void> => {
    await web.close();
    rmSync(workDir, { recursive: true, force: true });
  };
  cleanup.push(close);
  return { baseUrl: `http://127.0.0.1:${port}`, close };
}

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown> | null;
  text: string;
}

async function post(
  baseUrl: string,
  command: string,
  body: string,
  token?: string,
): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}/api/commands/${command}`, {
    method: "POST",
    headers,
    body,
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text };
}

/** 通过 `flowlet login` 的公开端点换一把 CLI token（模拟已授权机器）。 */
async function issueCliToken(baseUrl: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const issue = await post(
    baseUrl,
    "create_cli_auth_code",
    JSON.stringify({
      redirectUri: "http://127.0.0.1:45999/cb",
      state: "state-reveal-1",
      codeChallenge: challenge,
      name: "agent-box",
    }),
    ADMIN_TOKEN,
  );
  assert.equal(issue.status, 200, issue.text);
  const redirect = new URL(String(issue.json?.redirectUrl ?? ""));
  const code = redirect.searchParams.get("code") ?? "";
  const response = await fetch(`${baseUrl}/api/auth/cli/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier }),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  return String(payload.token ?? "");
}

describe("reveal_service_credential", () => {
  it("管理鉴权后可返回原始 token，且列表视图仍只有掩码", async () => {
    const { baseUrl } = await startHost();
    const detail = await post(baseUrl, "reveal_service_credential", JSON.stringify({ id: CREDENTIAL.id }), ADMIN_TOKEN);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json?.token, SECRET);
    assert.equal(detail.json?.name, "公司 Dockhand");
    assert.equal(detail.json?.envPrefix, "DOCKHAND_NA");
    // 管理响应禁止缓存
    assert.equal(detail.headers.get("cache-control"), "no-store");

    const list = await post(baseUrl, "list_service_credentials", "{}", ADMIN_TOKEN);
    assert.equal(list.status, 200);
    assert.ok(!list.text.includes(SECRET), "列表响应不得出现明文 token");
    assert.ok(list.text.includes("••••"), "列表仍返回掩码");
  });

  it("未鉴权 401；CLI token 越权访问 403", async () => {
    const { baseUrl } = await startHost();
    const anonymous = await post(baseUrl, "reveal_service_credential", JSON.stringify({ id: CREDENTIAL.id }));
    assert.equal(anonymous.status, 401);

    const cliToken = await issueCliToken(baseUrl);
    assert.ok(cliToken.startsWith("flwcli_"));
    const forbidden = await post(
      baseUrl,
      "reveal_service_credential",
      JSON.stringify({ id: CREDENTIAL.id }),
      cliToken,
    );
    assert.equal(forbidden.status, 403, `status=${forbidden.status} body=${forbidden.text}`);
    assert.equal(forbidden.json?.code, "forbidden");
    assert.ok(!forbidden.text.includes(SECRET));
  });

  it("凭据不存在 / 密文无法解密返回可读 400，且不回显密文", async () => {
    const { baseUrl } = await startHost();
    const missing = await post(baseUrl, "reveal_service_credential", JSON.stringify({ id: "nope" }), ADMIN_TOKEN);
    assert.equal(missing.status, 400);
    assert.match(String(missing.json?.message ?? ""), /凭据不存在/);

    const broken = await post(baseUrl, "reveal_service_credential", JSON.stringify({ id: "cred-broken" }), ADMIN_TOKEN);
    assert.equal(broken.status, 400);
    assert.match(String(broken.json?.message ?? ""), /无法解密/);
    assert.ok(!broken.text.includes("garbage"));
  });

  it("缺 id 参数按参数校验失败处理", async () => {
    const { baseUrl } = await startHost();
    const bad = await post(baseUrl, "reveal_service_credential", JSON.stringify({}), ADMIN_TOKEN);
    assert.equal(bad.status, 400);
    assert.match(String(bad.json?.message ?? ""), /id/);
  });
});