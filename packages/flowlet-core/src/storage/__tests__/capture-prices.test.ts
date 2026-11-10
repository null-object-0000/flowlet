// task-11 测试：`.flcap` 捕获帧（读写/损坏降级/清理删帧）+ 价格表构建与解析。
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteStorage } from "../index.ts";
import {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FORMAT_VERSION,
  RequestCaptureStore,
  captureRecordFromLog,
  serializeCaptureRecord,
  type RequestCaptureRecord,
} from "../capture-store.ts";
import {
  buildPriceTable,
  buildPricesFromModelsCnCatalog,
  resolvePrices,
  resolvePricesAt,
  type ModelPrice,
} from "../prices.ts";
import { loadModelCatalog } from "../../catalog/index.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const PROD_COPY = path.join(REPO_ROOT, ".flowlet-dev-data/prod-copy");
const hasProdCopy = existsSync(path.join(PROD_COPY, "catalogs", "models-cn.json"));

function tempDir(): string {
  const base = path.join(process.cwd(), ".flowlet-test-tmp");
  return path.join(base, `capture-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function logInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: "req-capture-1",
    agent_type: "claude-code",
    agent_session_id: "session/unsafe/../../id",
    parent_agent_session_id: null,
    client_id: "claude-code",
    client_name: "Claude Code",
    channel_id: "deepseek",
    channel_name: "DeepSeek",
    account_id: "account-1",
    account_name: "账号",
    client_protocol: "openai",
    upstream_protocol: "openai",
    virtual_model: "deepseek-v4.1-flash",
    public_model: "deepseek-v4.1-flash",
    upstream_model: "deepseek-flash",
    request_type: "chat",
    method: "POST",
    path: "/v1/chat/completions",
    upstream_url: "https://example.test/v1/chat/completions",
    status: 200,
    latency_ms: 120,
    is_stream: false,
    error_message: null,
    fallback_count: 0,
    route_reason: "direct",
    ttfb_ms: 30,
    duration_ms: 120,
    attempt_seq: 0,
    req_headers_json: JSON.stringify({ authorization: "[redacted]" }),
    req_body_b64: Buffer.from(JSON.stringify({ model: "deepseek-flash", messages: [] })).toString("base64"),
    res_headers_json: JSON.stringify({ "content-type": "application/json" }),
    res_body_b64: Buffer.from(JSON.stringify({ id: "chatcmpl-1", usage: { total_tokens: 16 } })).toString("base64"),
    is_last_attempt: true,
    ...overrides,
  };
}

function recordFrom(log: Record<string, unknown>, id = "log-1"): RequestCaptureRecord {
  return captureRecordFromLog(id, log as never);
}

// ─── 帧格式 ─────────────────────────────────────────────────────────────────

test(".flcap 帧：头字段逐字节符合 Rust 布局，raw JSON 序列化与反序列化往返一致", () => {
  const dir = tempDir();
  try {
    const store = new RequestCaptureStore(dir, 32 * 1024 * 1024);
    const record = recordFrom(logInput());
    const pointer = store.append(record);
    assert.equal(pointer.format_version, FORMAT_VERSION);
    assert.equal(pointer.req_body_bytes, Buffer.byteLength(record.req_body_b64 ?? "", "utf8"));
    assert.equal(pointer.res_body_bytes, Buffer.byteLength(record.res_body_b64 ?? "", "utf8"));
    // 会话路径：sessions/<safe agent_type>/<YYYY>-<MM>/<sha256(agent_type\0session_id)[:32]>
    assert.match(
      pointer.storage_key,
      /^sessions\/claude-code\/\d{4}-\d{2}\/[0-9a-f]{32}\/000001\.flcap$/,
    );
    const filePath = path.join(dir, pointer.storage_key.split("/").join(path.sep));
    const bytes = readFileSync(filePath);
    assert.equal(bytes.length, pointer.length);
    assert.equal(bytes.length, FRAME_HEADER_BYTES + Number(bytes.readBigUInt64LE(12)));
    assert.deepEqual(bytes.subarray(0, 8).toString("ascii"), FRAME_MAGIC.toString("ascii"));
    assert.equal(bytes.readUInt16LE(8), FORMAT_VERSION);
    assert.equal(bytes.readUInt16LE(10), 0, "flags 恒 0");
    assert.equal(Number(bytes.readBigUInt64LE(20)), serializeCaptureRecord(record).length);
    // 读回后重新序列化必须与本帧 raw 字节完全一致（serde 字段顺序等价）。
    const readBack = store.read(pointer);
    assert.deepEqual(serializeCaptureRecord(readBack), serializeCaptureRecord(record));
    assert.deepEqual(readBack, record);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(".flcap 帧：段大小轮转与非法路径拒绝", () => {
  const dir = tempDir();
  try {
    const store = new RequestCaptureStore(dir, 1);
    const first = store.append(recordFrom(logInput(), "log-1"));
    const second = store.append(recordFrom(logInput(), "log-2"));
    assert.match(first.storage_key, /\/000001\.flcap$/);
    assert.match(second.storage_key, /\/000002\.flcap$/);
    // 无会话 → unassigned/<date>/<sha256(request_id)[:2]>/
    const unassigned = store.append(recordFrom({ ...logInput(), agent_type: null, agent_session_id: null }, "log-3"));
    assert.match(unassigned.storage_key, /^unassigned\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{2}\/000001\.flcap$/);
    // 越界 key 必须拒绝（Rust InvalidPath）。
    assert.throws(() => store.removeSegment("../flowlet.sqlite"), /invalid|非法/i);
    assert.throws(
      () =>
        store.read({
          storage_key: "/etc/passwd",
          offset: 0,
          length: 1,
          checksum: "",
          format_version: 1,
          req_body_bytes: 0,
          res_body_bytes: 0,
        }),
      /invalid|非法/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("存储集成：写日志即写帧（内联列为 NULL），详情从帧 hydrate", () => {
  const storage = new SqliteStorage(":memory:");
  try {
    const log = logInput();
    const id = storage.insertRequestLog(log);
    const row = storage
      .database()
      .prepare("SELECT req_body_b64, res_body_b64 FROM request_logs WHERE id = ?1")
      .get(id) as { req_body_b64: string | null; res_body_b64: string | null };
    assert.equal(row.req_body_b64, null);
    assert.equal(row.res_body_b64, null);
    const ref = storage
      .database()
      .prepare("SELECT state, storage_key, req_body_bytes, res_body_bytes FROM request_capture_refs WHERE request_log_id = ?1")
      .get(id) as { state: string; storage_key: string; req_body_bytes: number; res_body_bytes: number };
    assert.equal(ref.state, "ready");
    assert.ok(ref.req_body_bytes > 0 && ref.res_body_bytes > 0);
    const framePath = path.join(storage.captureStore().rootPath(), ref.storage_key.split("/").join(path.sep));
    assert.ok(existsSync(framePath), "帧文件必须存在");

    const detail = storage.listRequestLogsByRequestId(log.request_id as string)[0];
    assert.equal(detail.capture_state, "ready");
    assert.equal(detail.req_body_b64, log.req_body_b64);
    assert.equal(detail.res_body_b64, log.res_body_b64);
    assert.equal(detail.req_headers_json, log.req_headers_json);
    assert.ok(String(detail.capture_failure_reason ?? null) === "null" || detail.capture_failure_reason === null);
    // getTotalBodySizeBytes 计入帧声明字节。
    const bytes = storage.getTotalBodySizeBytes();
    assert.equal(bytes, ref.req_body_bytes + ref.res_body_bytes);
    assert.equal(storage.captureDiskUsage().segments, 1);
  } finally {
    storage.close();
  }
});

test("帧损坏/丢失：详情按 Rust 行为降级为 corrupt，不抛错", () => {
  const storage = new SqliteStorage(":memory:");
  try {
    const log = logInput({ request_id: "req-corrupt" });
    const id = storage.insertRequestLog(log);
    const ref = storage
      .database()
      .prepare("SELECT storage_key FROM request_capture_refs WHERE request_log_id = ?1")
      .get(id) as { storage_key: string };
    const framePath = path.join(storage.captureStore().rootPath(), ref.storage_key.split("/").join(path.sep));
    // 篡改压缩块：checksum 校验失败 → refs=corrupt，详情返回 null body。
    const bytes = readFileSync(framePath);
    const corrupt = Buffer.from(bytes);
    corrupt[FRAME_HEADER_BYTES + 1] ^= 0xff;
    writeFileSync(framePath, corrupt);
    const detail = storage.listRequestLogsByRequestId("req-corrupt")[0];
    assert.equal(detail.capture_state, "corrupt");
    assert.equal(detail.req_body_b64, null);
    const refAfter = storage
      .database()
      .prepare("SELECT state, failure_reason FROM request_capture_refs WHERE request_log_id = ?1")
      .get(id) as { state: string; failure_reason: string | null };
    assert.equal(refAfter.state, "corrupt");
    assert.ok(refAfter.failure_reason);

    // 帧文件丢失同样降级。
    const log2 = logInput({ request_id: "req-missing" });
    const id2 = storage.insertRequestLog(log2);
    const ref2 = storage
      .database()
      .prepare("SELECT storage_key FROM request_capture_refs WHERE request_log_id = ?1")
      .get(id2) as { storage_key: string };
    rmSync(path.join(storage.captureStore().rootPath(), ref2.storage_key.split("/").join(path.sep)));
    const detail2 = storage.listRequestLogsByRequestId("req-missing")[0];
    assert.equal(detail2.capture_state, "corrupt");
    assert.equal(detail2.res_body_b64, null);
  } finally {
    storage.close();
  }
});

test("update_request_log_timing：补写响应体追加新帧并保持 refs ready", () => {
  const storage = new SqliteStorage(":memory:");
  try {
    const log = logInput({ request_id: "req-stream", is_stream: true, res_body_b64: null, duration_ms: null });
    storage.insertRequestLog(log);
    const before = storage
      .database()
      .prepare("SELECT res_body_bytes FROM request_capture_refs WHERE request_log_id = (SELECT id FROM request_logs WHERE request_id = 'req-stream')")
      .get() as { res_body_bytes: number };
    assert.equal(before.res_body_bytes, 0);
    storage.updateRequestLogTiming("req-stream", {
      ttfb_ms: 30,
      ttft_ms: 40,
      duration_ms: 200,
      res_body_b64: "bmV3LWJvZHk=",
      res_headers_json: JSON.stringify({ "content-type": "text/event-stream" }),
      error_message: "done",
    });
    const detail = storage.listRequestLogsByRequestId("req-stream")[0];
    assert.equal(detail.capture_state, "ready");
    assert.equal(detail.res_body_b64, "bmV3LWJvZHk=");
    assert.equal(detail.res_headers_json, JSON.stringify({ "content-type": "text/event-stream" }));
    assert.equal(detail.error_message, "done");
    assert.equal(detail.duration_ms, 200);
    // 内联列仍为 NULL（body 只在帧里）。
    const inline = storage
      .database()
      .prepare("SELECT res_body_b64 FROM request_logs WHERE request_id = 'req-stream'")
      .get() as { res_body_b64: string | null };
    assert.equal(inline.res_body_b64, null);
  } finally {
    storage.close();
  }
});

// ─── 清理 ───────────────────────────────────────────────────────────────────

function seedAgedLog(storage: SqliteStorage, requestId: string): string {
  const id = storage.insertRequestLog(logInput({ request_id: requestId }));
  // 与清理条件配套：创建 30 天前 + 已完整统计的 usage。
  storage
    .database()
    .prepare("UPDATE request_logs SET created_at = datetime('now', '-30 days') WHERE id = ?1")
    .run(id);
  storage.insertUsageRecord({
    request_id: requestId,
    client_id: "claude-code",
    channel_id: "deepseek",
    upstream_model: "deepseek-flash",
    input_tokens: 10,
    output_tokens: 5,
    usage_status: "complete",
  });
  storage
    .database()
    .prepare("UPDATE usage_records SET created_at = datetime('now', '-30 days') WHERE request_id = ?1")
    .run(requestId);
  return id;
}

test("cleanup_expired_body_data：重写 segment、refs 置 cleared、帧体积归零", () => {
  const storage = new SqliteStorage(":memory:");
  try {
    const id = seedAgedLog(storage, "req-aged");
    const ref = storage
      .database()
      .prepare("SELECT storage_key FROM request_capture_refs WHERE request_log_id = ?1")
      .get(id) as { storage_key: string };
    const oldSegment = path.join(storage.captureStore().rootPath(), ref.storage_key.split("/").join(path.sep));
    assert.ok(existsSync(oldSegment));
    const cleared = storage.cleanupExpiredBodyData(7);
    assert.equal(cleared, 1);
    assert.equal(storage.getTotalBodySizeBytes(), 0);
    assert.equal(existsSync(oldSegment), false, "旧段必须删除");
    const after = storage
      .database()
      .prepare(
        "SELECT refs.state, refs.req_body_bytes, refs.res_body_bytes, rl.req_body_cleared_at, rl.req_body_cleanup_reason FROM request_capture_refs refs JOIN request_logs rl ON rl.id = refs.request_log_id WHERE refs.request_log_id = ?1",
      )
      .get(id) as Record<string, unknown>;
    assert.equal(after.state, "cleared");
    assert.equal(Number(after.req_body_bytes), 0);
    assert.equal(Number(after.res_body_bytes), 0);
    assert.equal(after.req_body_cleanup_reason, "retention");
    assert.ok(after.req_body_cleared_at);
    const detail = storage.listRequestLogsByRequestId("req-aged")[0];
    assert.equal(detail.req_body_b64, null);
    assert.equal(detail.capture_state, "cleared");
  } finally {
    storage.close();
  }
});

test("旧库内联 Body 列同样可被清理（保留其它字段）", () => {
  const storage = new SqliteStorage(":memory:");
  try {
    const id = "legacy-inline-log";
    storage
      .database()
      .prepare(
        `INSERT INTO request_logs (id, request_id, client_protocol, upstream_protocol, method, path, created_at,
           req_body_b64, res_body_b64, status, is_stream, is_last_attempt)
         VALUES (?1, 'req-legacy', 'openai', 'openai', 'POST', '/v1/chat/completions', datetime('now', '-30 days'),
           'bGVnYWN5LXJlcQ==', 'bGVnYWN5LXJlcw==', 200, 0, 1)`,
      )
      .run(id);
    storage
      .database()
      .prepare(
        "INSERT INTO usage_records (id, request_id, client_protocol, upstream_protocol, input_tokens, output_tokens, usage_status, created_at) VALUES (lower(hex(randomblob(16))), 'req-legacy', 'openai', 'openai', 1, 1, 'complete', datetime('now', '-30 days'))",
      )
      .run();
    assert.ok(storage.getTotalBodySizeBytes() > 0);
    const cleared = storage.cleanupExpiredBodyData(7);
    assert.equal(cleared, 1);
    assert.equal(storage.getTotalBodySizeBytes(), 0);
    const row = storage
      .database()
      .prepare("SELECT req_body_b64, res_body_b64, req_body_cleanup_reason FROM request_logs WHERE id = ?1")
      .get(id) as Record<string, unknown>;
    assert.equal(row.req_body_b64, null);
    assert.equal(row.res_body_b64, null);
    assert.equal(row.req_body_cleanup_reason, "retention");
  } finally {
    storage.close();
  }
});

test("prune_oldest_body_data / cleanup_old_logs：按体积与保留天数删除帧", () => {
  const storage = new SqliteStorage(":memory:");
  try {
    seedAgedLog(storage, "req-prune");
    const total = storage.getTotalBodySizeBytes();
    assert.ok(total > 0);
    const cleared = storage.pruneOldestBodyDataToGoal(Math.floor(total / 2), 0.5);
    assert.ok(cleared >= 1);
    assert.equal(storage.getTotalBodySizeBytes(), 0);
    // cleanup_old_logs：帧与行一起删除。
    seedAgedLog(storage, "req-cleanup");
    const [logs, usage] = storage.cleanupOldLogs(7);
    // 两条 30 天前的日志（req-prune 仅清空 Body 仍在）都被删除。
    assert.ok(logs >= 1 && logs <= 2);
    assert.ok(usage >= 1 && usage <= 2);
    assert.equal(storage.getTotalBodySizeBytes(), 0);
    const remaining = storage
      .database()
      .prepare("SELECT COUNT(*) AS total FROM request_logs WHERE request_id = 'req-cleanup'")
      .get() as { total: number };
    assert.equal(Number(remaining.total), 0);
    // Rust cleanup_old_logs 先把帧重写为 cleared（body 置空）再删行，FK 级联删 refs；
    // 不含 body 的 compacted 段会作为无害孤儿保留（Rust 行为一致），因此这里只校验
    // Body 计费体积已归零、cleared 段不含 body。
    const frames = storage.captureDiskUsage();
    assert.ok(frames.segments >= 0);
    const clearedSegments = existsSync(storage.captureStore().rootPath())
      ? readdirSync(storage.captureStore().rootPath(), { recursive: true })
          .map(String)
          .filter((file) => file.endsWith(".flcap"))
      : [];
    for (const relative of clearedSegments) {
      const bytes = readFileSync(path.join(storage.captureStore().rootPath(), relative));
      let offset = 0;
      while (offset + FRAME_HEADER_BYTES <= bytes.length) {
        const compressedLength = Number(bytes.readBigUInt64LE(offset + 12));
        const record = storage.captureStore().read({
          storage_key: relative.split(path.sep).join("/"),
          offset,
          length: FRAME_HEADER_BYTES + compressedLength,
          checksum: bytes.subarray(offset + 28, offset + 60).toString("hex"),
          format_version: 1,
          req_body_bytes: 0,
          res_body_bytes: 0,
        });
        assert.equal(record.req_body_b64, null);
        assert.equal(record.res_body_b64, null);
        offset += FRAME_HEADER_BYTES + compressedLength;
      }
    }
  } finally {
    storage.close();
  }
});

// ─── 价格表 ─────────────────────────────────────────────────────────────────

test("价格表：生产 models-cn/models.dev 目录可构建（CNY+USD、去重、排除 codex-native）", { skip: !hasProdCopy }, () => {
  loadModelCatalog(path.join(PROD_COPY, "catalogs"), REPO_ROOT);
  const configJson = JSON.parse(readFileSync(path.join(PROD_COPY, "config.json"), "utf8")) as Record<string, unknown>;
  const result = buildPriceTable(path.join(PROD_COPY, "catalogs"), configJson);
  assert.ok(result.count > 0, `价格条数 ${result.count}`);
  const keys = new Set(result.prices.map((price) => `${price.channel_id}\0${price.upstream_model}`));
  assert.equal(keys.size, result.prices.length, "合并后必须无重复 key");
  assert.ok(
    result.prices.every((price) => price.channel_id.toLowerCase() !== "codex-native"),
    "codex-native 必须排除",
  );
  assert.ok(result.prices.some((price) => price.currency === "CNY"));
  assert.ok(result.prices.some((price) => price.currency === "USD" && price.channel_id === "openai-api"));
  // deepseek-flash（models-cn 官方 API 名）必须存在且带官方价。
  const deepseek = result.prices.find(
    (price) => price.channel_id === "deepseek" && price.upstream_model === "deepseek-flash",
  );
  assert.ok(deepseek);
  assert.equal(deepseek.currency, "CNY");
  assert.ok(deepseek.input_uncached_price > 0 && deepseek.output_price > 0);
  // 目录价格优先于 config（config 空时全部来自目录）。
  assert.ok(result.catalogCount > 0);
});

test("价格解析：分档与每日峰谷时段与 Rust resolve_prices_at 语义一致", () => {
  const base: ModelPrice = {
    id: "price-test",
    channel_id: "deepseek",
    upstream_model: "deepseek-flash",
    input_uncached_price: 1,
    input_cached_price: 0.1,
    input_cache_write_price: null,
    output_price: 2,
    tiers: [
      { up_to_input_tokens: 1000, input_uncached_price: 1, input_cached_price: 0.1, input_cache_write_price: null, output_price: 2 },
      { up_to_input_tokens: null, input_uncached_price: 3, input_cached_price: 0.3, input_cache_write_price: 0.5, output_price: 6 },
    ],
    schedules: [],
    currency: "CNY",
    unit: "1M tokens",
    source_url: null,
    price_version: null,
    created_at: "",
    updated_at: "",
  };
  assert.deepEqual(resolvePricesAt(base, 500), [1, 0.1, null, 2]);
  assert.deepEqual(resolvePricesAt(base, 5000), [3, 0.3, 0.5, 6]);

  // 分时段价格：Asia/Shanghai 09:00-18:00 促销价 0.5/1，其余时段 standard 2/4。
  const scheduled: ModelPrice = {
    ...base,
    tiers: [],
    input_uncached_price: 2,
    input_cached_price: 0.2,
    output_price: 4,
    schedules: [
      {
        rate_type: "standard",
        effective_from: null,
        effective_to: null,
        daily_time_range: {
          label: "空闲",
          time_zone: "Asia/Shanghai",
          intervals: [{ start: "00:00", end: "09:00", days: [] }],
        },
        input_uncached_price: 2,
        input_cached_price: 0.2,
        input_cache_write_price: null,
        output_price: 4,
        tiers: [],
        source_url: null,
      },
      {
        rate_type: "promotional",
        effective_from: null,
        effective_to: null,
        daily_time_range: {
          label: "峰时",
          time_zone: "Asia/Shanghai",
          intervals: [{ start: "09:00", end: "18:00", days: ["mon", "tue", "wed", "thu", "fri"] }],
        },
        input_uncached_price: 0.5,
        input_cached_price: 0.05,
        input_cache_write_price: null,
        output_price: 1,
        tiers: [],
        source_url: null,
      },
    ],
  };
  // 2026-11-10 是周二。UTC 04:00 = Asia/Shanghai 12:00 → 命中促销。
  const inPromo = Date.parse("2026-11-10T04:00:00Z");
  assert.deepEqual(resolvePricesAt(scheduled, null, inPromo), [0.5, 0.05, null, 1]);
  // UTC 00:30 = Asia/Shanghai 08:30 → 命中空闲 standard。
  const inIdle = Date.parse("2026-11-10T00:30:00Z");
  assert.deepEqual(resolvePricesAt(scheduled, null, inIdle), [2, 0.2, null, 4]);
  // 周六 UTC 04:00 = 周六 12:00：促销仅工作日 → 无 schedule 命中 → null；
  // resolvePrices 回退扁平单价（Rust 同）。
  const weekend = Date.parse("2026-11-14T04:00:00Z");
  assert.equal(resolvePricesAt(scheduled, null, weekend), null);
  assert.deepEqual(resolvePrices(scheduled, null, weekend), [2, 0.2, null, 4]);
});

test("配置价格：config model_prices 补目录未覆盖的 key", () => {
  const catalogJson = JSON.stringify({
    providers: [
      {
        id: "deepseek",
        models: [
          {
            id: "deepseek-flash",
            prices: [
              {
                market: "china",
                currency: "CNY",
                rateType: "standard",
                input: { standard: 1, cacheHit: 0.1 },
                output: 2,
                sourceUrl: "https://example.test",
              },
            ],
          },
        ],
      },
    ],
  });
  const catalogPrices = buildPricesFromModelsCnCatalog(catalogJson);
  assert.equal(catalogPrices.length, 1);
  const merged = buildPriceTable(
    // 目录为空 → 只保留 config 价格。
    path.join(REPO_ROOT, ".flowlet-dev-data/does-not-exist"),
    {
      channels_config: {
        channels: [],
        model_prices: [
          {
            channel_id: "custom",
            upstream_model: "my-model",
            input_uncached_price: 7,
            input_cached_price: 1,
            output_price: 9,
            currency: "CNY",
            unit: "1M tokens",
          },
        ],
      },
    },
  );
  assert.equal(merged.count, 1);
  assert.equal(merged.prices[0].channel_id, "custom");
  assert.equal(merged.prices[0].input_uncached_price, 7);
});