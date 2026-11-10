// SQLite 存储层契约测试（node:test）。
//
// 覆盖 docs/migration/node-host.md §5 的关键行为：
// 1. 真实生产库副本可直接打开、迁移幂等、账号/路由/预设/模型形状正确；
// 2. 请求日志分页/详情/筛选项与 Rust 输出字段命名一致；
// 3. usage_today_summary / usage_summary_range 聚合；
// 4. app_meta 读写；
// 5. 写账号/路由后快照一致；
// 6. 重复打开同一库不丢数据（迁移幂等）。
//
// 真实库副本：默认 /home/nichangen/.local/state/flowlet-docker-migration-20261109/flowlet.sqlite
// （含真实 API Key，测试只读拷贝、不打印密钥）；不存在时自动跳过真实库用例。
import { strict as assert } from "node:assert";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { SqliteStorage } from "../index.ts";
import { upsertAgentSessionMetadata } from "../sessions.ts";
import { currentOsFamily, detectPlatform, resolvePlatform } from "../devices.ts";
import {
  initializeChannelPresets,
  loadChannelsConfig,
  loadOrCreateConfig,
  loadRuntimeSnapshot,
} from "../../config/index.ts";
import { loadModelCatalog } from "../../catalog/index.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const REAL_DB = "/home/nichangen/.local/state/flowlet-docker-migration-20261109/flowlet.sqlite";
const hasRealDb = existsSync(REAL_DB);

function tempDir(): string {
  // 保持在工作区内（file sandbox 只保证 workspace 可写）。
  const base = path.join(process.cwd(), ".flowlet-test-tmp");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, "storage-"));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
}

function withRealDbCopy(run: (dbPath: string) => void): void {
  const dir = tempDir();
  try {
    const dbPath = path.join(dir, "flowlet.sqlite");
    copyFileSync(REAL_DB, dbPath);
    run(dbPath);
  } finally {
    cleanup(dir);
  }
}

function storageFor(dbPath: string): SqliteStorage {
  return new SqliteStorage(dbPath);
}

function seedRequestLog(
  storage: SqliteStorage,
  overrides: Record<string, unknown> = {},
): { requestId: string; logId: string } {
  const requestId = String(overrides.request_id ?? `req-${randomUUID()}`);
  const logId = storage.insertRequestLog({
    request_id: requestId,
    agent_type: "claude-code",
    agent_session_id: "session-1",
    client_id: "claude-code",
    client_name: "Claude Code",
    channel_id: "deepseek",
    channel_name: "DeepSeek",
    account_id: "account-unit",
    account_name: "Unit",
    client_protocol: "openai",
    upstream_protocol: "openai",
    virtual_model: "deepseek-v4-flash",
    public_model: "deepseek-v4-flash",
    upstream_model: "deepseek-v4-flash",
    request_type: "chat",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    latency_ms: 120,
    is_stream: false,
    fallback_count: 0,
    route_reason: "direct",
    ttfb_ms: 80,
    duration_ms: 120,
    attempt_seq: 0,
    req_headers_json: JSON.stringify({ authorization: "[redacted]" }),
    req_body_b64: "aGVsbG8=",
    res_headers_json: null,
    res_body_b64: null,
    is_last_attempt: true,
    upstream_url: "https://api.example.com/v1/chat/completions",
    ...overrides,
  });
  storage.insertUsageRecord({
    request_id: requestId,
    client_id: "claude-code",
    client_name: "Claude Code",
    channel_id: "deepseek",
    channel_name: "DeepSeek",
    account_id: "account-unit",
    account_name: "Unit",
    client_protocol: "openai",
    upstream_protocol: "openai",
    virtual_model: "deepseek-v4-flash",
    upstream_model: "deepseek-v4-flash",
    input_tokens: 100,
    input_cached_tokens: 40,
    input_uncached_tokens: 60,
    output_tokens: 20,
    total_tokens: 120,
    usage_status: "complete",
    usage_source: "upstream_response",
  });
  return { requestId, logId };
}

test("真实库副本：直接打开、迁移幂等、形状正确且数据不丢", { skip: !hasRealDb }, () => {
  withRealDbCopy((dbPath) => {
    const storage = storageFor(dbPath);
    const accounts = storage.listChannelAccounts();
    const presets = storage.listChannelPresets();
    const routes = storage.listRouteCandidates();
    const models = storage.listChannelModels();
    assert.ok(accounts.length >= 14, `账号数 ${accounts.length}`);
    assert.ok(presets.length >= 9, `预设数 ${presets.length}`);
    assert.ok(routes.length > 0, "路由候选必须存在");
    assert.ok(models.length > 0, "channel_models 目录必须可读");
    // 旧聚合模型路由（flowlet-pro/flash）必须被改写成直接模型路由，不再作为对外模型。
    assert.equal(
      routes.filter((route) => ["flowlet-pro", "flowlet-flash"].includes(String(route.virtual_model_id))).length,
      0,
      "旧聚合模型路由必须已改写",
    );
    // 账号关键字段（snake_case）逐一存在。
    const account = accounts[0];
    for (const field of [
      "id",
      "workspace_account_id",
      "channel_id",
      "name",
      "api_key",
      "enabled",
      "priority",
      "resource_mode",
      "resource_sync_mode",
      "credential_status",
      "synced_models",
      "exposed_models",
      "created_at",
      "updated_at",
      "use_upstream_proxy",
    ]) {
      assert.ok(field in account, `账号缺少字段 ${field}`);
    }
    // none-vs-empty 语义：exposed_models 为 null 或数组，不会被读成 []（null 必须保留）。
    const nullableExposed = accounts.filter((item) => item.exposed_models === null);
    assert.ok(nullableExposed.length > 0, "真实库应存在尚未用新流程配置的账号（null）");
    // 路由字段与协议值。
    const route = routes[0];
    assert.ok(["openai", "anthropic", "responses"].includes(String(route.client_protocol)));
    assert.equal(typeof route.enabled, "boolean");
    assert.equal(storage.getAppMeta("schema_version"), "2026.08.02");
    // 老库启动迁移必须自动补建 agent_session_metadata（CREATE TABLE IF NOT EXISTS，只增不改）。
    const addedTable = storage
      .database()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_session_metadata'")
      .get() as { name?: string } | undefined;
    assert.equal(addedTable?.name, "agent_session_metadata");
    // 迁移幂等：重复打开（不关闭首个连接，WAL 允许）后再读，数量一致。
    const second = storageFor(dbPath);
    assert.equal(second.listChannelAccounts().length, accounts.length);
    assert.equal(second.listRouteCandidates().length, routes.length);
    second.close();
    storage.close();
  });
});

test("真实库副本：runtime 快照 + 默认路由合并保持稳定", { skip: !hasRealDb }, () => {
  withRealDbCopy((dbPath) => {
    const dir = path.dirname(dbPath);
    const configPath = path.join(dir, "config.json");
    const repoConfigPath = path.join(REPO_ROOT, "config.json");
    const config = loadOrCreateConfig(configPath, repoConfigPath);
    const channelsConfig = loadChannelsConfig(config);
    loadModelCatalog(dir, REPO_ROOT);
    const storage = storageFor(dbPath);
    initializeChannelPresets(storage, channelsConfig);

    const runtime = loadRuntimeSnapshot(storage, channelsConfig, { upstreamProxyActive: false });
    const snapshot = runtime.snapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "accounts",
      "channels",
      "routes",
      "rules",
      "virtual_models",
    ]);
    assert.ok((snapshot.accounts as unknown[]).length >= 14);
    assert.ok((snapshot.routes as unknown[]).length >= 44);
    assert.ok(Array.isArray(snapshot.rules));
    // 二次执行不新增路由（merge_default_routes 只追加缺失签名）。
    const before = storage.listRouteCandidates().length;
    const runtime2 = loadRuntimeSnapshot(storage, channelsConfig, { upstreamProxyActive: false });
    assert.equal(storage.listRouteCandidates().length, before);
    assert.equal(runtime2.revision(), 1);
    // RuntimeConfig update 递增 revision 且不改原快照。
    const revision = runtime2.update((draft) => {
      (draft.rules as unknown[]).push({ id: "rule-test" });
    });
    assert.equal(revision, 2);
    assert.equal((runtime2.snapshot().rules as unknown[]).length, 1);
    storage.close();
  });
});

test("请求日志：分页 / 详情 / 筛选项 / 今日用量", () => {
  const storage = storageFor(":memory:");
  const first = seedRequestLog(storage);
  const second = seedRequestLog(storage, {
    request_id: "req-error",
    status: 500,
    error_message: "upstream failed",
    is_stream: true,
    res_headers_json: JSON.stringify({ "content-type": "application/json" }),
  });

  const page = storage.listRequestLogsPage({
    page: 1,
    page_size: 50,
    status: "all",
    client_id: "",
    channel_id: "",
    search: "",
    time_range: "all",
  });
  assert.equal(page.total, 2);
  assert.equal(page.pageSize, 50);
  const summary = page.summary as Record<string, unknown>;
  assert.equal(summary.requestCount, 2);
  assert.equal(summary.successCount, 1);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.knownTokens, 240);
  assert.equal(summary.inputTokens, 200);
  assert.equal(summary.inputCachedTokens, 80);
  assert.equal(summary.estimatedCost, 0); // 无价格表 → 0 费用
  const rows = page.rows as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  const success = rows.find((row) => row.request_id === first.requestId)!;
  assert.equal(success.client_id, "claude-code");
  assert.equal(success.client_name, "Claude Code");
  assert.equal(success.agent_type, "claude-code");
  assert.equal(success.agent_session_id, "session-1");
  assert.equal(success.input_tokens, 100);
  assert.equal(success.total_tokens, 120);
  assert.equal(success.is_last_attempt, true);
  assert.equal(success.is_stream, false);

  // 筛选：错误状态 / 客户端 / 模型维度。
  const errorPage = storage.listRequestLogsPage({
    page: 1,
    page_size: 10,
    status: "error",
    client_id: "",
    channel_id: "",
    search: "",
  });
  assert.equal(errorPage.total, 1);
  const searchPage = storage.listRequestLogsPage({
    page: 1,
    page_size: 10,
    status: "all",
    client_id: "",
    channel_id: "",
    search: "upstream failed",
  });
  assert.equal(searchPage.total, 1);
  const modelPage = storage.listRequestLogsPage({
    page: 1,
    page_size: 10,
    status: "all",
    client_id: "",
    channel_id: "",
    search: "",
    model: "deepseek-v4-flash",
    model_kind: "public",
  });
  assert.equal(modelPage.total, 2);

  // 详情：全部 attempt + body 字段。
  const detail = storage.listRequestLogsByRequestId(second.requestId);
  assert.equal(detail.length, 1);
  assert.equal(detail[0].res_headers_json, JSON.stringify({ "content-type": "application/json" }));
  assert.equal(detail[0].capture_state, "ready");
  // Body 只在 .flcap 帧里：内联列为 NULL，详情从帧 hydrate。
  const inline = storage.database().prepare("SELECT req_body_b64, res_body_b64 FROM request_logs WHERE id = ?1").get(detail[0].id as string) as { req_body_b64: string | null; res_body_b64: string | null };
  assert.equal(inline.req_body_b64, null);
  assert.equal(inline.res_body_b64, null);
  const firstDetail = storage.listRequestLogsByRequestId(first.requestId)[0];
  assert.equal(firstDetail.req_body_b64, "aGVsbG8=");
  assert.equal(firstDetail.capture_state, "ready");

  // update_request_log_timing：仅更新 is_stream 的 last attempt。
  storage.updateRequestLogTiming(second.requestId, {
    ttfb_ms: 30,
    ttft_ms: 45,
    duration_ms: 900,
    res_body_b64: "ZmFrZQ==",
    error_message: "stream aborted",
  });
  const updated = storage.listRequestLogsByRequestId(second.requestId)[0];
  assert.equal(updated.ttft_ms, 45);
  assert.equal(updated.duration_ms, 900);
  assert.equal(updated.res_body_b64, "ZmFrZQ==");
  assert.equal(updated.error_message, "stream aborted");
  // 非流式日志不受影响。
  assert.equal(storage.listRequestLogsByRequestId(first.requestId)[0].duration_ms, 120);

  // 筛选项。
  assert.deepEqual(storage.listRequestLogClients(), [{ id: "claude-code", name: "Claude Code" }]);
  const models = storage.listRequestLogModels();
  assert.deepEqual(models.publicModels, ["deepseek-v4-flash"]);
  assert.deepEqual(models.upstreamModels, ["deepseek-v4-flash"]);
  // 渠道 / 渠道账号筛选项（账号名回退日志落库的 account_name，channel_accounts 无对应行）。
  assert.deepEqual(storage.listRequestLogChannelAccounts(), {
    channels: [{ id: "deepseek", name: "DeepSeek" }],
    accounts: [
      { id: "account-unit", name: "Unit", channelId: "deepseek", channelName: "DeepSeek" },
    ],
  });
  // channel_accounts 存在同名行时账号名优先取当前名称（改名后立即反映）。
  storage
    .database()
    .prepare(
      `INSERT INTO channel_accounts (id, channel_id, name, api_key, created_at, updated_at)
       VALUES ('account-unit', 'deepseek', 'Renamed Unit', 'sk-test', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z')`,
    )
    .run();
  assert.deepEqual(storage.listRequestLogChannelAccounts().accounts, [
    { id: "account-unit", name: "Renamed Unit", channelId: "deepseek", channelName: "DeepSeek" },
  ]);

  // 今日用量：单条聚合与分页汇总同口径。
  const today = storage.usageTodaySummary();
  assert.equal(today.total_tokens, 240);
  assert.equal(today.input_tokens, 200);
  assert.equal(today.output_tokens, 40);

  // 用量聚合（日期维度）包含两条请求。
  const summaryRows = storage.usageSummaryRange(null, null, "day", "device-test");
  assert.ok(summaryRows.length >= 1);
  const todayRow = summaryRows[0];
  assert.equal(todayRow.device_id, "device-test");
  assert.equal(todayRow.request_count, 2);
  assert.equal(todayRow.known_tokens, 240);
  assert.equal(typeof todayRow.date, "string");

  // 渠道账号筛选：非空 account_id 精确过滤；缺省 / 空串不过滤（旧请求兼容）。
  seedRequestLog(storage, {
    request_id: "req-other-account",
    channel_id: "kimi",
    channel_name: "Kimi",
    account_id: "account-other",
    account_name: "Other",
  });
  const baseFilter = {
    page: 1,
    page_size: 10,
    status: "all",
    client_id: "",
    channel_id: "",
    search: "",
  };
  const unitPage = storage.listRequestLogsPage({ ...baseFilter, account_id: "account-unit" });
  assert.equal(unitPage.total, 2);
  assert.ok(
    (unitPage.rows as Array<Record<string, unknown>>).every((row) => row.account_id === "account-unit"),
  );
  const otherPage = storage.listRequestLogsPage({ ...baseFilter, account_id: "account-other" });
  assert.equal(otherPage.total, 1);
  assert.equal((otherPage.rows as Array<Record<string, unknown>>)[0].account_id, "account-other");
  assert.equal((otherPage.rows as Array<Record<string, unknown>>)[0].account_name, "Other");
  assert.equal(storage.listRequestLogsPage(baseFilter).total, 3);
  assert.equal(storage.listRequestLogsPage({ ...baseFilter, account_id: "" }).total, 3);
  // 筛选项合并全部渠道/账号，并按 (渠道名, 账号名, id) 排序。
  const options = storage.listRequestLogChannelAccounts();
  assert.deepEqual(
    (options.channels as Array<Record<string, unknown>>).map((item) => item.id),
    ["deepseek", "kimi"],
  );
  assert.deepEqual(options.accounts, [
    { id: "account-unit", name: "Renamed Unit", channelId: "deepseek", channelName: "DeepSeek" },
    { id: "account-other", name: "Other", channelId: "kimi", channelName: "Kimi" },
  ]);
  storage.close();
});

test("请求日志：cleanup_old_logs 返回元组并清理两表", () => {
  const storage = storageFor(":memory:");
  seedRequestLog(storage);
  // 直接改 created_at 模拟过期日志。
  storage.database().prepare("UPDATE request_logs SET created_at = datetime('now', '-30 days')").run();
  storage.database().prepare("UPDATE usage_records SET created_at = datetime('now', '-30 days')").run();
  const [logs, usage] = storage.cleanupOldLogs(7);
  assert.equal(logs, 1);
  assert.equal(usage, 1);
  assert.equal(storage.listRequestLogsPage({ page: 1, page_size: 10, status: "all", client_id: "", channel_id: "", search: "" }).total, 0);
  storage.close();
});

test("app_meta 读写 + 账号/路由写后快照一致", () => {
  const storage = storageFor(":memory:");
  assert.equal(storage.getAppMeta("missing"), null);
  storage.setAppMeta("log_capture_config", JSON.stringify({ redact_sensitive_headers: true }));
  assert.equal(storage.getAppMeta("log_capture_config"), JSON.stringify({ redact_sensitive_headers: true }));

  const account = {
    id: "account-1",
    channel_id: "deepseek",
    name: "DeepSeek 1",
    api_key: "sk-test",
    enabled: true,
    priority: 0,
    resource_mode: null,
    resource_sync_mode: "manual",
    base_url_override: null,
    anthropic_base_url_override: null,
    use_upstream_proxy: null,
    last_used_at: null,
    last_error: null,
    credential_status: "healthy",
    synced_models: ["deepseek-v4-flash"],
    models_synced_at: "2026-11-09T00:00:00Z",
    exposed_models: ["deepseek-v4-flash"],
    created_at: "2026-11-09T00:00:00Z",
    updated_at: "2026-11-09T00:00:00Z",
  };
  const saved = storage.saveChannelAccounts([{ ...account, credential_status: "invalid_key" }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].credential_status, "healthy");
  assert.deepEqual(saved[0].exposed_models, ["deepseek-v4-flash"]);

  storage.saveRouteCandidates([
    {
      id: "route-1",
      virtual_model_id: "deepseek-v4-flash",
      channel_id: "deepseek",
      account_id: "account-1",
      upstream_model: "deepseek-v4-flash",
      client_protocol: "openai",
      priority: 0,
      enabled: true,
      created_at: "2026-11-09T00:00:00Z",
      updated_at: "2026-11-09T00:00:00Z",
    },
  ]);
  const routes = storage.listRouteCandidates();
  assert.equal(routes.length, 1);
  assert.equal(routes[0].virtual_model_id, "deepseek-v4-flash");
  assert.equal(routes[0].client_protocol, "openai");

  // invalid_key 保留语义：同 key 再保存时保留 invalid_key + last_error。
  storage.markAccountCredentialInvalid("account-1");
  storage.updateAccountLastError("account-1", "401 invalid key");
  const current = storage.listChannelAccounts()[0];
  const resaved = storage.saveChannelAccounts([current]);
  assert.equal(resaved[0].credential_status, "invalid_key");
  assert.equal(resaved[0].last_error, "401 invalid key");
  storage.close();
});

test("设备用量：本机聚合 + 已同步设备合并口径", () => {
  const storage = storageFor(":memory:");
  seedRequestLog(storage);
  const current = storage.deviceDailyUsage("device-current", "device-current");
  assert.equal(current.length, 1);
  assert.equal(current[0].requestCount, 1);
  assert.equal(current[0].knownTokens, 120);
  // 全部设备在本机数据下等于本机口径。
  assert.deepEqual(storage.deviceDailyUsage("device-current", null), current);
  const devices = storage.listKnownDevices({
    device_id: "device-current",
    created_at: "2026-01-01T00:00:00Z",
    display_name: "Test Host",
    platform: "ubuntu",
  });
  assert.equal(devices.length, 1);
  assert.equal(devices[0].isCurrent, true);
  assert.equal(devices[0].displayName, "Test Host");
  assert.equal(devices[0].requestCount, 1);
  // 未知设备返回空。
  assert.deepEqual(storage.deviceDailyUsage("device-current", "device-other"), []);
  assert.deepEqual(storage.deviceHourlyUsage("device-current", "device-current").length, 1);
  storage.close();
});


test("已观测 Agent 会话：列表/父会话筛选/子会话/用量", () => {
  const storage = storageFor(":memory:");
  seedRequestLog(storage, {
    request_id: "req-parent",
    agent_session_id: "session-parent",
    parent_agent_session_id: null,
  });
  seedRequestLog(storage, {
    request_id: "req-child",
    agent_session_id: "session-child",
    parent_agent_session_id: "session-parent",
  });
  const page = storage.listObservedAgentSessionsPage({ page: 1, page_size: 20 });
  assert.equal(page.total, 1, "只返回根会话");
  const rows = page.rows as Array<Record<string, unknown>>;
  assert.equal(rows[0].sessionId, "session-parent");
  assert.equal(rows[0].parentSessionId, null);
  const children = storage.listObservedAgentSessionChildren("claude-code", "session-parent");
  assert.equal(children.length, 1);
  assert.equal(children[0].sessionId, "session-child");
  assert.equal(children[0].parentSessionId, "session-parent");
  // 搜索命中子会话时向上追溯根会话（Rust 语义）。
  const searched = storage.listObservedAgentSessionsPage({ page: 1, page_size: 20, search: "session-child" });
  assert.equal(searched.total, 1, "命中子会话时向上追溯，保留根会话");
  assert.equal((searched.rows as Array<Record<string, unknown>>)[0].sessionId, "session-parent");
  const missing = storage.listObservedAgentSessionsPage({ page: 1, page_size: 20, search: "no-such-session" });
  assert.equal(missing.total, 0);
  const usage = storage.agentSessionFlowletUsage("claude-code", "session-parent");
  assert.ok(usage);
  assert.equal(usage.totalTokens, 120);
  assert.equal(storage.agentSessionFlowletUsage("claude-code", "missing"), null);
  storage.close();
});

test("agent_session_metadata：建表 / upsert / 会话聚合 JOIN 出 title 与 projectPath", () => {
  const storage = storageFor(":memory:");
  // (e) 新建库后表必须存在（老库由 migrate 里的 CREATE TABLE IF NOT EXISTS 补建）。
  const table = storage
    .database()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_session_metadata'")
    .get() as { name?: string } | undefined;
  assert.equal(table?.name, "agent_session_metadata");
  const columns = storage
    .database()
    .prepare("SELECT name, type, [notnull], dflt_value, pk FROM pragma_table_info('agent_session_metadata') ORDER BY cid")
    .all() as Array<Record<string, unknown>>;
  assert.deepEqual(
    columns.map((column) => column.name),
    ["agent_type", "session_id", "title", "project_path", "source", "updated_at"],
  );
  // 主键是 (agent_type, session_id) 复合主键（pk 序号 1、2），source 默认 'derived'。
  assert.equal(Number(columns.find((column) => column.name === "agent_type")?.pk), 1);
  assert.equal(Number(columns.find((column) => column.name === "session_id")?.pk), 2);
  assert.equal(columns.find((column) => column.name === "source")?.dflt_value, "'derived'");
  assert.equal(Number(columns.find((column) => column.name === "title")?.notnull), 0);

  // (a) 请求日志 + 元数据 → 列表返回 title / projectPath（此前硬编码 null）。
  seedRequestLog(storage, {
    request_id: "req-root",
    agent_session_id: "session-root",
    parent_agent_session_id: null,
  });
  storage.upsertAgentSessionMetadata({
    agent_type: "claude-code",
    session_id: "session-root",
    title: "修复登录回调",
    project_path: "/home/dev/work/flowlet",
  });
  const page = storage.listObservedAgentSessionsPage({ page: 1, page_size: 20 });
  assert.equal(page.total, 1);
  const root = (page.rows as Array<Record<string, unknown>>)[0];
  assert.equal(root.title, "修复登录回调");
  assert.equal(root.projectPath, "/home/dev/work/flowlet");
  // source 缺省 derived，updated_at 由存储侧写入 ISO 时间。
  const stored = storage
    .database()
    .prepare("SELECT source, updated_at FROM agent_session_metadata WHERE agent_type = ?1 AND session_id = ?2")
    .get("claude-code", "session-root") as { source: string; updated_at: string };
  assert.equal(stored.source, "derived");
  assert.ok(!Number.isNaN(Date.parse(stored.updated_at)));

  // (b) 按标题搜索命中，并能从子会话回溯到根会话。
  seedRequestLog(storage, {
    request_id: "req-child-meta",
    agent_session_id: "session-child-meta",
    parent_agent_session_id: "session-root",
  });
  const byTitle = storage.listObservedAgentSessionsPage({
    page: 1,
    page_size: 20,
    search: "修复登录",
  });
  assert.equal(byTitle.total, 1);
  assert.equal((byTitle.rows as Array<Record<string, unknown>>)[0].sessionId, "session-root");
  // 子会话自身也带元数据时，搜索命中子会话同样向上追溯根会话。
  storage.upsertAgentSessionMetadata({
    agent_type: "claude-code",
    session_id: "session-child-meta",
    title: "子代理检索日志",
    project_path: "/home/dev/work/flowlet",
  });
  const byChildTitle = storage.listObservedAgentSessionsPage({
    page: 1,
    page_size: 20,
    search: "子代理",
  });
  assert.equal(byChildTitle.total, 1);
  assert.equal((byChildTitle.rows as Array<Record<string, unknown>>)[0].sessionId, "session-root");
  // 按项目路径过滤（前缀语义）与按路径搜索都必须命中。
  const byProject = storage.listObservedAgentSessionsPage({
    page: 1,
    page_size: 20,
    project_path: "/home/dev/work/flowlet",
  });
  assert.equal(byProject.total, 1);
  assert.equal((byProject.rows as Array<Record<string, unknown>>)[0].sessionId, "session-root");
  assert.equal(
    storage.listObservedAgentSessionsPage({
      page: 1,
      page_size: 20,
      project_path: "/home/dev/work/other",
    }).total,
    0,
  );
  const byProjectSearch = storage.listObservedAgentSessionsPage({
    page: 1,
    page_size: 20,
    search: "work/flowlet",
  });
  assert.equal(byProjectSearch.total, 1);

  // (c) 先写 title + project，再只写 title（project 为 null / 空串）→ project 不被清空。
  storage.upsertAgentSessionMetadata({
    agent_type: "claude-code",
    session_id: "session-root",
    title: "修复登录回调（改名）",
    project_path: null,
  });
  let metadata = storage
    .database()
    .prepare("SELECT title, project_path FROM agent_session_metadata WHERE agent_type = ?1 AND session_id = ?2")
    .get("claude-code", "session-root") as { title: string | null; project_path: string | null };
  assert.equal(metadata.title, "修复登录回调（改名）");
  assert.equal(metadata.project_path, "/home/dev/work/flowlet");
  // 空串不是 NULL，必须先归一成 NULL，否则 COALESCE 会把它当成有效值覆盖历史。
  storage.upsertAgentSessionMetadata({
    agent_type: "claude-code",
    session_id: "session-root",
    title: "",
    project_path: "",
  });
  metadata = storage
    .database()
    .prepare("SELECT title, project_path FROM agent_session_metadata WHERE agent_type = ?1 AND session_id = ?2")
    .get("claude-code", "session-root") as { title: string | null; project_path: string | null };
  assert.equal(metadata.title, "修复登录回调（改名）");
  assert.equal(metadata.project_path, "/home/dev/work/flowlet");
  // 模块级函数与门面方法共用同一实现。
  upsertAgentSessionMetadata(storage.database(), {
    agent_type: "claude-code",
    session_id: "session-root",
    title: "仅改标题",
    project_path: null,
  });
  const afterOnlyTitle = storage
    .database()
    .prepare("SELECT title, project_path, source FROM agent_session_metadata WHERE agent_type = ?1 AND session_id = ?2")
    .get("claude-code", "session-root") as { title: string | null; project_path: string | null; source: string };
  assert.equal(afterOnlyTitle.title, "仅改标题");
  assert.equal(afterOnlyTitle.project_path, "/home/dev/work/flowlet");
  assert.equal(afterOnlyTitle.source, "derived");
  // 空身份（agent_type / session_id 缺失）不写行，也不抛错。
  storage.upsertAgentSessionMetadata({ agent_type: "", session_id: "session-root", title: "orphan" });
  storage.upsertAgentSessionMetadata({ agent_type: "claude-code", title: "orphan" } as Record<string, unknown>);
  const orphanCount = storage
    .database()
    .prepare("SELECT COUNT(1) AS total FROM agent_session_metadata WHERE title = 'orphan'")
    .get() as { total: number };
  assert.equal(orphanCount.total, 0);
  storage.close();
});

test("agent_session_metadata：无会话身份的日志不受影响且不写表", () => {
  const storage = storageFor(":memory:");
  // (d) 未识别出 Agent 会话身份（agent_session_id 为 NULL）的日志不应产生元数据行。
  seedRequestLog(storage, { request_id: "req-no-session", agent_session_id: null });
  const page = storage.listObservedAgentSessionsPage({ page: 1, page_size: 20 });
  assert.equal(page.total, 0, "无 agent_session_id 的日志不进入已观测会话目录");
  const total = storage
    .database()
    .prepare("SELECT COUNT(1) AS total FROM agent_session_metadata")
    .get() as { total: number };
  assert.equal(total.total, 0, "表必须保持为空（代理侧不会为无会话身份的请求 upsert）");
  // 请求日志本身仍可正常读取。
  const logs = storage.listRequestLogsPage({
    page: 1,
    page_size: 10,
    status: "all",
    client_id: "",
    channel_id: "",
    search: "",
  });
  assert.equal(logs.total, 1);
  storage.close();
});

test("权限时间范围：usage_summary_range 过滤与校验", () => {
  const storage = storageFor(":memory:");
  seedRequestLog(storage);
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const end = new Date(now.getTime() + 24 * 3600 * 1000);
  const rows = storage.usageSummaryRange(start.toISOString(), end.toISOString(), "day", "device-test");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].request_count, 1);
  // 时间倒置 / 单侧缺失 / 非法粒度必须报错（Rust 同）。
  assert.throws(() => storage.usageSummaryRange(end.toISOString(), start.toISOString(), "day", "d"));
  assert.throws(() => storage.usageSummaryRange(start.toISOString(), null, "day", "d"));
  assert.throws(() => storage.usageSummaryRange(null, null, "week", "d"));
  assert.throws(() => storage.usageSummaryRange("not-a-date", end.toISOString(), "day", "d"));
  storage.close();
});


test("平台检测与收敛：与 Rust device_identity::resolve_platform 行为一致", () => {
  // Rust 测试用例：迁移到另一 OS / 泛化 linux 升级 / 保留已有发行版 / 填空白。
  assert.equal(resolvePlatform("windows", "ubuntu", "linux"), "ubuntu");
  assert.equal(resolvePlatform("linux", "windows", "windows"), "windows");
  assert.equal(resolvePlatform("linux", "ubuntu", "linux"), "ubuntu");
  assert.equal(resolvePlatform("linux", "linux", "linux"), "linux");
  assert.equal(resolvePlatform("ubuntu", "ubuntu", "linux"), "ubuntu");
  assert.equal(resolvePlatform("debian", "ubuntu", "linux"), "debian");
  assert.equal(resolvePlatform("", "ubuntu", "linux"), "ubuntu");
  assert.equal(resolvePlatform("windows", "windows", "windows"), "windows");
  // 当前宿主检测值为非空规范键；已知当前设备行 platform 会被收敛（linux → 发行版）。
  assert.ok(detectPlatform().length > 0);
  const identityPlatform = process.platform === "darwin" ? "macos" : process.platform;
  assert.equal(
    resolvePlatform(identityPlatform, detectPlatform(), currentOsFamily()),
    detectPlatform(),
  );
});

test("用量金额：配置价格表启用后写入 estimated_cost 与分类费用", () => {
  const storage = storageFor(":memory:");
  storage.setPrices([
    {
      id: "price-deepseek-deepseek-v4-flash",
      channel_id: "deepseek",
      upstream_model: "deepseek-v4-flash",
      input_uncached_price: 1,
      input_cached_price: 0.2,
      input_cache_write_price: null,
      output_price: 2,
      tiers: [],
      schedules: [],
      currency: "CNY",
      unit: "1M tokens",
      source_url: null,
      price_version: null,
      created_at: "2026-11-09T00:00:00Z",
      updated_at: "2026-11-09T00:00:00Z",
    },
  ]);
  const { requestId } = seedRequestLog(storage);
  const detail = storage.listRequestLogsByRequestId(requestId)[0];
  // 60 * 1/1e6 + 40 * 0.2/1e6 + 20 * 2/1e6 = 0.000108
  assert.ok(Math.abs(Number(detail.estimated_cost) - 0.000108) < 1e-12);
  assert.ok(Math.abs(Number(detail.estimated_input_uncached_cost) - 0.00006) < 1e-12);
  assert.ok(Math.abs(Number(detail.estimated_input_cached_cost) - 0.000008) < 1e-12);
  assert.ok(Math.abs(Number(detail.estimated_output_cost) - 0.00004) < 1e-12);
  storage.close();
});