// 后台维护任务测试：存储清理 / 目录同步 / 余额同步过滤。
// 运行：node --test packages/flowlet-core/src/host/__tests__/
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SqliteStorage } from "../../storage/index.ts";
import { rewriteCaptureSegment } from "../../storage/capture-compaction.ts";
import { cleanupScheduledBodies } from "../../storage/maintenance.ts";
import { RuntimeConfig } from "../../config/index.ts";
import type { WebContext } from "../../web/context.ts";
import {
  createHostScheduler,
  parseUsageRetentionConfig,
  MODELS_CN_URL,
  MODELS_DEV_URL,
} from "../scheduler.ts";

function makeContext(overrides: JsonRow = {}): { ctx: WebContext; storage: SqliteStorage; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "flowlet-scheduler-"));
  const storage = new SqliteStorage(path.join(dir, "flowlet.sqlite"));
  const config: JsonRow = {
    log_capture: { body_retention_days: 30, body_max_size_mb: 0, body_prune_ratio: 0.1 },
    usage_retention: { balance_snapshot_retention_days: 30, balance_snapshot_max_per_account: 2 },
    ...overrides,
  };
  const runtimeConfig = new RuntimeConfig({
    channels: [],
    accounts: [],
    routes: [],
    rules: [],
    virtual_models: [],
  });
  const ctx = {
    storage,
    proxy: {},
    runtimeConfig,
    catalogDir: dir,
    configPath: path.join(dir, "config.json"),
    adminToken: "t",
    clientToken: "c",
    staticDir: dir,
    publicProxyUrl: "",
    deviceIdentity: { schema_version: 1, device_id: "dev", created_at: new Date().toISOString(), display_name: "d", platform: "ubuntu" },
    config,
    channelsConfig: { channels: [], endpoints: {} },
    logCapture: { body_retention_days: 30 },
    upstreamProxy: { enabled: false, url: "" },
  } as unknown as WebContext;
  return { ctx, storage, dir };
}

test("storage cleanup clears expired frames but keeps incomplete usage", async () => {
  const { ctx, storage, dir } = makeContext();
  try {
    // 完整用量（input/output tokens 都有）→ 应清理捕获帧
    storage.insertRequestLog({
      request_id: "req-complete",
      client_protocol: "openai",
      upstream_protocol: "openai",
      method: "POST",
      path: "/v1/chat/completions",
      req_body_b64: Buffer.from("hello").toString("base64"),
      res_body_b64: Buffer.from("world").toString("base64"),
    });
    storage.insertUsageRecord({
      request_id: "req-complete",
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
    // 不完整用量 → 帧必须保留，便于数据修复
    storage.insertRequestLog({
      request_id: "req-partial",
      client_protocol: "openai",
      upstream_protocol: "openai",
      method: "POST",
      path: "/v1/chat/completions",
      req_body_b64: Buffer.from("keep").toString("base64"),
    });

    // 写入后：Body 在 .flcap 帧里，详情可 hydrate 出原始内容（request_logs 列保持 NULL）
    const beforeComplete = storage.listRequestLogsByRequestId("req-complete")[0];
    assert.equal(Buffer.from(String(beforeComplete.req_body_b64), "base64").toString("utf8"), "hello");
    assert.equal(Buffer.from(String(beforeComplete.res_body_b64), "base64").toString("utf8"), "world");
    const beforePartial = storage.listRequestLogsByRequestId("req-partial")[0];
    assert.equal(Buffer.from(String(beforePartial.req_body_b64), "base64").toString("utf8"), "keep");

    // 把两条都挪到 40 天前
    storage.database().exec("UPDATE request_logs SET created_at = datetime('now', '-40 days')");

    const scheduler = createHostScheduler({ context: ctx, log: () => {} });
    await scheduler.runCleanupOnce();

    const complete = storage.listRequestLogsByRequestId("req-complete")[0];
    const partial = storage.listRequestLogsByRequestId("req-partial")[0];
    assert.equal(complete.req_body_b64, null, "完整用量的请求体（帧）应被清理");
    assert.equal(complete.res_body_b64, null);
    assert.equal(complete.req_body_cleanup_reason, "retention");
    assert.ok(complete.req_body_cleared_at, "清理后应写 cleared_at 标记");
    assert.equal(
      Buffer.from(String(partial.req_body_b64), "base64").toString("utf8"),
      "keep",
      "用量不完整的请求体必须保留，便于数据修复",
    );
    assert.equal(partial.req_body_cleared_at, null);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("size cleanup keeps HTTP responsive and preserves recent captures", async () => {
  const { ctx, storage, dir } = makeContext({
    log_capture: { body_retention_days: -1, body_max_size_mb: 1, body_prune_ratio: 0.1 },
  });
  const scheduler = createHostScheduler({ context: ctx, log: () => {} });
  let completed = false;
  const server = createServer((_request, response) => response.end(String(completed)));
  try {
    for (let index = 0; index < 64; index += 1) {
      const requestId = `old-${index}`;
      storage.insertRequestLog({
        request_id: requestId,
        agent_type: "codex",
        agent_session_id: "busy-session",
        req_body_b64: randomBytes(192 * 1024).toString("base64"),
      });
      storage.insertUsageRecord({ request_id: requestId, input_tokens: 10, output_tokens: 5 });
    }
    storage.database().exec("UPDATE request_logs SET created_at = datetime('now', '-2 hours')");
    storage.insertRequestLog({
      request_id: "recent",
      agent_type: "codex",
      agent_session_id: "busy-session",
      req_body_b64: "a2VlcA==",
    });
    const store = storage.captureStore();
    const originalRead = store.read.bind(store);
    store.read = () => assert.fail("scheduled compaction must not read frames on the HTTP thread");

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const pending = scheduler.runCleanupOnce().then(() => { completed = true; });
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/health`)).text(), "false");
    await pending;
    store.read = originalRead;
    const cleared = storage.listRequestLogsByRequestId("old-0")[0];
    assert.equal(cleared.req_body_b64, null);
    assert.equal(cleared.req_body_cleanup_reason, "size_limit");
    assert.equal(storage.listRequestLogsByRequestId("recent")[0].req_body_b64, "a2VlcA==");
  } finally {
    server.close();
    await scheduler.stop();
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup discards a stale compaction when a request appends to the same segment", async () => {
  const { storage, dir } = makeContext();
  const capture = { agent_type: "codex", agent_session_id: "shared", req_body_b64: "a2VlcA==" };
  const store = storage.captureStore();
  try {
    storage.insertRequestLog({ ...capture, request_id: "old" });
    storage.insertUsageRecord({ request_id: "old", input_tokens: 10, output_tokens: 5 });
    storage.database().exec("UPDATE request_logs SET created_at = datetime('now', '-2 days')");
    const options = { retentionDays: 1, maxBytes: 0, pruneRatio: 0, signal: new AbortController().signal };
    const interrupted = await cleanupScheduledBodies(storage.database(), store, options, async (job) => {
      const rewrite = rewriteCaptureSegment(store, job);
      storage.insertRequestLog({ ...capture, request_id: "new" });
      return rewrite;
    });
    assert.equal(interrupted.expiredBodies, 0);
    assert.equal(store.diskUsage().segments, 1);
    assert.equal(storage.listRequestLogsByRequestId("old")[0].req_body_b64, capture.req_body_b64);
    assert.equal(storage.listRequestLogsByRequestId("new")[0].req_body_b64, capture.req_body_b64);

    const retried = await cleanupScheduledBodies(storage.database(), store, options, async (job) => rewriteCaptureSegment(store, job));
    assert.equal(retried.expiredBodies, 1);
    assert.equal(storage.listRequestLogsByRequestId("old")[0].req_body_b64, null);
    assert.equal(storage.listRequestLogsByRequestId("new")[0].req_body_b64, capture.req_body_b64);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("balance snapshot retention prunes expired rows and caps per account", async () => {
  const { ctx, storage, dir } = makeContext();
  try {
    for (let index = 0; index < 5; index += 1) {
      storage.saveBalanceSnapshot({
        id: `snap-${index}`,
        account_id: "account-a",
        balance: index,
        currency: "CNY",
        synced_at: new Date(Date.now() - index * 60_000).toISOString(),
      });
    }
    storage.saveBalanceSnapshot({
      id: "snap-old",
      account_id: "account-b",
      balance: 1,
      currency: "CNY",
      synced_at: "2020-01-01T00:00:00Z",
    });
    const scheduler = createHostScheduler({ context: ctx, log: () => {} });
    await scheduler.runCleanupOnce();
    const rows = storage.database().prepare("SELECT id FROM account_balance_snapshots").all() as JsonRow[];
    const ids = rows.map((row) => row.id);
    assert.equal(ids.includes("snap-old"), false, "过期快照应被删除");
    assert.equal(ids.filter((id) => String(id).startsWith("snap-") && id !== "snap-old").length <= 2, true);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog sync writes models-cn/dev files atomically and survives one failed source", async () => {
  const { ctx, storage, dir } = makeContext();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url === MODELS_CN_URL) {
        return new Response(JSON.stringify({ providers: {} }), { status: 200 });
      }
      return new Response("upstream error", { status: 502 });
    }) as typeof fetch;
    const scheduler = createHostScheduler({ context: ctx, log: () => {} });
    await scheduler.runCatalogSyncOnce();
    const modelsCn = JSON.parse(readFileSync(path.join(dir, "models-cn.json"), "utf8"));
    assert.deepEqual(modelsCn, { providers: {} });
    assert.equal(pathExists(path.join(dir, "models-dev.json")), false, "失败源不得写入错误内容");
    assert.ok(MODELS_DEV_URL.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("balance sync skips disabled accounts and accounts with custom base url", async () => {
  const { ctx, storage, dir } = makeContext();
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  try {
    (ctx.runtimeConfig as RuntimeConfig).replace({
      channels: [{ id: "deepseek", supports_balance_query: true }],
      accounts: [
        { id: "a-disabled", channel_id: "deepseek", enabled: false, api_key: "sk-x" },
        { id: "a-custom", channel_id: "deepseek", enabled: true, api_key: "sk-x", base_url_override: "http://example.test" },
      ],
      routes: [],
      rules: [],
      virtual_models: [],
    });
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const scheduler = createHostScheduler({ context: ctx, log: () => {} });
    await scheduler.runBalanceSyncOnce();
    assert.equal(upstreamCalls, 0, "不应对禁用账号或自定义端点账号发起余额查询");
  } finally {
    globalThis.fetch = originalFetch;
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("balance sync includes qwen only when the platform login exists", async () => {
  const { ctx, storage, dir } = makeContext();
  const originalFetch = globalThis.fetch;
  const logs: JsonRow[] = [];
  try {
    const qwenAccounts = [
      { id: "qwen-not-logged-in", channel_id: "qwen", enabled: true, api_key: "sk-x" },
      { id: "qwen-logged-in", channel_id: "qwen", enabled: true, api_key: "sk-x" },
    ];
    // syncAccount 从 storage 读账号，所以两边都要有。
    storage.saveChannelAccounts(qwenAccounts);
    (ctx.runtimeConfig as RuntimeConfig).replace({
      channels: [],
      accounts: qwenAccounts,
      routes: [],
      rules: [],
      virtual_models: [],
    });
    // 只给 qwen-logged-in 准备共享平台凭据（另一个账号应被跳过，不发请求）。
    const credentialDir = path.join(ctx.catalogDir, "qwen-platform");
    mkdirSync(credentialDir, { recursive: true });
    writeFileSync(
      path.join(credentialDir, "credentials.json"),
      JSON.stringify({
        version: 1,
        platforms: {
          aliyun: {
            accessToken: "token",
            expiresAt: "2099-01-01T00:00:00Z",
            aliyunId: "aliyun",
            email: null,
            updatedAt: "2026-11-10T00:00:00Z",
          },
        },
        accounts: { "qwen-logged-in": "aliyun" },
      }),
    );
    let attempted = 0;
    globalThis.fetch = (async () => {
      attempted += 1;
      throw new Error("network down in test");
    }) as typeof fetch;
    const scheduler = createHostScheduler({ context: ctx, log: (line) => logs.push(line as JsonRow) });
    await scheduler.runBalanceSyncOnce();
    assert.ok(attempted > 0, "已登录的千问账号应参与周期同步");
    const qwenFailure = logs.find((line) => line.channel === "qwen" || line.task === "balance-sync");
    assert.ok(qwenFailure !== undefined, "同步失败应写入结构化日志");
  } finally {
    globalThis.fetch = originalFetch;
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage retention defaults match Rust (30 days / 200 rows)", () => {
  assert.deepEqual(parseUsageRetentionConfig({}), {
    balanceSnapshotRetentionDays: 30,
    balanceSnapshotMaxPerAccount: 200,
  });
  assert.deepEqual(
    parseUsageRetentionConfig({ usage_retention: { balance_snapshot_retention_days: -1, balance_snapshot_max_per_account: 0 } }),
    { balanceSnapshotRetentionDays: -1, balanceSnapshotMaxPerAccount: 0 },
  );
});

function pathExists(target: string): boolean {
  try {
    readFileSync(target);
    return true;
  } catch {
    return false;
  }
}

type JsonRow = Record<string, any>;
