// 桌面账号工作区命令（批次 2）契约测试。
//
// 覆盖：ChaCha20-Poly1305 信封 round-trip 与错误文案、状态/初始化/同步/导出/导入
// 的端到端流程（真实 SQLite + 内存 keyring + 本地假 S3 HTTP 服务）、参数校验。
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { dispatchDesktop } from "../commands.ts";
import {
  DEVICE_SYNC_CONFIG_META_KEY,
  DEVICE_SYNC_KEYRING_SERVICE,
  WORKSPACE_ETAG_META_KEY,
  WORKSPACE_KEYRING_SERVICE,
  decryptCatalog,
  encryptCatalog,
  type AccountWorkspaceCatalog,
  type DesktopAccountWorkspacePackage,
} from "../../services/account-workspace.ts";
import { parseS3ConfigInput, s3CredentialUsername } from "../../services/s3.ts";
import {
  createTestContext,
  sampleAccount,
  startFakeS3,
  type FakeS3,
  type TestContext,
} from "./support.ts";

const contexts: TestContext[] = [];
const servers: FakeS3[] = [];

function makeContext(prefix?: string): TestContext {
  const context = createTestContext({ prefix: prefix ?? "flowlet-account-workspace-" });
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) contexts.pop()?.cleanup();
  while (servers.length > 0) await servers.pop()?.close();
});

const API_KEY_A = "sk-workspace-alpha";
const API_KEY_B = "sk-workspace-beta";

/** 在存储层种入两个账号（真实 schema + 真实 SQLite）。 */
function seedAccounts(context: TestContext): void {
  context.storage.saveChannelAccounts([
    { ...sampleAccount("local-a"), api_key: API_KEY_A },
    { ...sampleAccount("local-b"), channel_id: "custom", api_key: API_KEY_B, priority: 2 },
  ]);
}

/** 模拟 device_sync 已保存 S3 配置：app_meta + keyring Secret。 */
function configureS3(context: TestContext, server: FakeS3, prefix = "flowlet-workspace-test"): void {
  const config = parseS3ConfigInput({
    endpoint: server.endpoint,
    region: "us-east-1",
    bucket: server.bucket,
    prefix,
    accessKeyId: "AKIATEST",
    secretAccessKey: "test-secret-key",
    pathStyle: true,
  });
  context.storage.setAppMeta(DEVICE_SYNC_CONFIG_META_KEY, JSON.stringify(config));
  context.host.keyring.set(
    `${DEVICE_SYNC_KEYRING_SERVICE}\u0000${s3CredentialUsername(config)}`,
    "test-secret-key",
  );
}

function readWorkspaceKeyBytes(context: TestContext, server: FakeS3): Buffer {
  const config = parseS3ConfigInput({
    endpoint: server.endpoint,
    region: "us-east-1",
    bucket: server.bucket,
    prefix: "flowlet-workspace-test",
    accessKeyId: "AKIATEST",
    secretAccessKey: "test-secret-key",
    pathStyle: true,
  });
  const raw =
    context.host.keyring.get(`${WORKSPACE_KEYRING_SERVICE}\u0000${s3CredentialUsername(config)}`) ??
    "";
  return Buffer.from(raw, "base64");
}

function workspaceObjectKey(server: FakeS3): string {
  return "flowlet-workspace-test/flowlet/v1/workspace/channel-accounts.enc";
}

describe("账号工作区加密信封", () => {
  const key = Buffer.alloc(32, 7);
  const catalog: AccountWorkspaceCatalog = {
    version: 1,
    revision: 3,
    updatedAt: "2026-08-03T00:00:00Z",
    accounts: [
      {
        id: "workspace-account-1",
        channelId: "custom",
        name: "Friday",
        apiKey: "secret-key",
        managementKey: "management-secret",
        defaultOpenaiBaseUrl: "https://public.example/v1",
        defaultAnthropicBaseUrl: null,
        credentialFingerprint: "fingerprint",
        archived: false,
        createdAt: "2026-08-03T00:00:00Z",
        updatedAt: "2026-08-03T00:00:00Z",
      },
    ],
  };

  it("ChaCha20-Poly1305 信封 round-trip 且不泄露明文密钥", () => {
    const encrypted = encryptCatalog(catalog, key);
    const text = Buffer.from(encrypted).toString("utf8");
    assert.ok(!text.includes("secret-key"));
    assert.ok(!text.includes("management-secret"));
    const envelope = JSON.parse(text) as Record<string, unknown>;
    assert.equal(envelope.format, "flowlet-account-workspace");
    assert.equal(envelope.version, 1);
    assert.deepEqual(Object.keys(envelope).sort(), ["ciphertext", "format", "nonce", "version"]);
    assert.equal(Buffer.from(String(envelope.nonce), "base64").length, 12);
    const decrypted = decryptCatalog(encrypted, key);
    assert.deepEqual(decrypted, catalog);
  });

  it("错误密钥解密返回 Rust 文案", () => {
    const encrypted = encryptCatalog(catalog, key);
    assert.throws(
      () => decryptCatalog(encrypted, Buffer.alloc(32, 8)),
      (error: unknown) =>
        (error as { message?: string }).message ===
        "账号工作区解密失败，请确认接入包来自同一工作区",
    );
  });

  it("损坏的信封格式返回 Rust 文案", () => {
    assert.throws(
      () => decryptCatalog(Buffer.from("not-json", "utf8"), key),
      (error: unknown) =>
        (error as { message?: string }).message === "账号工作区密文格式无效",
    );
    assert.throws(
      () =>
        decryptCatalog(
          Buffer.from(JSON.stringify({ format: "other", version: 1 }), "utf8"),
          key,
        ),
      (error: unknown) =>
        (error as { message?: string }).message === "账号工作区版本不受支持",
    );
  });
});

describe("账号工作区状态与导出", () => {
  it("未配置 S3 时 status 关闭、export/initialize 报「尚未配置 S3 同步」", async () => {
    const context = makeContext();
    assert.deepEqual(await dispatchDesktop(context.ctx, "get_account_workspace_status", {}), {
      enabled: false,
      linkedAccounts: 0,
    });
    await assert.rejects(
      () => dispatchDesktop(context.ctx, "export_desktop_account_workspace", {}),
      (error: unknown) =>
        (error as { message?: string }).message === "尚未配置 S3 同步",
    );
    await assert.rejects(
      () => dispatchDesktop(context.ctx, "initialize_account_workspace", {}),
      (error: unknown) =>
        (error as { message?: string }).message === "尚未配置 S3 同步",
    );
    await assert.rejects(
      () => dispatchDesktop(context.ctx, "sync_account_workspace", {}),
      (error: unknown) =>
        (error as { message?: string }).message === "尚未配置 S3 同步",
    );
  });
});

describe("账号工作区初始化 / 同步 / 导出 / 导入端到端", () => {
  it("initialize → status → 幂等 sync → export → import 到新设备", async () => {
    const server = await startFakeS3();
    servers.push(server);
    const context = makeContext();
    seedAccounts(context);
    configureS3(context, server);

    const initialized = (await dispatchDesktop(
      context.ctx,
      "initialize_account_workspace",
      {},
    )) as Record<string, unknown>;
    assert.deepEqual(initialized, {
      revision: 1,
      accountCount: 2,
      linkedAccounts: 2,
      createdLocalAccounts: 0,
      uploaded: true,
    });
    const workspaceKey = readWorkspaceKeyBytes(context, server);
    assert.equal(workspaceKey.length, 32);
    assert.equal(
      typeof context.storage.getAppMeta(WORKSPACE_ETAG_META_KEY),
      "string",
    );
    const accountsAfterInit = context.storage.listChannelAccounts();
    assert.ok(accountsAfterInit.every((account) => typeof account.workspace_account_id === "string"));
    assert.equal(server.getObject(workspaceObjectKey(server)) !== null, true);

    const status = (await dispatchDesktop(
      context.ctx,
      "get_account_workspace_status",
      {},
    )) as Record<string, unknown>;
    assert.deepEqual(status, { enabled: true, linkedAccounts: 2 });

    // 幂等：再次同步时目录未变化，不重复上传。
    const synced = (await dispatchDesktop(context.ctx, "sync_account_workspace", {})) as Record<
      string,
      unknown
    >;
    assert.deepEqual(synced, {
      revision: 1,
      accountCount: 2,
      linkedAccounts: 2,
      createdLocalAccounts: 0,
      uploaded: false,
    });

    const pkg = (await dispatchDesktop(
      context.ctx,
      "export_desktop_account_workspace",
      {},
    )) as DesktopAccountWorkspacePackage;
    assert.equal(pkg.format, "flowlet-desktop-account-workspace");
    assert.equal(pkg.version, 1);
    assert.equal(pkg.s3.endpoint, server.endpoint);
    assert.equal(pkg.s3.secretAccessKey, "test-secret-key");
    assert.equal(Buffer.from(pkg.accountWorkspaceKey, "base64").length, 32);

    // 新设备：空库 + 空 keyring，导入接入包后立即同步。
    const other = makeContext("flowlet-account-workspace-import-");
    const imported = (await dispatchDesktop(other.ctx, "import_desktop_account_workspace", {
      package: pkg,
    })) as Record<string, unknown>;
    assert.deepEqual(imported, {
      revision: 1,
      accountCount: 2,
      linkedAccounts: 0,
      createdLocalAccounts: 2,
      uploaded: false,
    });
    const importedAccounts = other.storage.listChannelAccounts();
    assert.equal(importedAccounts.length, 2);
    assert.deepEqual(
      importedAccounts.map((account) => account.api_key).sort(),
      [API_KEY_A, API_KEY_B].sort(),
    );
    assert.equal(
      typeof other.storage.getAppMeta(DEVICE_SYNC_CONFIG_META_KEY),
      "string",
    );
    assert.deepEqual(await dispatchDesktop(other.ctx, "get_account_workspace_status", {}), {
      enabled: true,
      linkedAccounts: 2,
    });
  });

  it("initialize 在远端已有工作区时拒绝加入", async () => {
    const server = await startFakeS3();
    servers.push(server);
    const first = makeContext("flowlet-account-workspace-first-");
    seedAccounts(first);
    configureS3(first, server);
    await dispatchDesktop(first.ctx, "initialize_account_workspace", {});

    const second = makeContext("flowlet-account-workspace-second-");
    seedAccounts(second);
    configureS3(second, server);
    await assert.rejects(
      () => dispatchDesktop(second.ctx, "initialize_account_workspace", {}),
      (error: unknown) =>
        (error as { message?: string }).message ===
        "远端已存在账号工作区，请导入桌面端工作区接入包后加入",
    );
  });

  it("导入接入包校验版本 / 密钥长度 / Secret", async () => {
    const server = await startFakeS3();
    servers.push(server);
    const context = makeContext();
    const base = {
      format: "flowlet-desktop-account-workspace",
      version: 1,
      s3: {
        endpoint: server.endpoint,
        region: "us-east-1",
        bucket: server.bucket,
        prefix: "missing-prefix",
        accessKeyId: "AKIATEST",
        secretAccessKey: "test-secret-key",
        pathStyle: true,
      },
      accountWorkspaceKey: Buffer.alloc(32, 1).toString("base64"),
    };
    await assert.rejects(
      () =>
        dispatchDesktop(context.ctx, "import_desktop_account_workspace", {
          package: { ...base, format: "other" },
        }),
      (error: unknown) =>
        (error as { message?: string }).message ===
        "桌面端账号工作区接入包版本不受支持",
    );
    await assert.rejects(
      () =>
        dispatchDesktop(context.ctx, "import_desktop_account_workspace", {
          package: { ...base, accountWorkspaceKey: Buffer.alloc(16, 1).toString("base64") },
        }),
      (error: unknown) =>
        (error as { message?: string }).message === "桌面端账号工作区密钥长度无效",
    );
    await assert.rejects(
      () =>
        dispatchDesktop(context.ctx, "import_desktop_account_workspace", {
          package: { ...base, s3: { ...base.s3, secretAccessKey: "  " } },
        }),
      (error: unknown) =>
        (error as { message?: string }).message ===
        "桌面端账号工作区接入包缺少 S3 Secret Access Key",
    );
    await assert.rejects(
      () =>
        dispatchDesktop(context.ctx, "import_desktop_account_workspace", {
          package: { ...base, s3: { ...base.s3, endpoint: "" } },
        }),
      (error: unknown) => (error as { message?: string }).message === "S3 Endpoint 格式无效",
    );
    // 缺少 package 参数 / 结构字段时返回参数错误。
    await assert.rejects(
      () => dispatchDesktop(context.ctx, "import_desktop_account_workspace", {}),
      (error: unknown) => (error as { status?: number }).status === 400,
    );
    await assert.rejects(
      () =>
        dispatchDesktop(context.ctx, "import_desktop_account_workspace", {
          package: { format: base.format, version: 1 },
        }),
      (error: unknown) =>
        String((error as { message?: string }).message).includes(
          "参数 package: missing field `s3`",
        ),
    );
  });

  it("远端目录被其他设备更新后 sync 会合并并上传新版本", async () => {
    const server = await startFakeS3();
    servers.push(server);
    const context = makeContext();
    seedAccounts(context);
    configureS3(context, server);
    await dispatchDesktop(context.ctx, "initialize_account_workspace", {});

    // 模拟另一台设备往远端目录追加一个账号（用同一把工作区密钥加密）。
    const key = readWorkspaceKeyBytes(context, server);
    const current = decryptCatalog(server.getObject(workspaceObjectKey(server)) as Buffer, key);
    current.accounts.push({
      id: "remote-added",
      channelId: "custom",
      name: "Remote Added",
      apiKey: "sk-remote-added",
      managementKey: null,
      defaultOpenaiBaseUrl: null,
      defaultAnthropicBaseUrl: null,
      credentialFingerprint: "remote-fingerprint",
      archived: false,
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
    });
    current.revision += 1;
    server.putObject(workspaceObjectKey(server), Buffer.from(encryptCatalog(current, key)));

    const synced = (await dispatchDesktop(context.ctx, "sync_account_workspace", {})) as Record<
      string,
      unknown
    >;
    assert.deepEqual(synced, {
      revision: 2,
      accountCount: 3,
      linkedAccounts: 2,
      createdLocalAccounts: 1,
      uploaded: false,
    });
    const accounts = context.storage.listChannelAccounts();
    assert.equal(accounts.length, 3);
    assert.ok(accounts.some((account) => account.api_key === "sk-remote-added"));
  });
});