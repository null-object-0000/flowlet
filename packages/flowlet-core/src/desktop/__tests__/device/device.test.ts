// 桌面跨设备同步命令测试（23 条）。Owner: desktop-device。
//
// 运行：node --test packages/flowlet-core/src/desktop
// 覆盖：
// - 设备目录 / 日 / 小时 / 会话返回形状（camelCase、isCurrent 语义）；
// - rename_current_device 原子写 flowlet-device.json 与名称校验；
// - S3 配置：校验失败不落库、Secret 只进 OS 凭据库、settings/export 脱敏；
// - S3 网络：本地 mock HTTP 服务器上的连接测试、上传/拉取、幂等刷新、recover；
// - bundle 导出 / 预览 / 导入（去重 + 幂等 + 拒绝导入当前设备）；
// - LAN：加密信封 AAD 绑定、端点校验、ping 探测与 LAN 刷新（无内网地址时跳过）。
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { randomUUID } from "node:crypto";

import { SqliteStorage } from "../../../storage/index.ts";
import { setAppMeta } from "../../../storage/config.ts";
import * as lanStore from "../../../storage/lan.ts";
import { desktopCommandNames } from "../../commands.ts";
import { handlers, resetSyncLeaseForTests } from "../../device.ts";
import type { DesktopContext } from "../../types.ts";
import type { DeviceIdentity } from "../../../types.ts";
import {
  candidateLanAddresses,
  decryptLanPayload,
  encryptLanPayload,
  validateLanEndpoint,
} from "../../../device/lan.ts";
import {
  BUNDLE_FORMAT,
  newDeviceUsageBundle,
  newDeviceUsageSnapshot,
  parseBundleBytes,
  type DeviceUsageBundle,
  type DeviceUsageSnapshot,
} from "../../../device/bundle.ts";
import { shutdownLanServerForTests } from "../../../device/lan.ts";

const cleanupDirs: string[] = [];
const cleanupServers: Server[] = [];

after(async () => {
  await shutdownLanServerForTests();
  for (const server of cleanupServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

// ─── 测试上下文 ─────────────────────────────────────────────────────────────

interface KeyringPayload {
  service?: string;
  username?: string;
  secret?: string;
}

interface FakeHost {
  invoke<T = unknown>(channel: string, payload?: Record<string, unknown>): Promise<T>;
  readonly secrets: Map<string, string>;
}

function createFakeHost(): FakeHost {
  const secrets = new Map<string, string>();
  return {
    secrets,
    async invoke<T = unknown>(channel: string, payload?: Record<string, unknown>): Promise<T> {
      const body = (payload ?? {}) as KeyringPayload;
      const key = `${body.service ?? ""}\0${body.username ?? ""}`;
      if (channel === "keyring.get") {
        return { secret: secrets.get(key) ?? null } as unknown as T;
      }
      if (channel === "keyring.set") {
        if (typeof body.secret !== "string" || body.secret === "") {
          throw new Error("secret 不能为空");
        }
        secrets.set(key, body.secret);
        return null as unknown as T;
      }
      if (channel === "keyring.delete") {
        secrets.delete(key);
        return null as unknown as T;
      }
      throw new Error(`未实现的宿主 channel：${channel}`);
    },
  };
}

interface TestContext {
  dir: string;
  storage: SqliteStorage;
  host: FakeHost;
  ctx: DesktopContext;
  identity: DeviceIdentity;
}

function createTestContext(options: { dataDir?: string } = {}): TestContext {
  const dir = options.dataDir ?? mkdtempSync(path.join(tmpdir(), "flowlet-device-test-"));
  if (options.dataDir === undefined) cleanupDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  const storage = new SqliteStorage(":memory:");
  const identity: DeviceIdentity = {
    schema_version: 1,
    device_id: "11111111-1111-4111-8111-111111111111",
    created_at: "2026-01-01T00:00:00.000Z",
    display_name: "Test PC",
    platform: "linux",
    app_version: "0.2.0",
  };
  writeFileSync(
    path.join(dir, "flowlet-device.json"),
    `${JSON.stringify(
      {
        schemaVersion: identity.schema_version,
        deviceId: identity.device_id,
        createdAt: identity.created_at,
        displayName: identity.display_name,
        platform: identity.platform,
      },
      null,
      2,
    )}\n`,
  );
  const host = createFakeHost();
  const ctx = {
    storage,
    proxy: {
      start: async () => undefined,
      stop: async () => undefined,
      status: () => ({ running: false, bind_addr: "127.0.0.1:0", started_at: null }),
      bindConfig: () => ({
        host: "127.0.0.1",
        port: 0,
        allow_lan: false,
        default_client_token: "test",
      }),
      setBindConfig: () => undefined,
    },
    runtimeConfig: {
      snapshot: () => ({}),
      replace: () => undefined,
      update: () => undefined,
    },
    catalogDir: dir,
    configPath: path.join(dir, "config.json"),
    adminToken: "admin-token",
    clientToken: "client-token",
    staticDir: dir,
    publicProxyUrl: "",
    deviceIdentity: identity,
    config: {},
    channelsConfig: {},
    logCapture: { enabled: false, capture_request_body: false, capture_response_body: false },
    upstreamProxy: { enabled: false, url: "" },
    secrets: {
      encrypt: (plaintext: string) => `v1:${Buffer.from(plaintext, "utf8").toString("base64")}`,
      decrypt: (encoded: string) =>
        Buffer.from(encoded.replace(/^v1:/, ""), "base64").toString("utf8"),
    },
    cliAuth: {} as unknown as DesktopContext["cliAuth"],
    desktop: {
      host,
      appVersion: "0.2.0",
      dataDir: dir,
      portable: true,
    },
  } as unknown as DesktopContext;
  return { dir, storage, host, ctx, identity };
}

async function invoke(
  ctx: DesktopContext,
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const handler = handlers[command];
  assert.ok(handler !== undefined, `命令未注册：${command}`);
  return handler(ctx, args);
}

// ─── 测试数据构造 ───────────────────────────────────────────────────────────

function makeBundle(overrides: {
  deviceId?: string;
  createdAt?: string;
  generatedAt?: string;
  displayName?: string;
  platform?: string;
  days?: DeviceUsageBundle["snapshot"]["days"];
  sessions?: DeviceUsageBundle["snapshot"]["sessions"];
  lanPeer?: DeviceUsageBundle["snapshot"]["lanPeer"];
} = {}): DeviceUsageBundle {
  const snapshot: DeviceUsageSnapshot = {
    schemaVersion: 13,
    deviceId: overrides.deviceId ?? randomUUID(),
    deviceCreatedAt: overrides.createdAt ?? "2026-02-01T00:00:00.000Z",
    displayName: overrides.displayName ?? "Remote PC",
    platform: overrides.platform ?? "windows",
    appVersion: "0.2.0",
    generatedAt: overrides.generatedAt ?? "2026-02-02T00:00:00.000Z",
    timezoneOffsetMinutes: 480,
    days: overrides.days ?? [],
    hours: [],
    sessions: overrides.sessions ?? [],
    agents: [],
    lanPeer: overrides.lanPeer ?? null,
    usageBreakdowns: [],
    accountResources: [],
  };
  return { format: BUNDLE_FORMAT, version: 1, snapshot };
}

function makeDay(date: string, requestCount: number) {
  return {
    date,
    requestCount,
    knownTokens: requestCount * 10,
    inputTokens: requestCount * 6,
    inputCachedTokens: 0,
    inputUncachedTokens: requestCount * 6,
    cacheMeasuredInputTokens: 0,
    outputTokens: requestCount * 4,
    unknownCount: 0,
    estimatedCost: 0,
    nativeEventCount: 0,
    nativeInputTokens: 0,
    nativeCachedInputTokens: 0,
    nativeCacheWriteInputTokens: 0,
    nativeOutputTokens: 0,
    nativeReasoningTokens: 0,
    nativeTotalTokens: 0,
  };
}

const REQUIRED_S3 = {
  endpoint: "https://example.com",
  region: "auto",
  bucket: "flowlet-sync",
  prefix: "users/demo",
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
  pathStyle: true,
};

// ─── 本地 S3 mock ───────────────────────────────────────────────────────────

interface MockObject {
  body: Buffer;
  etag: string;
}

interface MockS3 {
  endpoint: string;
  objects: Map<string, MockObject>;
  requests: Array<{ method: string; path: string; authorization: string | null }>;
}

async function startMockS3(bucket: string): Promise<MockS3> {
  const objects = new Map<string, MockObject>();
  const requests: MockS3["requests"] = [];
  let tag = 1;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);
      requests.push({
        method: request.method ?? "GET",
        path: pathname,
        authorization:
          typeof request.headers.authorization === "string" ? request.headers.authorization : null,
      });
      const bucketRoot = `/${bucket}`;
      const key = pathname.startsWith(`${bucketRoot}/`)
        ? pathname.slice(bucketRoot.length + 1)
        : null;
      if (request.method === "HEAD") {
        if (key === null) {
          response.writeHead(200).end();
          return;
        }
        const object = objects.get(key);
        if (object === undefined) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { etag: object.etag }).end();
        return;
      }
      if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const entries = [...objects.entries()].filter(([keyName]) => keyName.startsWith(prefix));
        const contents = entries
          .map(
            ([keyName, object]) =>
              `<Contents><Key>${keyName}</Key><ETag>${object.etag}</ETag><Size>${object.body.byteLength}</Size></Contents>`,
          )
          .join("");
        writeXml(
          response,
          200,
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        );
        return;
      }
      if (request.method === "GET") {
        if (key === null) {
          response.writeHead(200).end();
          return;
        }
        const object = objects.get(key);
        if (object === undefined) {
          writeXml(response, 404, "<Error><Code>NoSuchKey</Code></Error>");
          return;
        }
        response.writeHead(200, {
          "content-length": String(object.body.byteLength),
          etag: object.etag,
        });
        response.end(object.body);
        return;
      }
      if (request.method === "PUT") {
        if (key === null) {
          response.writeHead(400).end();
          return;
        }
        const ifMatch = request.headers["if-match"];
        const existing = objects.get(key);
        if (
          typeof ifMatch === "string" &&
          existing !== undefined &&
          ifMatch.replace(/^"|"$/g, "") !== existing.etag.replace(/^"|"$/g, "")
        ) {
          writeXml(response, 412, "<Error><Code>PreconditionFailed</Code></Error>");
          return;
        }
        const etag = `"etag-${tag}"`;
        tag += 1;
        objects.set(key, { body, etag });
        response.writeHead(200, { etag }).end();
        return;
      }
      if (request.method === "DELETE") {
        if (key !== null) objects.delete(key);
        response.writeHead(204).end();
        return;
      }
      response.writeHead(405).end();
    });
  });
  cleanupServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { endpoint: `http://127.0.0.1:${address.port}`, objects, requests };
}

function writeXml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "application/xml" });
  response.end(body);
}

// ─── 设备目录 / 用量 / 会话 ────────────────────────────────────────────────

describe("设备目录与用量", () => {
  it("list_shared_devices / daily / hourly / sessions 返回 camelCase 形状且 isCurrent=false", async () => {
    const { ctx } = createTestContext();
    const bundle = makeBundle({
      days: [makeDay("2026-02-01", 2), makeDay("2026-02-02", 3)],
      sessions: [
        {
          agentType: "claude-code",
          sessionId: "session-1",
          parentSessionId: null,
          runtimeStatus: "running",
          title: "远程会话",
          clientName: "Claude Code",
          activityAt: "2026-02-02T00:00:00Z",
          flowletObserved: true,
          requestCount: 5,
          errorCount: 0,
          knownTokens: 50,
          nativeTurnCount: null,
          nativeTotalTokens: null,
          nativeTruncated: false,
          lastInteraction: null,
        },
      ],
    });
    const file = path.join((ctx.desktop as unknown as { dataDir: string }).dataDir, "remote.json");
    writeFileSync(file, JSON.stringify(bundle));
    await invoke(ctx, "import_device_usage_bundle", { path: file });

    const devices = (await invoke(ctx, "list_shared_devices")) as Array<Record<string, unknown>>;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].deviceId, bundle.snapshot.deviceId);
    assert.equal(devices[0].isCurrent, false);
    assert.equal(devices[0].displayName, "Remote PC");
    assert.equal(devices[0].timezoneOffsetMinutes, 480);
    assert.equal(devices[0].dayCount, 2);
    assert.equal(devices[0].requestCount, 5);

    const days = (await invoke(ctx, "shared_device_daily_usage", {
      deviceId: bundle.snapshot.deviceId,
    })) as Array<Record<string, unknown>>;
    assert.deepEqual(days.map((day) => day.date), ["2026-02-01", "2026-02-02"]);
    assert.equal(days[1].requestCount, 3);
    assert.equal(days[1].knownTokens, 30);
    assert.equal(days[1].nativeTotalTokens, 0);
    assert.equal("usage_date" in days[1], false);

    const hours = (await invoke(ctx, "shared_device_hourly_usage", {
      deviceId: bundle.snapshot.deviceId,
    })) as unknown[];
    assert.deepEqual(hours, []);

    const sessions = (await invoke(ctx, "list_shared_device_sessions", {
      deviceId: bundle.snapshot.deviceId,
    })) as Array<Record<string, unknown>>;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].deviceId, bundle.snapshot.deviceId);
    assert.equal(sessions[0].deviceDisplayName, "Remote PC");
    assert.equal(sessions[0].devicePlatform, "windows");
    assert.equal(sessions[0].agentType, "claude-code");
    assert.equal(sessions[0].runtimeStatus, "running");
    assert.equal(sessions[0].title, "远程会话");
  });

  it("device_usage_snapshot 返回 schema v13 快照与当前设备身份", async () => {
    const { ctx, identity } = createTestContext();
    const snapshot = (await invoke(ctx, "device_usage_snapshot")) as DeviceUsageSnapshot;
    assert.equal(snapshot.schemaVersion, 13);
    assert.equal(snapshot.deviceId, identity.device_id);
    assert.equal(snapshot.deviceCreatedAt, identity.created_at);
    assert.equal(snapshot.displayName, identity.display_name);
    assert.equal(snapshot.platform, identity.platform);
    assert.equal(snapshot.appVersion, "0.2.0");
    assert.ok(Number.isInteger(snapshot.timezoneOffsetMinutes));
    assert.deepEqual(snapshot.days, []);
    assert.deepEqual(snapshot.hours, []);
    assert.deepEqual(snapshot.sessions, []);
    assert.deepEqual(snapshot.agents, []);
    assert.deepEqual(snapshot.accountResources, []);
  });

  it("rename_current_device 原子更新身份文件且拒绝非法名称", async () => {
    const { ctx, identity, dir } = createTestContext();
    await invoke(ctx, "rename_current_device", { displayName: "  公司笔记本  " });
    const saved = JSON.parse(readFileSync(path.join(dir, "flowlet-device.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(saved.displayName, "公司笔记本");
    assert.equal(saved.deviceId, identity.device_id);
    assert.equal(identity.display_name, "公司笔记本");

    await assert.rejects(
      async () => invoke(ctx, "rename_current_device", { displayName: "x".repeat(65) }),
      /名称不能超过 64 个字符/,
    );
    const afterFailure = JSON.parse(
      readFileSync(path.join(dir, "flowlet-device.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(afterFailure.displayName, "公司笔记本");
  });
});

// ─── S3 配置 ────────────────────────────────────────────────────────────────

describe("S3 配置", () => {
  it("未配置时返回 never 状态与 null config", async () => {
    const { ctx } = createTestContext();
    const settings = (await invoke(ctx, "get_s3_sync_settings")) as Record<string, unknown>;
    assert.equal(settings.config, null);
    const status = settings.status as Record<string, unknown>;
    assert.equal(status.status, "never");
    assert.equal(status.message, "尚未同步");
    assert.equal(status.lastAttemptAt, null);
    assert.equal(status.failedObjects, 0);
  });

  it("校验失败不落库：远程 HTTP endpoint 拒绝且 app_meta 保持为空", async () => {
    const { ctx, storage } = createTestContext();
    await assert.rejects(
      async () =>
        invoke(ctx, "save_s3_sync_config", {
          config: { ...REQUIRED_S3, endpoint: "http://example.com" },
        }),
      /必须使用 HTTPS/,
    );
    assert.equal(
      storage.getAppMeta("device_sync_s3_config_v1"),
      null,
      "校验失败时不得写入配置",
    );
    await assert.rejects(
      async () =>
        invoke(ctx, "save_s3_sync_config", {
          config: { ...REQUIRED_S3, bucket: "ab" },
        }),
      /Bucket 长度必须为 3–63/,
    );
    const invalid = { ...REQUIRED_S3 } as Record<string, unknown>;
    delete invalid.region;
    await assert.rejects(
      async () => invoke(ctx, "save_s3_sync_config", { config: invalid }),
      /参数 config: missing field `region`/,
    );
    assert.equal(storage.getAppMeta("device_sync_s3_config_v1"), null);
  });

  it("save/get/export：Secret 只写 OS 凭据库，落库配置不含 Secret", async () => {
    const { ctx, storage, host } = createTestContext();
    const settings = (await invoke(ctx, "save_s3_sync_config", {
      config: REQUIRED_S3,
    })) as Record<string, unknown>;
    const view = settings.config as Record<string, unknown>;
    assert.equal(view.endpoint, "https://example.com");
    assert.equal(view.prefix, "users/demo");
    assert.equal(view.secretConfigured, true);
    assert.equal("secretAccessKey" in view, false);

    const raw = storage.getAppMeta("device_sync_s3_config_v1");
    assert.ok(raw !== null);
    assert.equal(raw.includes("secret-key"), false, "SQLite 中不得出现 S3 Secret");
    assert.equal(host.secrets.size, 1);

    const exported = (await invoke(ctx, "export_s3_connection_config")) as Record<string, unknown>;
    assert.equal(exported.secretAccessKey, "secret-key");
    assert.equal(exported.accessKeyId, "access-key");

    // 不传 Secret 保存新 endpoint：需要新身份已有凭据，否则拒绝且不覆盖旧配置。
    await assert.rejects(
      async () =>
        invoke(ctx, "save_s3_sync_config", {
          config: { ...REQUIRED_S3, endpoint: "https://other.example.com", secretAccessKey: null },
        }),
      /未找到 S3 Secret Access Key/,
    );
    assert.equal(storage.getAppMeta("device_sync_s3_config_v1"), raw);
  });
});

// ─── S3 网络（本地 mock） ──────────────────────────────────────────────────

describe("S3 连接测试与设备同步", () => {
  it("test_s3_sync_connection / test_s3_read_connection / sync / refresh / recover", async () => {
    const mock = await startMockS3("flowlet-sync");
    const { ctx, storage } = createTestContext();
    await invoke(ctx, "save_s3_sync_config", {
      config: { ...REQUIRED_S3, endpoint: mock.endpoint, secretAccessKey: "secret-key" },
    });

    const testResult = (await invoke(ctx, "test_s3_sync_connection", {
      config: { ...REQUIRED_S3, endpoint: mock.endpoint },
    })) as Record<string, unknown>;
    assert.equal(testResult.message, "连接、列举、写入、读取和删除权限均正常");
    assert.ok(
      mock.requests.every(
        (request) =>
          request.authorization !== null &&
          request.authorization.startsWith("AWS4-HMAC-SHA256 Credential="),
      ),
      "所有 S3 请求都必须带 SigV4 Authorization 头",
    );

    const readResult = (await invoke(ctx, "test_s3_read_connection", {
      config: { ...REQUIRED_S3, endpoint: mock.endpoint },
    })) as Record<string, unknown>;
    assert.match(String(readResult.message), /Bucket/);

    const firstSync = (await invoke(ctx, "sync_device_usage_s3")) as Record<string, unknown>;
    const uploadedKey = `users/demo/flowlet/v1/devices/${ctx.deviceIdentity.device_id}/snapshot.json`;
    assert.equal(firstSync.uploadedKey, uploadedKey);
    assert.equal(firstSync.remoteDevices, 0);
    assert.equal(firstSync.failedObjects, 0);
    assert.ok(Number(firstSync.uploadedBytes) > 0);
    assert.ok(mock.objects.has(uploadedKey));
    parseBundleBytes(mock.objects.get(uploadedKey)?.body ?? Buffer.alloc(0));

    const settings = (await invoke(ctx, "get_s3_sync_settings")) as Record<string, unknown>;
    assert.equal((settings.status as Record<string, unknown>).status, "success");

    // 远端设备快照 → 强制 S3 pull 导入。
    const remoteBundle = makeBundle({
      generatedAt: "2026-02-03T00:00:00.000Z",
      days: [makeDay("2026-02-01", 4)],
    });
    const remoteKey = `users/demo/flowlet/v1/devices/${remoteBundle.snapshot.deviceId}/snapshot.json`;
    mock.objects.set(remoteKey, {
      body: Buffer.from(JSON.stringify(remoteBundle), "utf8"),
      etag: '"remote-1"',
    });
    const pull = (await invoke(ctx, "refresh_shared_device_usage_s3")) as Record<string, unknown>;
    // Rust pull_device_usage 不排除本机对象：本机快照也会被重新导入一次。
    assert.equal(pull.remoteDevices, 2);
    assert.equal(pull.importedDevices, 2);
    assert.equal(pull.importedDays, 1);
    assert.equal(pull.failedObjects, 0);

    const devices = (await invoke(ctx, "list_shared_devices")) as Array<Record<string, unknown>>;
    assert.ok(devices.some((device) => device.deviceId === remoteBundle.snapshot.deviceId));

    // 幂等：相同 generatedAt 再拉取，不计入新增/更新。
    const secondPull = (await invoke(ctx, "refresh_shared_device_usage_s3")) as Record<
      string,
      unknown
    >;
    assert.equal(secondPull.importedDays, 0);
    assert.equal(secondPull.unchangedDays, 1);
    assert.equal(secondPull.importedDevices, 2);

    // recover：远端当前设备快照 deviceId / createdAt 与身份文件一致。
    const recover = (await invoke(ctx, "recover_current_device_sync")) as Record<string, unknown>;
    assert.equal(recover.message, "已恢复当前设备的云端同步所有权");
    resetSyncLeaseForTests();
    assert.ok(storage.getAppMeta("device_sync_s3_current_etag_v1") !== null);
  });

  it("refresh_shared_device 在没有 LAN 信息时回退到 S3 单设备对象", async () => {
    const mock = await startMockS3("flowlet-sync");
    const { ctx } = createTestContext();
    await invoke(ctx, "save_s3_sync_config", {
      config: { ...REQUIRED_S3, endpoint: mock.endpoint, secretAccessKey: "secret-key" },
    });
    const remoteBundle = makeBundle({ days: [makeDay("2026-02-05", 1)] });
    const remoteKey = `users/demo/flowlet/v1/devices/${remoteBundle.snapshot.deviceId}/snapshot.json`;
    mock.objects.set(remoteKey, {
      body: Buffer.from(JSON.stringify(remoteBundle), "utf8"),
      etag: '"remote-2"',
    });
    const result = (await invoke(ctx, "refresh_shared_device", {
      deviceId: remoteBundle.snapshot.deviceId,
    })) as Record<string, unknown>;
    assert.equal(result.source, "s3");
    assert.equal(result.refreshedDevices, 1);
    resetSyncLeaseForTests();
  });
});

// ─── bundle 导出 / 预览 / 导入 ─────────────────────────────────────────────

describe("用量 bundle 导出 / 预览 / 导入", () => {
  it("导出当前设备快照，预览标记 sameAsCurrentDevice，并拒绝自我导入", async () => {
    const { ctx, dir } = createTestContext();
    const file = path.join(dir, "exported.json");
    await invoke(ctx, "export_device_usage_bundle", { path: file });
    assert.ok(existsSync(file));
    const bundle = parseBundleBytes(readFileSync(file));
    assert.equal(bundle.format, BUNDLE_FORMAT);
    assert.equal(bundle.snapshot.deviceId, ctx.deviceIdentity.device_id);

    const preview = (await invoke(ctx, "preview_device_usage_import", { path: file })) as Record<
      string,
      unknown
    >;
    assert.equal(preview.sameAsCurrentDevice, true);
    assert.equal(preview.deviceId, ctx.deviceIdentity.device_id);
    assert.equal(preview.dayCount, 0);
    await assert.rejects(
      async () => invoke(ctx, "import_device_usage_bundle", { path: file }),
      /不能把当前设备的用量重新导入为远程设备/,
    );
  });

  it("预览差异 + 导入去重/幂等 + 非法 bundle 被拒绝", async () => {
    const { ctx, dir } = createTestContext();
    const remote = makeBundle({
      days: [makeDay("2026-02-01", 2), makeDay("2026-02-02", 5)],
    });
    const file = path.join(dir, "remote-bundle.json");
    writeFileSync(file, JSON.stringify(remote, null, 2));

    const preview = (await invoke(ctx, "preview_device_usage_import", { path: file })) as Record<
      string,
      unknown
    >;
    assert.equal(preview.sameAsCurrentDevice, false);
    assert.equal(preview.dayCount, 2);
    assert.equal(preview.newDays, 2);
    assert.equal(preview.updatedDays, 0);
    assert.equal(preview.firstDate, "2026-02-01");
    assert.equal(preview.lastDate, "2026-02-02");

    const imported = (await invoke(ctx, "import_device_usage_bundle", { path: file })) as Record<
      string,
      unknown
    >;
    assert.deepEqual(imported, {
      deviceId: remote.snapshot.deviceId,
      importedDays: 0,
      unchangedDays: 0,
    });

    const secondPreview = (await invoke(ctx, "preview_device_usage_import", {
      path: file,
    })) as Record<string, unknown>;
    assert.equal(secondPreview.newDays, 0);
    assert.equal(secondPreview.unchangedDays, 2);

    // 旧 generatedAt 的快照不得覆盖较新的导入结果。
    const older = makeBundle({
      deviceId: remote.snapshot.deviceId,
      createdAt: remote.snapshot.deviceCreatedAt,
      generatedAt: "2026-01-01T00:00:00.000Z",
      days: [makeDay("2026-02-01", 99)],
    });
    const olderFile = path.join(dir, "older-bundle.json");
    writeFileSync(olderFile, JSON.stringify(older));
    const olderPreview = (await invoke(ctx, "preview_device_usage_import", {
      path: olderFile,
    })) as Record<string, unknown>;
    assert.equal(olderPreview.updatedDays, 0);
    assert.equal(olderPreview.unchangedDays, 1);

    const days = (await invoke(ctx, "shared_device_daily_usage", {
      deviceId: remote.snapshot.deviceId,
    })) as Array<Record<string, unknown>>;
    assert.equal(days[0].requestCount, 2, "旧快照不得覆盖新的日用量");

    const invalid = makeBundle({
      days: [makeDay("2026-02-02", 1), makeDay("2026-02-01", 1)],
    });
    const invalidFile = path.join(dir, "invalid-bundle.json");
    writeFileSync(invalidFile, JSON.stringify(invalid));
    await assert.rejects(
      async () => invoke(ctx, "preview_device_usage_import", { path: invalidFile }),
      /必须严格递增/,
    );
  });
});

// ─── LAN ────────────────────────────────────────────────────────────────────

describe("局域网同步", () => {
  it("加密信封绑定请求 nonce（AAD）且端点校验只接受内网 IP", () => {
    const key = Buffer.alloc(32, 7);
    const payload = encryptLanPayload(key, Buffer.from("nonce-a"), { hello: "world" });
    assert.equal(Buffer.from(payload.nonce, "base64").byteLength, 12);
    assert.deepEqual(
      decryptLanPayload(key, Buffer.from("nonce-a"), payload),
      { hello: "world" },
    );
    assert.throws(
      () => decryptLanPayload(key, Buffer.from("nonce-b"), payload),
      /认证失败/,
    );

    assert.doesNotThrow(() => validateLanEndpoint("http://192.168.1.8:17878"));
    assert.doesNotThrow(() => validateLanEndpoint("http://10.0.0.2:17878"));
    assert.throws(() => validateLanEndpoint("http://127.0.0.1:17878"), /内网地址范围/);
    assert.throws(() => validateLanEndpoint("http://169.254.169.254:80"), /内网地址范围/);
    assert.throws(() => validateLanEndpoint("https://192.168.1.8:17878"), /格式无效/);
    assert.throws(() => validateLanEndpoint("http://example.com:17878"), /内网 IP/);
  });

  it("lan_server_status / probe_lan_peers / refresh_shared_device_usage_lan 走真实 LAN 握手", async (t) => {
    if ((await candidateLanAddresses()).length === 0) {
      t.skip("当前环境没有可发布的私网地址");
      return;
    }
    // 模块级 LAN 运行时是进程单例：先关闭上一个用例启动的实例，保证本用例的
    // DB 里能写入自己的 descriptor（生产环境中单进程只有一份 DB）。
    await shutdownLanServerForTests();
    const { ctx, storage } = createTestContext();
    const report = (await invoke(ctx, "lan_server_status")) as {
      status: { running: boolean; endpoints: string[]; error: string | null };
      inbound: unknown[];
    };
    assert.equal(report.status.running, true);
    assert.ok(report.status.endpoints.length > 0);
    assert.equal(report.status.error, null);

    // 快照命令会把 lanPeer 描述符写进快照。
    const snapshot = (await invoke(ctx, "device_usage_snapshot")) as DeviceUsageSnapshot;
    assert.ok(snapshot.lanPeer !== null);
    assert.equal(snapshot.lanPeer.protocolVersion, 1);
    assert.ok(snapshot.lanPeer.capabilities.includes("snapshot.read"));
    assert.equal(Buffer.from(snapshot.lanPeer.authKey, "base64").byteLength, 32);

    // 把本机服务登记成 peer，验证 probe 与 LAN 刷新。
    storage.withDatabase((db) => {
      lanStore.savePeerRegistry(db, {
        [ctx.deviceIdentity.device_id]: snapshot.lanPeer!,
      });
    });
    const probes = (await invoke(ctx, "probe_lan_peers", {})) as Array<Record<string, unknown>>;
    assert.equal(probes.length, 1);
    assert.equal(probes[0].deviceId, ctx.deviceIdentity.device_id);
    assert.equal(probes[0].lanPublished, true);
    assert.equal(probes[0].reachable, true);
    assert.equal(probes[0].protocolVersion, 1);
    assert.equal(probes[0].error, null);

    const refresh = (await invoke(ctx, "refresh_shared_device_usage_lan", {})) as Record<
      string,
      unknown
    >;
    assert.equal(refresh.attemptedDevices, 1);
    assert.equal(refresh.refreshedDevices, 1);
    assert.equal(refresh.failedDevices, 0);

    const statusReport = (await invoke(ctx, "lan_server_status")) as {
      inbound: Array<Record<string, unknown>>;
    };
    assert.ok(statusReport.inbound.length > 0);
    assert.ok(
      statusReport.inbound.some((event) => event.path === "/flowlet/v1/ping"),
      "入站事件应包含 ping",
    );
  });
});
// ─── 命令注册 ───────────────────────────────────────────────────────────────

describe("desktop device 命令注册表", () => {
  it("23 条跨设备同步命令全部注册", () => {
    const names = [
      "device_usage_snapshot",
      "list_shared_devices",
      "shared_device_daily_usage",
      "shared_device_hourly_usage",
      "list_shared_device_sessions",
      "refresh_shared_device",
      "rename_current_device",
      "get_s3_sync_settings",
      "export_s3_connection_config",
      "save_s3_sync_config",
      "test_s3_sync_connection",
      "test_s3_read_connection",
      "sync_device_usage_s3",
      "recover_current_device_sync",
      "refresh_shared_device_usage_s3",
      "list_remote_opencode_permissions",
      "reply_remote_opencode_permission",
      "refresh_shared_device_usage_lan",
      "lan_server_status",
      "probe_lan_peers",
      "export_device_usage_bundle",
      "preview_device_usage_import",
      "import_device_usage_bundle",
    ];
    const registry = new Set(desktopCommandNames());
    for (const name of names) {
      assert.ok(name in handlers, `领域文件未导出命令：${name}`);
      assert.ok(registry.has(name), `注册表未合并命令：${name}`);
    }
    assert.equal(names.length, 23);
  });
});
