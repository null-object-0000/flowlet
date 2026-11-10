// 后台维护任务测试：存储清理 / 目录同步 / 余额同步过滤。
// 运行：node --test packages/flowlet-core/src/host/__tests__/
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SqliteStorage } from "../../storage/index.ts";
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
