// 数据完整性检查（Node Host）契约测试（node:test）。
//
// 覆盖移植自 Rust `storage_usage.rs` / `usage.rs` 的四个修复函数：
//   repair_captured_usage / repair_unknown_usage / repair_usage_costs / repair_agent_sessions。
// 全部使用临时文件库 + 真实 `.flcap` 捕获帧（RequestCaptureStore.forDatabase），
// 不依赖真实生产库。
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { BUILTIN_UA_RULES } from "../../proxy/identity.ts";
import { SqliteStorage } from "../index.ts";
import type { ModelPrice } from "../prices.ts";
import { repairCapturedUsage, repairUnknownUsage, repairUsageCosts } from "../repair.ts";
import { repairAgentSessions } from "../repair-sessions.ts";

// ─── 测试脚手架 ─────────────────────────────────────────────────────────────

function tempDir(): string {
  // 保持在工作区内（file sandbox 只保证 workspace 可写），与 storage.test.ts 一致。
  const base = path.join(process.cwd(), ".flowlet-test-tmp");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, "repair-"));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
}

function withStorage(run: (storage: SqliteStorage) => void): void {
  const dir = tempDir();
  const storage = new SqliteStorage(path.join(dir, "flowlet.sqlite"));
  try {
    run(storage);
  } finally {
    storage.close();
    cleanup(dir);
  }
}

/** 价格表 fixture：deepseek / deepseek-v4-flash，固定单价便于断言金额。 */
function priceTable(scale = 1): ModelPrice[] {
  return [
    {
      id: "price-deepseek-v4-flash",
      channel_id: "deepseek",
      upstream_model: "deepseek-v4-flash",
      input_uncached_price: 2 * scale,
      input_cached_price: 0.5 * scale,
      input_cache_write_price: 1 * scale,
      output_price: 8 * scale,
      tiers: [],
      schedules: [],
      currency: "CNY",
      unit: "per_1m_tokens",
      source_url: null,
      price_version: null,
      created_at: "2026-01-01 00:00:00",
      updated_at: "2026-01-01 00:00:00",
    },
  ];
}

interface SeedLogOptions {
  requestId?: string;
  path?: string;
  isStream?: boolean;
  /** 响应体原文（UTF-8）；写入请求捕获帧（`.flcap`），内联列保持 NULL。 */
  responseBody?: string | null;
  createdAt?: string;
  agentType?: string | null;
  agentSessionId?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  reqHeadersJson?: string | null;
  channelId?: string;
  upstreamModel?: string;
  isLastAttempt?: boolean;
}

function seedLog(
  storage: SqliteStorage,
  options: SeedLogOptions = {},
): { requestId: string; logId: string } {
  const requestId = options.requestId ?? `req-${randomUUID()}`;
  const responseBody = options.responseBody ?? null;
  const logId = storage.insertRequestLog({
    request_id: requestId,
    agent_type: options.agentType ?? null,
    agent_session_id: options.agentSessionId ?? null,
    parent_agent_session_id: null,
    client_id: options.clientId === undefined ? "deepseek-cli" : options.clientId,
    client_name: options.clientName === undefined ? "DeepSeek CLI" : options.clientName,
    channel_id: options.channelId ?? "deepseek",
    channel_name: "DeepSeek",
    account_id: "account-unit",
    account_name: "Unit",
    client_protocol: "anthropic",
    upstream_protocol: "anthropic",
    virtual_model: "deepseek-v4-flash",
    public_model: "deepseek-v4-flash",
    upstream_model: options.upstreamModel ?? "deepseek-v4-flash",
    request_type: "chat",
    method: "POST",
    path: options.path ?? "/v1/messages",
    status: 200,
    latency_ms: 120,
    is_stream: options.isStream ?? false,
    error_message: null,
    fallback_count: 0,
    route_reason: "direct",
    ttfb_ms: 80,
    duration_ms: 200,
    attempt_seq: 0,
    req_headers_json: options.reqHeadersJson ?? null,
    req_body_b64: Buffer.from('{"model":"deepseek-v4-flash"}', "utf8").toString("base64"),
    res_headers_json: null,
    res_body_b64: responseBody === null ? null : Buffer.from(responseBody, "utf8").toString("base64"),
    // 历史日志的原始请求时间由调用方通过 createdAt 覆写。
    is_last_attempt: options.isLastAttempt ?? true,
    upstream_url: "https://api.example.com/v1/messages",
  });
  if (options.createdAt !== undefined) {
    storage
      .database()
      .prepare("UPDATE request_logs SET created_at = ?2 WHERE id = ?1")
      .run(logId, options.createdAt);
  }
  return { requestId, logId };
}

function usageRows(storage: SqliteStorage, requestId: string): Array<Record<string, unknown>> {
  return storage
    .database()
    .prepare("SELECT * FROM usage_records WHERE request_id = ?1")
    .all(requestId) as Array<Record<string, unknown>>;
}

function usageRow(storage: SqliteStorage, requestId: string): Record<string, unknown> | undefined {
  return usageRows(storage, requestId)[0];
}

function logRow(storage: SqliteStorage, logId: string): Record<string, unknown> {
  return storage
    .database()
    .prepare("SELECT * FROM request_logs WHERE id = ?1")
    .get(logId) as Record<string, unknown>;
}

function closeTo(actual: unknown, expected: number, tolerance = 1e-12): void {
  const value = Number(actual);
  assert.ok(
    Math.abs(value - expected) <= tolerance,
    `期望 ${expected}，实际 ${value}（容差 ${tolerance}）`,
  );
}

// ─── 捕获体 fixture ─────────────────────────────────────────────────────────

/** Anthropic 流式 SSE：message_start / message_delta / message_stop（正常完成）。 */
const ANTHROPIC_SSE_COMPLETE = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":100,"cache_read_input_tokens":50,"cache_creation_input_tokens":0,"output_tokens":0}}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
].join("\n");

/** 同一形状但被截断：没有终止标记，只有正数 output（宽松解析应接受，Rust 同）。 */
const ANTHROPIC_SSE_TRUNCATED = [
  "event: message_start",
  'data: {"type":"message_start","message":{"usage":{"input_tokens":6,"cache_read_input_tokens":23746,"cache_creation_input_tokens":11351,"output_tokens":0}}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":249}}',
  "",
].join("\n");

/** 只有 message_start（output=0）的截断前缀：严格/宽松解析都必须拒绝。 */
const ANTHROPIC_SSE_MESSAGE_START_ONLY = [
  "event: message_start",
  'data: {"type":"message_start","message":{"usage":{"input_tokens":113,"cache_read_input_tokens":116352,"cache_creation_input_tokens":0,"output_tokens":0}}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
  "",
].join("\n");

/** 非流式 OpenAI 形状 JSON。 */
const OPENAI_JSON_COMPLETE =
  '{"id":"chatcmpl-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"hi"}}],' +
  '"usage":{"prompt_tokens":180,"completion_tokens":50,"total_tokens":230,"prompt_tokens_details":{"cached_tokens":80}}}';

// ─── 1. 流式 SSE 捕获 → complete usage（INSERT 沿用原始请求时间） ─────────────

test("修复捕获用量：完整 SSE 捕获写入 complete usage 且 created_at 沿用请求日志原始时间", () => {
  withStorage((storage) => {
    const createdAt = "2026-11-09 04:30:00";
    const { requestId } = seedLog(storage, {
      isStream: true,
      responseBody: ANTHROPIC_SSE_COMPLETE,
      createdAt,
      path: "/v1/messages",
    });

    const repaired = repairCapturedUsage(
      storage.database(),
      priceTable(),
      storage.captureStore(),
      "all",
    );
    assert.equal(repaired, 1, "应回填 1 条 usage");

    const row = usageRow(storage, requestId);
    assert.ok(row, "usage_records 必须存在");
    assert.equal(row.usage_status, "complete");
    assert.equal(row.usage_source, "captured_response");
    // Anthropic 形状：未缓存 = 净输入 100 + 缓存写入 0；总输入 = 100 + 缓存读 50。
    assert.equal(row.input_tokens, 150);
    assert.equal(row.input_cached_tokens, 50);
    assert.equal(row.input_uncached_tokens, 100);
    assert.equal(row.input_cache_write_tokens, 0);
    assert.equal(row.output_tokens, 20);
    assert.equal(row.total_tokens, 170);
    // Rust 明确要求沿用原始请求时间（否则历史记录会落到修复当天）。
    assert.equal(row.created_at, createdAt);
    assert.ok(row.analyzed_at, "analyzed_at 必须写入");
    // 费用五列按价格表非空，且与公式一致。
    assert.ok(row.estimated_cost !== null && row.estimated_cost !== undefined);
    closeTo(row.estimated_input_uncached_cost, (100 * 2) / 1_000_000);
    closeTo(row.estimated_input_cached_cost, (50 * 0.5) / 1_000_000);
    closeTo(row.estimated_input_cache_write_cost, (0 * 1) / 1_000_000);
    closeTo(row.estimated_output_cost, (20 * 8) / 1_000_000);
    closeTo(row.estimated_cost, (100 * 2 + 50 * 0.5 + 0 * 1 + 20 * 8) / 1_000_000);
  });
});

test("修复捕获用量：已有 usage 行按 request_id 覆盖（不产生重复行）", () => {
  withStorage((storage) => {
    const createdAt = "2026-11-08 12:00:00";
    const { requestId } = seedLog(storage, {
      isStream: true,
      responseBody: ANTHROPIC_SSE_COMPLETE,
      createdAt,
    });
    // 预置一条「上游没解析出用量」的历史行（token 全 1，费用为空）。
    storage.database()
      .prepare(
        `INSERT INTO usage_records (
             id, request_id, client_id, client_name, channel_id, channel_name,
             account_id, account_name, client_protocol, upstream_protocol,
             virtual_model, upstream_model, input_tokens, input_cached_tokens,
             input_uncached_tokens, input_cache_write_tokens, output_tokens, total_tokens,
             usage_status, usage_source, estimated_cost, analyzed_at, created_at
         ) VALUES (
             lower(hex(randomblob(16))), ?1, 'deepseek-cli', 'DeepSeek CLI', 'deepseek', 'DeepSeek',
             'account-unit', 'Unit', 'anthropic', 'anthropic',
             'deepseek-v4-flash', 'deepseek-v4-flash', 1, 0, 1, 0, 1, 2,
             'partial', 'upstream_response', NULL, NULL, datetime('now')
         )`,
      )
      .run(requestId);

    const repaired = repairCapturedUsage(
      storage.database(),
      priceTable(),
      storage.captureStore(),
      "all",
    );
    assert.equal(repaired, 1);
    const rows = usageRows(storage, requestId);
    assert.equal(rows.length, 1, "同一 request_id 只能有一行");
    const row = rows[0];
    assert.equal(row.input_tokens, 150);
    assert.equal(row.output_tokens, 20);
    assert.equal(row.total_tokens, 170);
    assert.equal(row.usage_status, "complete");
    assert.equal(row.usage_source, "captured_response");
    // Rust UPDATE 分支同样把 created_at 覆写为请求日志原始时间。
    assert.equal(row.created_at, createdAt);
  });
});

// ─── 2. 截断流（无终止标记但有正 output）→ 宽松解析 ─────────────────────────

test("修复捕获用量：截断流无终止标记但有正 output 时按宽松解析回填", () => {
  withStorage((storage) => {
    const { requestId } = seedLog(storage, {
      isStream: true,
      responseBody: ANTHROPIC_SSE_TRUNCATED,
    });

    const repaired = repairCapturedUsage(
      storage.database(),
      priceTable(),
      storage.captureStore(),
      "all",
    );
    assert.equal(repaired, 1, "正 output 的截断流应被宽松解析接受");
    const row = usageRow(storage, requestId);
    assert.ok(row);
    assert.equal(row.input_tokens, 35103);
    assert.equal(row.input_cached_tokens, 23746);
    assert.equal(row.input_uncached_tokens, 11357);
    assert.equal(row.input_cache_write_tokens, 11351);
    assert.equal(row.output_tokens, 249);
    assert.equal(row.total_tokens, 35352);
    assert.equal(row.usage_status, "complete");
  });
});

// ─── 3. 非流式 JSON 捕获 → usage 写入（+ 时间窗过滤） ───────────────────────

test("修复捕获用量：非流式 JSON 捕获按 extract_response_usage 写入，且时间窗生效", () => {
  withStorage((storage) => {
    const recent = seedLog(storage, { responseBody: OPENAI_JSON_COMPLETE });
    const old = seedLog(storage, {
      responseBody: OPENAI_JSON_COMPLETE,
      createdAt: "2026-09-01 00:00:00", // 远早于 7d 窗口
    });

    // 7d 窗口只处理最近的日志。
    assert.equal(
      repairCapturedUsage(storage.database(), priceTable(), storage.captureStore(), "7d"),
      1,
    );
    assert.ok(usageRow(storage, recent.requestId), "窗口内的日志必须回填");
    assert.equal(usageRow(storage, old.requestId), undefined, "窗口外的日志不应回填");

    const row = usageRow(storage, recent.requestId);
    assert.ok(row);
    // OpenAI 形状：prompt_tokens 为全量基值，未缓存 = 180 - 80。
    assert.equal(row.input_tokens, 180);
    assert.equal(row.input_cached_tokens, 80);
    assert.equal(row.input_uncached_tokens, 100);
    assert.equal(row.output_tokens, 50);
    assert.equal(row.total_tokens, 230);

    // all 窗口补齐历史记录；today 窗口对已回填记录不会重复写入（幂等计数为 0）。
    assert.equal(
      repairCapturedUsage(storage.database(), priceTable(), storage.captureStore(), "all"),
      2,
      "all 窗口应重新解析两条捕获体（含已回填的那条）",
    );
    assert.equal(usageRows(storage, old.requestId).length, 1);
    assert.equal(usageRows(storage, recent.requestId).length, 1);
    assert.equal(
      repairCapturedUsage(storage.database(), priceTable(), storage.captureStore(), "today"),
      1,
      "today 窗口只命中今天创建的日志",
    );
  });
});

// ─── 4. 不可解析体 → 无 usage；unknown 占位；count_tokens / files 排除 ─────────

test("修复未知用量：不可解析体不写 usage，占位为 unknown，排除 count_tokens 与 /v1/files", () => {
  withStorage((storage) => {
    // A：没有响应体（代理未捕获）→ 无 usage，最终应变成 unknown 占位。
    const noBody = seedLog(storage, { path: "/v1/chat/completions" });
    // B：count_tokens 路径，带可用量 body；旧版维护流程留下的误分类行必须被删除。
    const countTokens = seedLog(storage, {
      path: "/v1/messages/count_tokens",
      responseBody: OPENAI_JSON_COMPLETE,
    });
    storage.database()
      .prepare(
        `INSERT INTO usage_records (
             id, request_id, client_id, client_name, channel_id, channel_name,
             account_id, account_name, client_protocol, upstream_protocol,
             virtual_model, upstream_model, input_tokens, input_cached_tokens,
             input_uncached_tokens, input_cache_write_tokens, output_tokens, total_tokens,
             usage_status, usage_source, estimated_cost, analyzed_at, created_at
         ) VALUES (
             lower(hex(randomblob(16))), ?1, 'deepseek-cli', 'DeepSeek CLI', 'deepseek', 'DeepSeek',
             'account-unit', 'Unit', 'anthropic', 'anthropic',
             'deepseek-v4-flash', 'deepseek-v4-flash', 10, 0, 10, 0, 5, 15,
             'unknown', 'unknown_placeholder', NULL, NULL, datetime('now')
         )`,
      )
      .run(countTokens.requestId);
    // C：Files API 请求，不是模型推理 → 既不回填也不生成占位。
    const files = seedLog(storage, {
      path: "/v1/files/file_abc",
      responseBody: OPENAI_JSON_COMPLETE,
    });
    // D：只有 message_start 的截断流 → 严格/宽松解析都拒绝，留作 unknown。
    const truncatedOnly = seedLog(storage, {
      isStream: true,
      responseBody: ANTHROPIC_SSE_MESSAGE_START_ONLY,
    });

    // 捕获体回填：A（无体）与 C/D（不可解析或被排除）都不写；B 为 count_tokens 被排除。
    assert.equal(
      repairCapturedUsage(storage.database(), priceTable(), storage.captureStore(), "all"),
      0,
      "没有可解析体的请求不应写入 usage",
    );
    assert.equal(usageRows(storage, noBody.requestId).length, 0);
    assert.equal(usageRows(storage, files.requestId).length, 0);
    assert.equal(usageRows(storage, truncatedOnly.requestId).length, 0);

    // unknown 占位：删除 1 条 count_tokens 误分类行 + 为 A、D 各插入 1 条占位。
    const changed = repairUnknownUsage(storage.database(), "all");
    assert.equal(changed, 3, "删除数 + 插入数");

    for (const requestId of [noBody.requestId, truncatedOnly.requestId]) {
      const rows = usageRows(storage, requestId);
      assert.equal(rows.length, 1, "无用量请求应生成一条占位行");
      const row = rows[0];
      assert.equal(row.usage_status, "unknown");
      assert.equal(row.usage_source, "unknown_placeholder");
      assert.equal(row.input_tokens, null);
      assert.equal(row.output_tokens, null);
      assert.equal(row.total_tokens, null);
      assert.equal(row.estimated_cost, null);
      assert.ok(row.created_at, "占位行 created_at 必须写入");
    }
    // count_tokens 误分类行被删除且不再重新插入。
    assert.equal(usageRows(storage, countTokens.requestId).length, 0);
    // Files API 不生成占位行。
    assert.equal(usageRows(storage, files.requestId).length, 0);
    // 幂等：再跑一次只新增 0 条（占位已存在，count_tokens 无行可删）。
    assert.equal(repairUnknownUsage(storage.database(), "all"), 0);
  });
});

// ─── 5. 费用重算会补齐 / 覆盖五列 ───────────────────────────────────────────

test("费用重算：按当前价格表补齐并覆盖 estimated_* 五列（含 total_tokens 边界）", () => {
  withStorage((storage) => {
    const completed = seedLog(storage, { responseBody: OPENAI_JSON_COMPLETE });
    // 已有 complete usage，但费用列为空（本机无价格表时写入的历史行）。
    storage.insertUsageRecord({
      request_id: completed.requestId,
      client_id: "deepseek-cli",
      client_name: "DeepSeek CLI",
      channel_id: "deepseek",
      channel_name: "DeepSeek",
      account_id: "account-unit",
      account_name: "Unit",
      client_protocol: "anthropic",
      upstream_protocol: "anthropic",
      virtual_model: "deepseek-v4-flash",
      upstream_model: "deepseek-v4-flash",
      input_tokens: 180,
      input_cached_tokens: 80,
      input_uncached_tokens: 100,
      input_cache_write_tokens: 0,
      output_tokens: 50,
      total_tokens: 230,
      usage_status: "complete",
      usage_source: "upstream_response",
    });
    // 边界：Rust 只处理 `total_tokens IS NOT NULL` 的行，即使其它 token 字段有值。
    const noTotal = seedLog(storage, { responseBody: OPENAI_JSON_COMPLETE });
    storage.insertUsageRecord({
      request_id: noTotal.requestId,
      client_id: "deepseek-cli",
      client_name: "DeepSeek CLI",
      channel_id: "deepseek",
      channel_name: "DeepSeek",
      account_id: "account-unit",
      account_name: "Unit",
      client_protocol: "anthropic",
      upstream_protocol: "anthropic",
      virtual_model: "deepseek-v4-flash",
      upstream_model: "deepseek-v4-flash",
      input_tokens: 180,
      input_cached_tokens: 80,
      input_uncached_tokens: 100,
      input_cache_write_tokens: 0,
      output_tokens: 50,
      total_tokens: null,
      usage_status: "complete",
      usage_source: "upstream_response",
    });

    assert.equal(
      repairUsageCosts(storage.database(), priceTable(), "all"),
      1,
      "只有 total_tokens 非空的行被重算",
    );
    const row = usageRow(storage, completed.requestId);
    assert.ok(row);
    closeTo(row.estimated_input_uncached_cost, (100 * 2) / 1_000_000);
    closeTo(row.estimated_input_cached_cost, (80 * 0.5) / 1_000_000);
    closeTo(row.estimated_input_cache_write_cost, (0 * 1) / 1_000_000);
    closeTo(row.estimated_output_cost, (50 * 8) / 1_000_000);
    closeTo(row.estimated_cost, (100 * 2 + 80 * 0.5 + 0 * 1 + 50 * 8) / 1_000_000);
    assert.ok(row.analyzed_at);

    // 覆盖：价格表翻倍后重算，五列同步翻倍。
    assert.equal(repairUsageCosts(storage.database(), priceTable(2), "all"), 1);
    const repriced = usageRow(storage, completed.requestId);
    assert.ok(repriced);
    closeTo(repriced.estimated_output_cost, (50 * 16) / 1_000_000);
    closeTo(repriced.estimated_cost, (100 * 4 + 80 * 1 + 0 * 2 + 50 * 16) / 1_000_000);

    // total_tokens 为空的行保持原样（费用仍为 NULL）。
    const untouched = usageRow(storage, noTotal.requestId);
    assert.ok(untouched);
    assert.equal(untouched.estimated_cost, null);

    // 价格表无匹配时跳过（保留原值），不写 NULL。
    assert.equal(repairUsageCosts(storage.database(), [], "all"), 0);
    closeTo(usageRow(storage, completed.requestId)?.estimated_cost, (100 * 4 + 80 * 1 + 0 * 2 + 50 * 16) / 1_000_000);
  });
});

// ─── 6. Agent 会话 / 客户端归属修复 ─────────────────────────────────────────

test("修复 Agent 会话：从 header JSON 还原会话与客户端归属，返回 camelCase 计数", () => {
  withStorage((storage) => {
    // L1：opencode，会话头 + 无客户端归属 → 会话三列与客户端两列都修复。
    const opencode = seedLog(storage, {
      reqHeadersJson: JSON.stringify({
        "User-Agent": "opencode/1.2.3",
        "X-Opencode-Session": "opencode-sess-1",
      }),
      clientId: null,
      clientName: null,
    });
    // L2：claude-code，会话头 + 已有客户端归属 → 只修会话三列，客户端不被覆盖。
    const claude = seedLog(storage, {
      reqHeadersJson: JSON.stringify({
        "User-Agent": "claude-cli/2.0.1",
        "x-claude-code-session-id": "claude-sess-1",
      }),
      clientId: "custom-cli",
      clientName: "Custom CLI",
    });
    // L3：只有 UA，无会话头 → 只补客户端归属。
    const uaOnly = seedLog(storage, {
      reqHeadersJson: JSON.stringify({ "user-agent": "claude-cli/2.0.1" }),
      clientId: null,
      clientName: null,
    });
    // L4：Header JSON 无法识别任何身份 → 跳过。
    const unrecognized = seedLog(storage, {
      reqHeadersJson: JSON.stringify({ "user-agent": "curl/8.0" }),
      clientId: null,
      clientName: null,
    });
    // L5：同一 request_id 的两次 attempt，会话列按 request_id 全量更新（2 行）。
    const sharedRequestId = `req-${randomUUID()}`;
    const attemptHeaders = JSON.stringify({
      "user-agent": "claude-cli/2.0.1",
      "x-claude-code-session-id": "claude-sess-2",
    });
    seedLog(storage, { requestId: sharedRequestId, reqHeadersJson: attemptHeaders, clientId: null, clientName: null });
    seedLog(storage, {
      requestId: sharedRequestId,
      reqHeadersJson: attemptHeaders,
      clientId: null,
      clientName: null,
      isLastAttempt: false,
    });

    const result = repairAgentSessions(storage.database(), "all", BUILTIN_UA_RULES);

    assert.deepEqual(Object.keys(result).sort(), [
      "repairedClients",
      "repairedLogs",
      "repairedRequests",
      "scannedRequests",
      "skippedRequests",
    ]);
    assert.equal(result.scannedRequests, 5, "按 request_id 分组后的扫描数");
    assert.equal(result.repairedRequests, 4);
    assert.equal(result.skippedRequests, 1);
    assert.equal(result.skippedRequests, result.scannedRequests - result.repairedRequests);
    assert.equal(result.repairedLogs, 4, "L1 + L2 + L5 的两行");
    // 客户端归属按 request_id 计数：L1（opencode）、L3（仅 UA）、L5（同一 request 两次 attempt）。
    assert.equal(result.repairedClients, 3);

    // L1：opencode 会话 + 客户端归属。
    const opencodeLog = logRow(storage, opencode.logId);
    assert.equal(opencodeLog.agent_type, "opencode");
    assert.equal(opencodeLog.agent_session_id, "opencode-sess-1");
    assert.equal(opencodeLog.parent_agent_session_id, null);
    assert.equal(opencodeLog.client_id, "opencode");
    assert.equal(opencodeLog.client_name, "OpenCode");

    // L2：会话修复，但已有客户端归属保留。
    const claudeLog = logRow(storage, claude.logId);
    assert.equal(claudeLog.agent_type, "claude-code");
    assert.equal(claudeLog.agent_session_id, "claude-sess-1");
    assert.equal(claudeLog.client_id, "custom-cli");
    assert.equal(claudeLog.client_name, "Custom CLI");

    // L3：只补客户端归属，agent 三列保持 NULL。
    const uaOnlyLog = logRow(storage, uaOnly.logId);
    assert.equal(uaOnlyLog.agent_type, null);
    assert.equal(uaOnlyLog.agent_session_id, null);
    assert.equal(uaOnlyLog.client_id, "claude-code");
    assert.equal(uaOnlyLog.client_name, "Claude Code");

    // L4：无法识别 → 全部保持原样。
    const unrecognizedLog = logRow(storage, unrecognized.logId);
    assert.equal(unrecognizedLog.agent_type, null);
    assert.equal(unrecognizedLog.client_id, null);

    // 幂等：再次执行时 L1/L2/L3 仍会被识别，但客户端归属已非空 → repairedClients 为 0。
    const second = repairAgentSessions(storage.database(), "all", BUILTIN_UA_RULES);
    assert.equal(second.scannedRequests, 5);
    assert.equal(second.repairedClients, 0, "已有归属的记录不再计入客户端修复");
  });
});