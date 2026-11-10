// 桌面观测命令契约测试（node:test）。
//
// 运行：node --test packages/flowlet-core/src/desktop
//
// 覆盖：后台任务分页/详情/取消/清理、任务租约去重、原生用量汇总、会话客户端筛选、
// Flowlet 会话用量、Claude Code 时间线/最后交互/摘要、OpenCode 权限桥、
// 渠道预设同步预览/应用、成本账本数据源探测。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import type { JsonRow } from "../../../types.ts";
import type { DesktopContext } from "../../types.ts";
import { handlers } from "../../observability.ts";
import { SqliteStorage } from "../../../storage/index.ts";
import {
  releaseAgentDataSync,
  tryAcquireAgentDataSync,
} from "../../../agent/sessions/sync.ts";

const cleanup: Array<() => void> = [];

after(() => {
  for (const fn of cleanup.reverse()) fn();
});

let storage: SqliteStorage;

beforeEach(() => {
  const instance = new SqliteStorage(":memory:");
  storage = instance;
  cleanup.push(() => instance.close());
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `flowlet-desktop-${prefix}-`));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeContext(overrides: { configPath?: string; snapshot?: JsonRow } = {}): DesktopContext {
  const snapshot: JsonRow = overrides.snapshot ?? {
    channels: [],
    accounts: [],
    routes: [],
    rules: [],
    virtual_models: [],
  };
  return {
    storage,
    configPath: overrides.configPath ?? "",
    config: {},
    channelsConfig: {},
    runtimeConfig: {
      snapshot: () => snapshot,
      replace: () => undefined,
      update: (mutate: (draft: JsonRow) => void) => mutate(snapshot),
    },
    proxy: {
      start: async () => undefined,
      stop: async () => undefined,
      status: () => ({ running: false, bind_addr: "127.0.0.1:0", started_at: null }),
      bindConfig: () => ({ host: "127.0.0.1", port: 0, allow_lan: false, default_client_token: "t" }),
      setBindConfig: () => undefined,
    },
    adminToken: "admin-token-0123456789abcdef",
    clientToken: "client-token",
    staticDir: "",
    publicProxyUrl: "",
    catalogDir: "",
    deviceIdentity: {
      schema_version: 1,
      device_id: "device-1",
      created_at: "2026-11-10T00:00:00Z",
      display_name: "test",
      platform: "linux",
    },
    logCapture: {
      enabled: false,
      capture_headers: true,
      capture_bodies: false,
      redact_sensitive_headers: false,
      body_retention_days: 7,
      body_max_size_mb: 256,
      body_prune_ratio: 0.2,
    },
    upstreamProxy: { enabled: false, url: "" },
    secrets: {
      encrypt: (plaintext: string) => `v1:${plaintext}`,
      decrypt: (encoded: string) => encoded.replace(/^v1:/, ""),
    },
    desktop: {
      host: { invoke: async () => null },
      appVersion: "0.0.0",
      dataDir: "",
      portable: false,
    },
  } as unknown as DesktopContext;
}

async function invoke(ctx: DesktopContext, command: string, args: JsonRow = {}): Promise<unknown> {
  const handler = handlers[command];
  assert.ok(handler, `未注册命令 ${command}`);
  return handler(ctx, args);
}

interface SavedHomeEnv {
  home: string | undefined;
  dshHome: string | undefined;
  codexHome: string | undefined;
  appData: string | undefined;
  hermesHome: string | undefined;
}

let savedHomeEnv: SavedHomeEnv | null = null;

/**
 * 测试环境隔离：HOME 指向临时目录，同时把 DSH_HOME / HERMES_HOME 指到该临时目录下不存在的
 * 子目录、APPDATA 指向临时目录，因为宿主环境本身可能设置了它们（指向真实会话目录）。
 */
function setHomeEnv(home: string): void {
  savedHomeEnv = {
    home: process.env.HOME,
    dshHome: process.env.DSH_HOME,
    codexHome: process.env.CODEX_HOME,
    appData: process.env.APPDATA,
    hermesHome: process.env.HERMES_HOME,
  };
  process.env.HOME = home;
  process.env.DSH_HOME = path.join(home, "dsh-home");
  process.env.HERMES_HOME = path.join(home, "hermes-home");
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  delete process.env.CODEX_HOME;
}

function restoreHomeEnv(): void {
  if (savedHomeEnv === null) return;
  const saved = savedHomeEnv;
  savedHomeEnv = null;
  if (saved.home === undefined) delete process.env.HOME;
  else process.env.HOME = saved.home;
  if (saved.dshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = saved.dshHome;
  if (saved.codexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved.codexHome;
  if (saved.appData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = saved.appData;
  if (saved.hermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = saved.hermesHome;
}

function insertJob(
  id: string,
  fields: {
    status?: string;
    created_at?: string;
    jobType?: string;
    trigger?: string;
    stage?: string | null;
    cancelRequested?: number;
  } = {},
): void {
  storage.database().prepare(
    `INSERT INTO background_jobs
       (id, job_type, title, trigger_source, status, stage, progress_current, progress_total,
        summary_json, error_message, created_at, started_at, finished_at, updated_at, cancel_requested)
     VALUES (?1, ?2, '任务标题', ?3, ?4, ?5, 0, 0, NULL, NULL, ?6, NULL, NULL, ?6, ?7)`,
  ).run(
    id,
    fields.jobType ?? "agent-data-sync",
    fields.trigger ?? "manual",
    fields.status ?? "running",
    fields.stage === undefined ? "扫描" : fields.stage,
    fields.created_at ?? "2026-11-01 00:00:00",
    fields.cancelRequested ?? 0,
  );
}

function insertJobEvent(jobId: string, sequence: number, message: string): void {
  storage.database().prepare(
    `INSERT INTO background_job_events (id, job_id, sequence, level, stage, message, detail_json, created_at)
     VALUES (?1, ?2, ?3, 'info', '阶段', ?4, NULL, '2026-11-01 00:00:00')`,
  ).run(`${jobId}-evt-${sequence}`, jobId, sequence, message);
}

function insertRequestLog(fields: {
  id: string;
  requestId?: string;
  agentType?: string | null;
  sessionId?: string | null;
  parentSessionId?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  createdAt?: string;
  status?: number | null;
}): void {
  storage.database().prepare(
    `INSERT INTO request_logs
       (id, request_id, agent_type, agent_session_id, parent_agent_session_id,
        client_id, client_name, client_protocol, upstream_protocol, method, path,
        status, is_last_attempt, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'openai', 'openai', 'POST', '/v1/chat/completions',
             ?8, 1, ?9)`,
  ).run(
    fields.id,
    fields.requestId ?? fields.id,
    fields.agentType ?? null,
    fields.sessionId ?? null,
    fields.parentSessionId ?? null,
    fields.clientId ?? null,
    fields.clientName ?? null,
    fields.status === undefined ? 200 : fields.status,
    fields.createdAt ?? "2026-11-10 00:00:00",
  );
}

function insertUsageRecord(fields: { id: string; requestId: string; totalTokens: number; cost: number }): void {
  storage.database().prepare(
    `INSERT INTO usage_records
       (id, request_id, client_protocol, upstream_protocol, total_tokens, estimated_cost, created_at)
     VALUES (?1, ?2, 'openai', 'openai', ?3, ?4, '2026-11-10 00:00:00')`,
  ).run(fields.id, fields.requestId, fields.totalTokens, fields.cost);
}

function nativeSummaryJson(overrides: Partial<JsonRow> = {}): string {
  return JSON.stringify({
    sourceAvailable: true,
    truncated: false,
    turnCount: 2,
    usage: {
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 5,
      outputTokens: 40,
      reasoningTokens: 0,
      totalTokens: 165,
      cost: null,
      costCurrency: null,
    },
    models: ["claude-sonnet-4"],
    ...overrides,
  });
}

function sessionRowJson(overrides: Partial<JsonRow> = {}): string {
  return JSON.stringify({
    agentType: "claude-code",
    sessionId: "session-1",
    runtimeStatus: "unknown",
    title: "标题",
    projectPath: "/repo",
    parentSessionId: null,
    nativeStartedAt: "2026-11-09T20:00:00Z",
    nativeUpdatedAt: "2026-11-09T20:10:00Z",
    activityAt: "2026-11-09T20:10:00Z",
    ...overrides,
  });
}

function insertSnapshot(
  agentType: string,
  sessionId: string,
  summaryJson: string,
  sessionJson: string | null,
  syncedAt = "2026-11-09 20:11:00",
): void {
  storage.database().prepare(
    `INSERT INTO agent_session_snapshots
       (agent_type, session_id, fingerprint, summary_json, session_json, source_offset,
        parser_version, usage_ids_json, cursor_guard, synced_at)
     VALUES (?1, ?2, 'fp', ?3, ?4, 0, 4, '[]', '', ?5)`,
  ).run(agentType, sessionId, summaryJson, sessionJson, syncedAt);
}

// ─── 后台任务 ───────────────────────────────────────────────────────────────

describe("后台任务命令", () => {
  it("list_background_jobs 按 created_at 倒序分页，page/page_size 为必填", async () => {
    insertJob("job-1", { created_at: "2026-11-01 00:00:00", status: "succeeded" });
    insertJob("job-2", { created_at: "2026-11-02 00:00:00", status: "running" });
    insertJob("job-3", { created_at: "2026-11-03 00:00:00", status: "failed" });
    const ctx = makeContext();
    const first = (await invoke(ctx, "list_background_jobs", {
      filter: { page: 1, page_size: 2 },
    })) as JsonRow;
    assert.equal(first.total, 3);
    assert.equal(first.page, 1);
    assert.equal(first.pageSize, 2);
    assert.deepEqual(
      (first.rows as JsonRow[]).map((row) => row.id),
      ["job-3", "job-2"],
    );
    const second = (await invoke(ctx, "list_background_jobs", {
      filter: { page: 2, page_size: 2 },
    })) as JsonRow;
    assert.deepEqual(
      (second.rows as JsonRow[]).map((row) => row.id),
      ["job-1"],
    );
    // 行字段 camelCase（Rust BackgroundJobRow）。
    const row = (first.rows as JsonRow[])[0] as JsonRow;
    assert.equal(row.jobType, "agent-data-sync");
    assert.equal(row.triggerSource, "manual");
    assert.equal(row.cancelRequested, false);
  });

  it("list_background_jobs 支持 status 过滤并 clamp page_size", async () => {
    insertJob("job-1", { status: "succeeded" });
    insertJob("job-2", { status: "running" });
    const ctx = makeContext();
    const filtered = (await invoke(ctx, "list_background_jobs", {
      filter: { page: 0, page_size: 999, status: "running" },
    })) as JsonRow;
    assert.equal(filtered.page, 1);
    assert.equal(filtered.pageSize, 50);
    assert.equal(filtered.total, 1);
    assert.equal((filtered.rows as JsonRow[])[0]?.id, "job-2");
  });

  it("list_background_jobs 缺少必填 page 时报 serde 风格错误", async () => {
    await assert.rejects(
      () => invoke(makeContext(), "list_background_jobs", { filter: { page_size: 10 } }),
      /参数 filter: missing field `page`/,
    );
  });

  it("get_background_job_detail 按 sequence 返回事件，缺失时错误文案对齐 Rust", async () => {
    insertJob("job-1", { status: "succeeded" });
    insertJobEvent("job-1", 2, "第二条");
    insertJobEvent("job-1", 1, "第一条");
    const ctx = makeContext();
    const detail = (await invoke(ctx, "get_background_job_detail", { jobId: "job-1" })) as JsonRow;
    assert.equal((detail.job as JsonRow).id, "job-1");
    assert.deepEqual(
      (detail.events as JsonRow[]).map((event) => event.message),
      ["第一条", "第二条"],
    );
    const event = (detail.events as JsonRow[])[0] as JsonRow;
    assert.equal(event.jobId, "job-1");
    assert.equal(event.detailJson, null);
    await assert.rejects(
      () => invoke(ctx, "get_background_job_detail", { jobId: "missing" }),
      /任务日志不存在/,
    );
  });

  it("cancel_background_job 只取消 queued/running 任务并写 stage/cancel_requested", async () => {
    insertJob("job-running", { status: "running" });
    insertJob("job-done", { status: "succeeded" });
    const ctx = makeContext();
    assert.equal(await invoke(ctx, "cancel_background_job", { jobId: "job-running" }), true);
    const row = storage.database().prepare(
      "SELECT cancel_requested, stage FROM background_jobs WHERE id='job-running'",
    ).get() as JsonRow;
    assert.equal(Number(row.cancel_requested), 1);
    assert.equal(row.stage, "正在取消");
    assert.equal(await invoke(ctx, "cancel_background_job", { jobId: "job-done" }), false);
    assert.equal(await invoke(ctx, "cancel_background_job", { jobId: "missing" }), false);
  });

  it("cleanup_background_jobs 只删除非运行中的旧任务，keepDays clamp 到 1", async () => {
    insertJob("old-done", { status: "succeeded", created_at: "2026-01-01 00:00:00" });
    insertJob("old-running", { status: "running", created_at: "2026-01-01 00:00:00" });
    insertJobEvent("old-done", 1, "旧任务事件");
    insertJobEvent("old-running", 1, "运行中事件");
    const ctx = makeContext();
    const result = (await invoke(ctx, "cleanup_background_jobs", { keepDays: 30 })) as JsonRow;
    assert.equal(result.deletedJobs, 1);
    assert.equal(result.deletedEvents, 1);
    const remaining = storage.database()
      .prepare("SELECT id FROM background_jobs ORDER BY id")
      .all() as JsonRow[];
    assert.deepEqual(remaining.map((row) => row.id), ["old-running"]);
  });

  it("sync_agent_data 在租约被占用时返回去重结果（进程内租约语义）", async () => {
    // 租约是进程内单例：先清掉可能被上一个用例残留占用的租约，否则本用例拿不到租约。
    releaseAgentDataSync();
    assert.equal(tryAcquireAgentDataSync(), true);
    try {
      const result = (await invoke(makeContext(), "sync_agent_data", {
        force: true,
        triggerSource: "manual",
      })) as JsonRow;
      assert.deepEqual(result, {
        started: false,
        jobId: null,
        scanned: 0,
        changed: 0,
        failed: 0,
        message: "已有 Agent 数据同步正在运行",
      });
    } finally {
      releaseAgentDataSync();
    }
    // 释放后没有原生数据源时返回「没有发现需要整理的会话变化」。
    setHomeEnv(tempDir("home-empty"));
    try {
      const result = (await invoke(makeContext(), "sync_agent_data", {
        force: false,
        triggerSource: "scheduled",
      })) as JsonRow;
      assert.equal(result.started, false);
      assert.equal(result.message, "没有发现需要整理的会话变化");
    } finally {
      restoreHomeEnv();
    }
  });

  it("get_agent_sync_status 返回来源状态（按 agent_type 排序）", async () => {
    storage.database().prepare(
      `INSERT INTO agent_source_sync_state
         (agent_type, last_checked_at, last_synced_at, status, last_error,
          scanned_count, changed_count, failed_count, updated_at)
       VALUES ('pi', '2026-11-10 00:00:00', NULL, 'succeeded', NULL, 2, 1, 0, '2026-11-10 00:00:00'),
              ('claude-code', '2026-11-10 00:00:00', NULL, 'warning', 'boom', 1, 0, 1, '2026-11-10 00:00:00')`,
    ).run();
    const result = (await invoke(makeContext(), "get_agent_sync_status")) as JsonRow;
    assert.equal(result.running, false);
    const sources = result.sources as JsonRow[];
    assert.deepEqual(sources.map((source) => source.agentType), ["claude-code", "pi"]);
    assert.equal(sources[0]?.lastError, "boom");
    assert.equal(sources[1]?.changedCount, 1);
  });
});

// ─── 会话筛选 / 用量 ────────────────────────────────────────────────────────

describe("会话筛选与用量命令", () => {
  it("list_agent_session_clients 按客户端分组，未知名称回退「未知」", async () => {
    insertRequestLog({ id: "r1", sessionId: "s1", clientId: "claude-code", clientName: "Claude Code" });
    insertRequestLog({ id: "r2", sessionId: "s2", clientId: "claude-code", clientName: "Claude Code" });
    insertRequestLog({ id: "r3", sessionId: "s3", clientId: null, clientName: null });
    insertRequestLog({ id: "r4", sessionId: null, clientId: "ignored" });
    const clients = (await invoke(makeContext(), "list_agent_session_clients")) as JsonRow[];
    assert.deepEqual(clients, [
      { id: "claude-code", name: "Claude Code" },
      { id: "", name: "未知" },
    ]);
  });

  it("get_agent_session_flowlet_usage 无观测记录返回 null，有记录返回 token/费用", async () => {
    insertRequestLog({ id: "r1", sessionId: "s1", agentType: "claude-code" });
    insertUsageRecord({ id: "u1", requestId: "r1", totalTokens: 123, cost: 0.5 });
    const ctx = makeContext();
    assert.deepEqual(await invoke(ctx, "get_agent_session_flowlet_usage", {
      agentType: "claude-code",
      sessionId: "s1",
    }), { totalTokens: 123, estimatedCost: 0.5 });
    assert.equal(
      await invoke(ctx, "get_agent_session_flowlet_usage", {
        agentType: "claude-code",
        sessionId: "missing",
      }),
      null,
    );
  });

  it("agent_native_usage_summary 只返回根会话且排除已被 Flowlet 观测的会话", async () => {
    insertSnapshot("claude-code", "native-root", nativeSummaryJson(), sessionRowJson());
    insertSnapshot(
      "claude-code",
      "native-child",
      nativeSummaryJson(),
      sessionRowJson({ sessionId: "native-child", parentSessionId: "native-root" }),
    );
    insertSnapshot(
      "claude-code",
      "observed",
      nativeSummaryJson(),
      sessionRowJson({ sessionId: "observed" }),
    );
    insertRequestLog({ id: "r1", agentType: "claude-code", sessionId: "observed" });
    const rows = (await invoke(makeContext(), "agent_native_usage_summary")) as JsonRow[];
    assert.equal(rows.length, 1);
    const row = rows[0] as JsonRow;
    assert.equal(row.agentType, "claude-code");
    assert.equal(row.sessionId, "native-root");
    assert.equal(row.activityAt, "2026-11-09T20:10:00Z");
    assert.equal(row.turnCount, 2);
    assert.deepEqual(row.models, ["claude-sonnet-4"]);
    assert.deepEqual(row.usage, {
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 5,
      outputTokens: 40,
      reasoningTokens: 0,
      totalTokens: 165,
      cost: null,
      costCurrency: null,
      apiEquivalent: null,
    });
    const expectedDate = (() => {
      const date = new Date("2026-11-09T20:10:00Z");
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    })();
    assert.equal(row.date, expectedDate);
  });
});

// ─── 原生会话时间线（Claude Code fixture） ───────────────────────────────────

function writeClaudeFixture(home: string): string {
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  mkdirSync(projectDir, { recursive: true });
  const sessionFile = path.join(projectDir, "session-abc.jsonl");
  const records = [
    { type: "user", uuid: "u1", timestamp: "2026-11-09T20:00:01Z", cwd: "/repo", message: { role: "user", content: "第一个任务" } },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-11-09T20:00:02Z",
      message: {
        id: "msg-a1",
        role: "assistant",
        model: "claude-first",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
        content: [{ type: "text", text: "第一个结果" }],
      },
    },
    { type: "user", uuid: "u2", timestamp: "2026-11-09T20:10:01Z", message: { role: "user", content: "第二个任务" } },
    {
      type: "assistant",
      uuid: "a2",
      timestamp: "2026-11-09T20:10:02Z",
      message: {
        id: "msg-a2",
        role: "assistant",
        model: "claude-second",
        stop_reason: "end_turn",
        usage: { input_tokens: 20, cache_read_input_tokens: 1, output_tokens: 7 },
        content: [{ type: "text", text: "第二个结果" }],
      },
    },
  ];
  writeFileSync(sessionFile, records.map((record) => JSON.stringify(record)).join("\n"));
  return sessionFile;
}

describe("Agent 原生会话时间线", () => {
  it("Claude Code 时间线、切片、最后交互与摘要", async () => {
    const home = tempDir("claude-home");
    writeClaudeFixture(home);
    setHomeEnv(home);
    try {
      const ctx = makeContext();
      const timeline = (await invoke(ctx, "get_agent_session_timeline", {
        agentType: "claude-code",
        sessionId: "session-abc",
      })) as JsonRow;
      assert.equal(timeline.sourceAvailable, true);
      assert.equal(timeline.turnCount, 2);
      assert.deepEqual(timeline.models, ["claude-first", "claude-second"]);
      assert.deepEqual(
        (timeline.events as JsonRow[]).map((event) => event.kind),
        ["user-message", "assistant-message", "user-message", "assistant-message"],
      );
      assert.equal((timeline.usage as JsonRow).totalTokens, 45);

      const firstWindow = (await invoke(ctx, "get_agent_session_timeline", {
        agentType: "claude-code",
        sessionId: "session-abc",
        startedAt: "2026-11-09T20:00:00Z",
        endedAt: "2026-11-09T20:05:00Z",
      })) as JsonRow;
      assert.deepEqual(
        (firstWindow.events as JsonRow[]).map((event) => event.content),
        ["第一个任务", "第一个结果"],
      );
      assert.equal(firstWindow.turnCount, 1);
      assert.deepEqual(firstWindow.models, ["claude-first"]);
      assert.equal((firstWindow.usage as JsonRow).totalTokens, 17);

      const last = (await invoke(ctx, "get_agent_session_last_interaction", {
        agentType: "claude-code",
        sessionId: "session-abc",
      })) as JsonRow;
      assert.equal((last.events as JsonRow[]).length, 2);
      assert.equal((last.events as JsonRow[])[0]?.content, "第二个任务");

      const summary = (await invoke(ctx, "get_agent_session_native_summary", {
        agentType: "claude-code",
        sessionId: "session-abc",
      })) as JsonRow;
      assert.equal(summary.sourceAvailable, true);
      assert.equal(summary.turnCount, 2);
      assert.equal((summary.usage as JsonRow).totalTokens, 45);
    } finally {
      restoreHomeEnv();
    }
  });

  it("无会话文件时返回 sourceAvailable=false 的空时间线", async () => {
    const home = tempDir("claude-empty");
    setHomeEnv(home);
    try {
      const timeline = (await invoke(makeContext(), "get_agent_session_timeline", {
        agentType: "claude-code",
        sessionId: "missing-session",
      })) as JsonRow;
      assert.equal(timeline.sourceAvailable, false);
      assert.deepEqual(timeline.events, []);
      assert.equal(
        await invoke(makeContext(), "get_agent_session_last_interaction", {
          agentType: "claude-code",
          sessionId: "missing-session",
        }),
        null,
      );
    } finally {
      restoreHomeEnv();
    }
  });

  it("无效会话 ID / 未移植的 Agent 类型明确报错（不伪造空时间线）", async () => {
    await assert.rejects(
      () => invoke(makeContext(), "get_agent_session_timeline", { agentType: "claude-code", sessionId: "  " }),
      /无效的 Agent 会话 ID/,
    );
    await assert.rejects(
      () =>
        invoke(makeContext(), "get_agent_session_timeline", {
          agentType: "cursor-agent",
          sessionId: "s1",
        }),
      /暂不支持读取 Agent 会话时间线：cursor-agent/,
    );
    // DeepSeek Harness 已支持；会话文件不存在时按 Rust 语义报「未找到」，不返回空数据。
    await assert.rejects(
      () =>
        invoke(makeContext(), "get_agent_session_timeline", {
          agentType: "deepseek-harness",
          sessionId: "missing-dsh",
        }),
      /未找到 DeepSeek Harness 会话 missing-dsh/,
    );
  });
});

// ─── OpenCode 权限桥 ────────────────────────────────────────────────────────

describe("OpenCode 权限命令", () => {
  it("从 bridge state 读取会话权限，并通过 reply 文件回复", async () => {
    const home = tempDir("opencode-home");
    const bridgeDir = path.join(home, ".flowlet", "opencode-control");
    mkdirSync(bridgeDir, { recursive: true });
    writeFileSync(
      path.join(bridgeDir, "state-1.json"),
      JSON.stringify({
        serverUrl: "http://127.0.0.1:4096",
        updatedAt: Date.now(),
        permissions: [
          {
            id: "per_1",
            sessionID: "ses_1",
            permission: "bash",
            patterns: ["cargo test"],
            always: [],
            tool: { messageID: "msg_1", callID: "call_1" },
          },
          { id: "per_2", sessionId: "ses_other", permission: "edit" },
        ],
      }),
    );
    setHomeEnv(home);
    try {
      const ctx = makeContext();
      const report = (await invoke(ctx, "list_opencode_session_permissions", {
        sessionId: "ses_1",
      })) as JsonRow;
      assert.equal(report.available, true);
      assert.equal(report.serverUrl, "http://127.0.0.1:4096");
      const permissions = report.permissions as JsonRow[];
      assert.equal(permissions.length, 1);
      assert.equal(permissions[0]?.sessionId, "ses_1");
      assert.deepEqual(permissions[0]?.tool, { messageId: "msg_1", callId: "call_1" });

      assert.equal(
        await invoke(ctx, "reply_opencode_permission", {
          permissionId: "per_1",
          decision: "allow_once",
        }),
        null,
      );
      const reply = JSON.parse(
        readFileSync(path.join(bridgeDir, "reply-per_1.json"), "utf8"),
      ) as JsonRow;
      assert.deepEqual(reply, { permissionId: "per_1", reply: "once" });
    } finally {
      restoreHomeEnv();
    }
  });

  it("decision 枚举与 permissionId 校验错误文案对齐 Rust", async () => {
    const ctx = makeContext();
    await assert.rejects(
      () => invoke(ctx, "reply_opencode_permission", { permissionId: "per_1", decision: "nope" }),
      /参数 decision: unknown variant/,
    );
    await assert.rejects(
      () => invoke(ctx, "reply_opencode_permission", { permissionId: "bad/id", decision: "reject" }),
      /OpenCode 权限请求 ID 无效/,
    );
  });
});

// ─── 渠道预设同步 ───────────────────────────────────────────────────────────

describe("渠道预设同步命令", () => {
  function writeConfig(): string {
    const dir = tempDir("preset-config");
    const configPath = path.join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        channels_config: {
          channels: [
            {
              id: "deepseek",
              name: "DeepSeek 新名称",
              vendor: "deepseek",
              supported_protocols: ["openai", "anthropic"],
              openai_base_url: "https://api.deepseek.com/v1",
              anthropic_base_url: "https://api.deepseek.com/anthropic",
              default_model: "deepseek-v4.1-flash",
            },
            {
              id: "new-channel",
              name: "新渠道",
              vendor: "custom",
              supported_protocols: ["openai"],
              openai_base_url: "https://example.com/v1",
              default_model: "m1",
            },
          ],
          default_exposed_models: {},
          endpoints: {},
        },
      }),
    );
    return configPath;
  }

  function basePreset(id: string, overrides: JsonRow = {}): JsonRow {
    return {
      id,
      name: id,
      vendor: "custom",
      supported_protocols: ["openai"],
      openai_base_url: "",
      anthropic_base_url: "",
      openai_auth: "bearer",
      anthropic_auth: "bearer",
      default_model: "m",
      small_model: null,
      timeout_seconds: null,
      supports_model_list: false,
      supports_model_detail: false,
      supports_balance_query: false,
      supports_quota_query: false,
      supports_usage_query: false,
      supports_files_api: false,
      platform_url: null,
      enabled: true,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }

  it("preview 返回 added/removed/updated 差异与新增暴露模型", async () => {
    storage.saveChannelPresets([
      basePreset("deepseek", { name: "DeepSeek 旧名称", enabled: false }),
      basePreset("removed-channel", { name: "已删除" }),
    ]);
    const snapshot: JsonRow = { channels: [], accounts: [], routes: [], rules: [], virtual_models: [] };
    const ctx = makeContext({ configPath: writeConfig(), snapshot });
    const preview = (await invoke(ctx, "preview_sync_channel_presets")) as JsonRow;
    const items = preview.items as JsonRow[];
    const added = items.find((item) => item.id === "new-channel");
    assert.equal(added?.status, "added");
    assert.equal(added?.before, null);
    const removed = items.find((item) => item.id === "removed-channel");
    assert.equal(removed?.status, "removed");
    const updated = items.find((item) => item.id === "deepseek");
    assert.equal(updated?.status, "updated");
    assert.match(String(updated?.after), /名称：DeepSeek 旧名称 → DeepSeek 新名称/);
    assert.equal(preview.hasChanges, true);
    assert.ok((preview.addedCount as number) >= 1);
    assert.equal(preview.removedCount, 1);
    // 预览不写库。
    const presets = storage.listChannelPresets();
    assert.equal(presets.some((preset) => preset.id === "new-channel"), false);
  });

  it("apply 全量替换预设：新增渠道默认禁用、已有渠道保留启用状态", async () => {
    storage.saveChannelPresets([basePreset("deepseek", { name: "旧名称", enabled: false })]);
    const snapshot: JsonRow = { channels: [], accounts: [], routes: [], rules: [], virtual_models: [] };
    const ctx = makeContext({ configPath: writeConfig(), snapshot });
    await invoke(ctx, "apply_sync_channel_presets");
    const presets = storage.listChannelPresets();
    const added = presets.find((preset) => preset.id === "new-channel");
    assert.equal(added?.enabled, false);
    const existing = presets.find((preset) => preset.id === "deepseek");
    assert.equal(existing?.enabled, false);
    assert.equal(existing?.name, "DeepSeek 新名称");
    assert.equal((snapshot.channels as JsonRow[]).length, presets.length);
  });
});

// ─── 成本账本数据源探测 ────────────────────────────────────────────────────

describe("probe_cost_ledger_sources", () => {
  it("空库返回 1 个可用网关源 + 3 个不可用原生源", async () => {
    const result = (await invoke(makeContext(), "probe_cost_ledger_sources")) as JsonRow;
    assert.equal(typeof result.generatedAt, "string");
    const reports = result.reports as JsonRow[];
    assert.equal(reports.length, 4);
    const gateway = reports[0] as JsonRow;
    assert.equal(gateway.source.id, "flowlet-gateway");
    assert.equal(gateway.available, true);
    assert.equal(gateway.recordCount, 0);
    for (const report of reports.slice(1)) {
      assert.equal(report.available, false);
      assert.equal(report.source.sourceType, "agent_native");
    }
    assert.deepEqual(result.entitlements, []);
    assert.deepEqual(result.balances, []);
  });

  it("从 request_logs + usage_records 采样网关用量并标注 status", async () => {
    insertRequestLog({
      id: "r1",
      requestId: "req-1",
      agentType: "claude-code",
      sessionId: "s1",
      clientId: "claude-code",
      status: 200,
    });
    insertUsageRecord({ id: "u1", requestId: "req-1", totalTokens: 55, cost: 0.12 });
    const result = (await invoke(makeContext(), "probe_cost_ledger_sources")) as JsonRow;
    const usage = result.usage as JsonRow[];
    assert.equal(usage.length, 1);
    const sample = usage[0] as JsonRow;
    assert.equal(sample.sourceEventId, "req-1");
    assert.equal(sample.granularity, "request");
    assert.equal(sample.isRollup, false);
    assert.equal(sample.status, "success");
    assert.deepEqual(sample.tokens, {
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      uncachedInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: 55,
    });
    assert.equal(sample.cost, 0.12);
    assert.equal((result.reports as JsonRow[])[0]?.recordCount, 1);
  });
});
// ─── 命令注册表 ─────────────────────────────────────────────────────────────

describe("desktop observability 命令注册表", () => {
  it("注册批次 3 的 17 条命令 + 桌面会话目录覆盖（19 条）", () => {
    assert.deepEqual(Object.keys(handlers).sort(), [
      "agent_native_usage_summary",
      "apply_sync_channel_presets",
      "cancel_background_job",
      "cleanup_background_jobs",
      "get_agent_session_flowlet_usage",
      "get_agent_session_last_interaction",
      "get_agent_session_native_summary",
      "get_agent_session_timeline",
      "get_agent_sync_status",
      "get_background_job_detail",
      "list_agent_session_children",
      "list_agent_session_clients",
      "list_agent_sessions",
      "list_background_jobs",
      "list_opencode_session_permissions",
      "preview_sync_channel_presets",
      "probe_cost_ledger_sources",
      "reply_opencode_permission",
      "sync_agent_data",
    ]);
  });
});

// ─── 真实同步链路（Claude Code fixture -> 快照/账本/来源状态） ───────────────

describe("sync_agent_data 真实同步链路", () => {
  it("扫描原生会话写快照与用量事件，二次同步无变化，删除源文件后标记 archived", async () => {
    const home = tempDir("sync-home");
    const sessionFile = writeClaudeFixture(home);
    setHomeEnv(home);
    try {
      const ctx = makeContext();
      const first = (await invoke(ctx, "sync_agent_data", {
        force: true,
        triggerSource: "manual",
      })) as JsonRow;
      assert.equal(first.started, true);
      assert.equal(first.scanned, 1);
      assert.equal(first.changed, 1);
      assert.equal(first.failed, 0);
      assert.equal(first.message, "已整理 1 个会话，标记 0 个源文件已删除");

      const job = storage.database()
        .prepare("SELECT job_type, status, trigger_source, progress_current, progress_total FROM background_jobs")
        .get() as JsonRow;
      assert.equal(job.job_type, "agent-data-sync");
      assert.equal(job.status, "succeeded");
      assert.equal(job.trigger_source, "manual");
      assert.equal(job.progress_current, 1);
      assert.equal(job.progress_total, 1);

      const snapshot = storage.database()
        .prepare(
          "SELECT summary_json, session_json, parser_version FROM agent_session_snapshots WHERE agent_type='claude-code' AND session_id='session-abc'",
        )
        .get() as JsonRow;
      const summary = JSON.parse(String(snapshot.summary_json)) as JsonRow;
      assert.equal(summary.turnCount, 2);
      assert.equal((summary.usage as JsonRow).totalTokens, 45);
      assert.equal(snapshot.parser_version, 4);
      const session = JSON.parse(String(snapshot.session_json)) as JsonRow;
      assert.equal(session.projectPath, "/repo");

      const usageEvents = storage.database()
        .prepare("SELECT event_id FROM agent_usage_events ORDER BY event_id")
        .all() as JsonRow[];
      assert.deepEqual(usageEvents.map((row) => row.event_id), ["a1:0", "a2:0"]);

      const sourceState = storage.database()
        .prepare("SELECT scanned_count, changed_count, status FROM agent_source_sync_state WHERE agent_type='claude-code'")
        .get() as JsonRow;
      assert.equal(sourceState.scanned_count, 1);
      assert.equal(sourceState.changed_count, 1);
      assert.equal(sourceState.status, "succeeded");

      // 二次同步：fingerprint 未变 -> 不产生任务。
      const second = (await invoke(ctx, "sync_agent_data", {
        force: false,
        triggerSource: "scheduled",
      })) as JsonRow;
      assert.equal(second.started, false);
      assert.equal(second.message, "没有发现需要整理的会话变化");

      // 删除源文件 -> 下一次同步把快照标记为 sourceAvailable=false。
      rmSync(sessionFile, { force: true });
      const third = (await invoke(ctx, "sync_agent_data", {
        force: true,
        triggerSource: "manual",
      })) as JsonRow;
      assert.equal(third.started, true);
      assert.equal(third.changed, 0);
      assert.equal(third.message, "已整理 0 个会话，标记 1 个源文件已删除");
      const archived = storage.database()
        .prepare("SELECT summary_json FROM agent_session_snapshots WHERE session_id='session-abc'")
        .get() as JsonRow;
      assert.equal((JSON.parse(String(archived.summary_json)) as JsonRow).sourceAvailable, false);
    } finally {
      restoreHomeEnv();
    }
  });

  it("同步后 agent_native_usage_summary 能读到该会话", async () => {
    const home = tempDir("sync-usage-home");
    writeClaudeFixture(home);
    setHomeEnv(home);
    try {
      const ctx = makeContext();
      await invoke(ctx, "sync_agent_data", { force: true, triggerSource: "manual" });
      const rows = (await invoke(ctx, "agent_native_usage_summary")) as JsonRow[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.sessionId, "session-abc");
      assert.equal((rows[0]?.usage as JsonRow).totalTokens, 45);
    } finally {
      restoreHomeEnv();
    }
  });
});

// ─── Codex API 等价费用估算（apply_native_cost_estimate_*） ─────────────────

function writeCodexFixture(home: string): void {
  const sessionDir = path.join(home, "sessions", "2026", "11", "09");
  mkdirSync(sessionDir, { recursive: true });
  const records = [
    {
      type: "session_meta",
      timestamp: "2026-11-09T20:00:00Z",
      payload: { id: "codex-sess", originator: "codex_cli_rs", cwd: "/repo" },
    },
    {
      type: "event_msg",
      timestamp: "2026-11-09T20:00:01Z",
      payload: { type: "task_started", turn_id: "t1" },
    },
    { type: "turn_context", payload: { model: "gpt-6.1-sol" } },
    {
      type: "response_item",
      timestamp: "2026-11-09T20:00:02Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "你好" }],
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 200,
            output_tokens: 500,
            total_tokens: 1500,
          },
        },
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-11-09T20:00:05Z",
      payload: { type: "task_complete", turn_id: "t1", duration_ms: 4000, time_to_first_token_ms: 800 },
    },
    {
      type: "response_item",
      timestamp: "2026-11-09T20:00:06Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "你好呀" }],
      },
    },
  ];
  writeFileSync(
    path.join(sessionDir, "rollout-2026-11-09T20-00-00-codex-sess.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
}

describe("Codex 原生会话费用估算", () => {
  it("单一模型时按 openai-api 价格生成 apiEquivalent，并保留 turn 时长", async () => {
    const home = tempDir("codex-home");
    writeCodexFixture(home);
    setHomeEnv(home);
    process.env.CODEX_HOME = home;
    storage.setPrices([
      {
        id: "price-openai-api-gpt-6.1-sol",
        channel_id: "openai-api",
        upstream_model: "gpt-6.1-sol",
        input_uncached_price: 2,
        input_cached_price: 0.5,
        input_cache_write_price: null,
        output_price: 8,
        tiers: [],
        schedules: [],
        currency: "CNY",
        unit: "1M tokens",
        source_url: "https://example.com/prices",
        price_version: "v1",
        created_at: "2026-11-01T00:00:00Z",
        updated_at: "2026-11-01T00:00:00Z",
      },
    ]);
    try {
      const ctx = makeContext();
      const summary = (await invoke(ctx, "get_agent_session_native_summary", {
        agentType: "codex-cli",
        sessionId: "codex-sess",
      })) as JsonRow;
      assert.equal(summary.sourceAvailable, true);
      assert.equal(summary.turnCount, 1);
      assert.deepEqual(summary.models, ["gpt-6.1-sol"]);
      const usage = summary.usage as JsonRow;
      assert.equal(usage.totalTokens, 1500);
      const estimate = usage.apiEquivalent as JsonRow;
      assert.equal(estimate.currency, "CNY");
      assert.equal(estimate.pricedTurnCount, 1);
      assert.equal(estimate.unpricedTurnCount, 0);
      // 800 未缓存输入 * 2 + 200 缓存输入 * 0.5 + 500 输出 * 8（每百万 token）
      assert.ok(Math.abs((estimate.amount as number) - 0.0057) < 1e-9);

      const timeline = (await invoke(ctx, "get_agent_session_timeline", {
        agentType: "codex-cli",
        sessionId: "codex-sess",
      })) as JsonRow;
      const turn = (timeline.events as JsonRow[]).find((event) => event.kind === "turn");
      assert.equal(turn?.status, "completed");
      assert.equal(turn?.durationMs, 4000);
      assert.equal(turn?.timeToFirstTokenMs, 800);
      assert.equal(turn?.model, "gpt-6.1-sol");
    } finally {
      restoreHomeEnv();
    }
  });
});

// ─── 桌面会话目录覆盖（list_agent_sessions / list_agent_session_children） ──

function writeChildSessionFixture(home: string, parent: string, childId: string): string {
  const directory = path.join(home, ".claude", "projects", "-repo", parent, "subagents");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${childId}.jsonl`);
  const records = [
    { type: "user", uuid: "u1", timestamp: "2026-10-31T10:00:00Z", cwd: "/repo", message: { role: "user", content: "子任务" } },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-10-31T10:00:01Z",
      message: {
        id: "msg-child",
        role: "assistant",
        model: "claude-child",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "子结果" }],
      },
    },
  ];
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n"));
  return file;
}

function pinMtime(file: string, iso: string): void {
  const when = new Date(iso);
  utimesSync(file, when, when);
}

describe("桌面会话目录（list_agent_sessions 覆盖）", () => {
  it("合并原生会话与 Flowlet 观测会话，补齐原生字段并只返回根会话", async () => {
    const home = tempDir("catalog-home");
    const sessionFile = writeClaudeFixture(home);
    const childFile = writeChildSessionFixture(home, "session-abc", "child-1");
    pinMtime(sessionFile, "2026-11-01T00:00:00Z");
    pinMtime(childFile, "2026-11-01T01:00:00Z");
    // 快照补齐 nativeSummary / nativeSyncedAt。
    insertSnapshot(
      "claude-code",
      "session-abc",
      nativeSummaryJson(),
      sessionRowJson({ sessionId: "session-abc" }),
      "2026-11-01 01:00:00",
    );
    // Flowlet 观测会话（没有本机原生文件）。
    insertRequestLog({
      id: "req-flowlet-only",
      requestId: "req-flowlet-only",
      agentType: "claude-code",
      sessionId: "flowlet-only",
      clientId: "claude-code",
      clientName: "Claude Code",
      createdAt: "2026-11-10 12:00:00",
    });
    // 未关联会话的客户端请求 -> hasFlowletRequests。
    insertRequestLog({
      id: "req-unassociated",
      requestId: "req-unassociated",
      agentType: "claude-code",
      sessionId: null,
      clientId: "claude-code",
      clientName: "Claude Code",
      createdAt: "2026-11-10 12:01:00",
    });

    setHomeEnv(home);
    try {
      const ctx = makeContext();
      const page = (await invoke(ctx, "list_agent_sessions", {
        filter: { page: 1, page_size: 10, search: "", agent_type: "", runtime_status: "" },
      })) as JsonRow;
      const rows = page.rows as JsonRow[];
      assert.equal(page.total, 2);
      assert.deepEqual(rows.map((row) => row.sessionId), ["flowlet-only", "session-abc"]);
      const observed = rows[0] as JsonRow;
      assert.equal(observed.flowletObserved, true);
      assert.equal(observed.clientName, "Claude Code");
      const native = rows[1] as JsonRow;
      assert.equal(native.flowletObserved, false);
      assert.equal(native.title, null);
      assert.equal(native.projectPath, "/repo");
      assert.equal(native.nativeStartedAt, "2026-11-09T20:00:01Z");
      assert.equal(native.nativeUpdatedAt, "2026-11-01T00:00:00.000Z");
      assert.equal(native.activityAt, "2026-11-01T00:00:00.000Z");
      assert.equal(native.runtimeStatus, "idle");
      assert.equal((native.nativeSummary as JsonRow).turnCount, 2);
      assert.equal(native.nativeSyncedAt, "2026-11-01 01:00:00");
      assert.match(String(native.nativeSessionDir), /\.claude[\\/]+projects/);
      assert.equal(native.hasFlowletRequests, true);
      // 子会话不进入列表。
      assert.equal(rows.some((row) => row.sessionId === "child-1"), false);

      // 搜索 / 项目路径 / 运行状态过滤。
      const searched = (await invoke(ctx, "list_agent_sessions", {
        filter: { page: 1, page_size: 10, search: "ABC", agent_type: "", runtime_status: "" },
      })) as JsonRow;
      assert.deepEqual((searched.rows as JsonRow[]).map((row) => row.sessionId), ["session-abc"]);
      const byProject = (await invoke(ctx, "list_agent_sessions", {
        filter: { page: 1, page_size: 10, project_path: "/repo/", agent_type: "", runtime_status: "" },
      })) as JsonRow;
      assert.deepEqual((byProject.rows as JsonRow[]).map((row) => row.sessionId), ["session-abc"]);
      const byStatus = (await invoke(ctx, "list_agent_sessions", {
        filter: { page: 1, page_size: 10, runtime_status: "idle", agent_type: "", runtime_status_filter: "" },
      })) as JsonRow;
      assert.deepEqual((byStatus.rows as JsonRow[]).map((row) => row.sessionId), ["session-abc"]);
      const byType = (await invoke(ctx, "list_agent_sessions", {
        filter: { page: 1, page_size: 10, agent_type: "cursor-agent" },
      })) as JsonRow;
      assert.equal(byType.total, 0);
      // 子会话接口。
      const children = (await invoke(ctx, "list_agent_session_children", {
        agentType: "claude-code",
        parentSessionId: "session-abc",
      })) as JsonRow[];
      assert.deepEqual(children.map((row) => row.sessionId), ["child-1"]);
      assert.equal(children[0]?.parentSessionId, "session-abc");
    } finally {
      restoreHomeEnv();
    }
  });

  it("OpenCode 待确认权限优先，并把子会话运行态聚合到根会话", async () => {
    const home = tempDir("opencode-catalog-home");
    const opencodeDir = path.join(home, ".local", "share", "opencode");
    mkdirSync(opencodeDir, { recursive: true });
    const db = new DatabaseSync(path.join(opencodeDir, "opencode.db"));
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT,
        time_created INTEGER, time_updated INTEGER, model TEXT
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER,
        time_updated INTEGER, data TEXT
      );
    `);
    const now = Date.now();
    db.prepare(
      "INSERT INTO session (id, title, directory, parent_id, time_created, time_updated) VALUES (?,?,?,?,?,?)",
    ).run("ses-parent", "父会话", "/repo", null, now - 60_000, now - 30_000);
    db.prepare(
      "INSERT INTO session (id, title, directory, parent_id, time_created, time_updated) VALUES (?,?,?,?,?,?)",
    ).run("ses-child", "子会话", "/repo", "ses-parent", now - 50_000, now);
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)",
    ).run("msg-child", "ses-child", now, now, JSON.stringify({ role: "user" }));
    db.close();
    // 权限桥：子会话处于等待确认。
    const bridgeDir = path.join(home, ".flowlet", "opencode-control");
    mkdirSync(bridgeDir, { recursive: true });
    writeFileSync(
      path.join(bridgeDir, "state-1.json"),
      JSON.stringify({
        serverUrl: "http://127.0.0.1:4096",
        updatedAt: Date.now(),
        permissions: [{ id: "per_child", sessionID: "ses-child", permission: "bash" }],
      }),
    );
    setHomeEnv(home);
    try {
      const page = (await invoke(makeContext(), "list_agent_sessions", {
        filter: { page: 1, page_size: 10 },
      })) as JsonRow;
      const rows = page.rows as JsonRow[];
      const parent = rows.find((row) => row.sessionId === "ses-parent") as JsonRow;
      assert.ok(parent, "根会话必须出现在列表");
      assert.equal(parent.runtimeStatus, "waiting_user");
      assert.equal(rows.some((row) => row.sessionId === "ses-child"), false);
      const waiting = (await invoke(makeContext(), "list_agent_sessions", {
        filter: { page: 1, page_size: 10, runtime_status: "waiting_user" },
      })) as JsonRow;
      assert.deepEqual((waiting.rows as JsonRow[]).map((row) => row.sessionId), ["ses-parent"]);
    } finally {
      restoreHomeEnv();
    }
  });

  it("filter 缺少 page/page_size 时报 serde 风格错误", async () => {
    await assert.rejects(
      () => invoke(makeContext(), "list_agent_sessions", { filter: {} }),
      /参数 filter: missing field `page`/,
    );
  });
});

// ─── DeepSeek Harness 原生会话 ──────────────────────────────────────────────

interface DshFixtureOptions {
  version?: number;
  id?: string;
  directory?: string;
  zstd?: boolean;
  extra?: JsonRow[];
}

function writeDshSession(home: string, options: DshFixtureOptions = {}): string {
  const version = options.version ?? 4;
  const sessionId = options.id ?? "dsh-session-1";
  const directory = path.join(home, "sessions", options.directory ?? "project-a", `session-${sessionId}`);
  mkdirSync(directory, { recursive: true });
  const base = 1_760_000_000_000;
  const records: JsonRow[] = [
    { type: "session", version, id: sessionId, createdAt: base, cwd: "/dsh-repo" },
    { type: "turn/start", seq: 1, time: base + 1_000, data: { turn: 1 } },
    { type: "step/start", seq: 2, time: base + 1_100, data: { turn: 1, step: 1 } },
    {
      type: "user/message",
      seq: 3,
      time: base + 1_200,
      data: { id: "msg-user", content: [{ type: "text", text: "帮我看看" }] },
    },
    {
      type: "assistant/chunk",
      seq: 4,
      time: base + 1_500,
      data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "好" } },
    },
    {
      type: "assistant/message",
      seq: 5,
      time: base + 2_000,
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { model: "deepseek-v4.1-flash" },
          content: [
            { type: "reasoning", text: "先分析" },
            { type: "text", text: "可以" },
          ],
        },
        usage: { inputTokens: 10, cacheReadTokens: 2, outputTokens: 5, reasoningTokens: 1 },
      },
    },
    { type: "turn/end", seq: 6, time: base + 2_500, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  if (options.extra !== undefined) records.push(...options.extra);
  const fileName = version === 0 ? "session.jsonl" : `session.v${version}.jsonl`;
  const payload = records.map((record) => JSON.stringify(record)).join("\n");
  const filePath = path.join(directory, options.zstd === true ? `${fileName}.zstd` : fileName);
  writeFileSync(filePath, options.zstd === true ? zstdCompressSync(Buffer.from(payload)) : payload);
  return filePath;
}

function withDshHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previousDshHome = process.env.DSH_HOME;
  const previousHome = process.env.HOME;
  const previousHermesHome = process.env.HERMES_HOME;
  const previousAppData = process.env.APPDATA;
  process.env.DSH_HOME = home;
  process.env.HOME = home;
  // 同样隔离其它 Agent 来源，避免列表断言吃到宿主机真实会话。
  process.env.HERMES_HOME = path.join(home, "hermes-home");
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  return run().finally(() => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    restoreHomeEnv();
  });
}

describe("DeepSeek Harness 原生会话解析", () => {
  it("v4 时间线 / 最后一轮 / 摘要 / 列表字段", async () => {
    const home = tempDir("dsh-home");
    writeDshSession(home);
    await withDshHome(home, async () => {
      const ctx = makeContext();
      const timeline = (await invoke(ctx, "get_agent_session_timeline", {
        agentType: "deepseek-harness",
        sessionId: "dsh-session-1",
      })) as JsonRow;
      assert.equal(timeline.sourceAvailable, true);
      assert.equal(timeline.turnCount, 1);
      assert.deepEqual(timeline.models, ["deepseek-v4.1-flash"]);
      const kinds = (timeline.events as JsonRow[]).map((event) => event.kind);
      assert.ok(kinds.includes("turn"));
      assert.ok(kinds.includes("user-message"));
      assert.ok(kinds.includes("reasoning"));
      assert.ok(kinds.includes("assistant-message"));
      const assistant = (timeline.events as JsonRow[]).find(
        (event) => event.kind === "assistant-message",
      ) as JsonRow;
      assert.equal(assistant.content, "可以");
      assert.equal((assistant.usage as JsonRow).totalTokens, 17);
      assert.equal(assistant.durationMs, 900);
      assert.equal(assistant.timeToFirstTokenMs, 400);
      const trace = assistant.trace as JsonRow;
      assert.equal(trace.turn, 1);
      assert.equal(trace.step, 1);
      assert.equal(trace.eventType, "assistant/message");
      const turn = (timeline.events as JsonRow[]).find((event) => event.kind === "turn") as JsonRow;
      assert.equal(turn.status, "completed");
      assert.equal(turn.durationMs, 1500);
      assert.equal((timeline.usage as JsonRow).totalTokens, 17);

      const last = (await invoke(ctx, "get_agent_session_last_interaction", {
        agentType: "deepseek-harness",
        sessionId: "dsh-session-1",
      })) as JsonRow;
      assert.equal((last.events as JsonRow[])[0]?.kind, "user-message");
      const summary = (await invoke(ctx, "get_agent_session_native_summary", {
        agentType: "deepseek-harness",
        sessionId: "dsh-session-1",
      })) as JsonRow;
      assert.equal(summary.turnCount, 1);
      assert.equal((summary.usage as JsonRow).totalTokens, 17);

      const page = (await invoke(ctx, "list_agent_sessions", {
        filter: { page: 1, page_size: 10 },
      })) as JsonRow;
      const rows = page.rows as JsonRow[];
      assert.equal(rows.length, 1);
      const row = rows[0] as JsonRow;
      assert.equal(row.agentType, "deepseek-harness");
      assert.equal(row.title, "帮我看看");
      assert.equal(row.projectPath, "/dsh-repo");
      assert.equal(row.clientName, "DeepSeek Harness");
      assert.equal(row.runtimeStatus, "idle");
      assert.equal((row.nativeSummary as JsonRow).turnCount, 1);
      assert.match(String(row.nativeSessionDir), /session-dsh-session-1/);
    });
  });

  it("v4 的 tool/result 与 v3 内容块形状都能识别失败状态", async () => {
    const home = tempDir("dsh-tools-home");
    writeDshSession(home, {
      extra: [
        {
          type: "tool/call",
          seq: 7,
          time: 1_760_000_003_000,
          data: { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: '{"cmd":"ls"}' },
        },
        {
          type: "tool/result",
          seq: 8,
          time: 1_760_000_003_500,
          data: { callId: "call-1", message: { content: [{ type: "text", text: "boom" }], isError: true } },
        },
      ],
    });
    await withDshHome(home, async () => {
      const timeline = (await invoke(makeContext(), "get_agent_session_timeline", {
        agentType: "deepseek-harness",
        sessionId: "dsh-session-1",
      })) as JsonRow;
      const events = timeline.events as JsonRow[];
      const result = events.find((event) => event.kind === "tool-result") as JsonRow;
      assert.equal(result.status, "error");
      assert.equal(result.title, "bash");
      assert.equal(result.content, "boom");
      assert.equal(result.durationMs, 500);
      assert.equal((result.trace as JsonRow).callId, "call-1");

      const v3Home = tempDir("dsh-v3-home");
      writeDshSession(v3Home, {
        version: 3,
        extra: [
          {
            type: "tool/call",
            seq: 7,
            time: 1_760_000_003_000,
            data: { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: "{}" },
          },
          {
            type: "tool/result",
            seq: 8,
            time: 1_760_000_003_500,
            data: {
              callId: "call-1",
              message: { content: [{ type: "tool-result", content: "v3 boom", isError: true }] },
            },
          },
        ],
      });
      await withDshHome(v3Home, async () => {
        const v3Timeline = (await invoke(makeContext(), "get_agent_session_timeline", {
          agentType: "deepseek-harness",
          sessionId: "dsh-session-1",
        })) as JsonRow;
        const v3Result = (v3Timeline.events as JsonRow[]).find(
          (event) => event.kind === "tool-result",
        ) as JsonRow;
        assert.equal(v3Result.status, "error");
        assert.equal(v3Result.content, "v3 boom");
      });
    });
  });

  it("支持 zstd 压缩会话，并按最高支持代际去重", async () => {
    const home = tempDir("dsh-zstd-home");
    writeDshSession(home, { directory: "zstd-project", zstd: true });
    await withDshHome(home, async () => {
      const timeline = (await invoke(makeContext(), "get_agent_session_timeline", {
        agentType: "deepseek-harness",
        sessionId: "dsh-session-1",
      })) as JsonRow;
      assert.equal(timeline.turnCount, 1);
    });

    const generationsHome = tempDir("dsh-generations-home");
    // 同一目录同时保留 v2 与 v4：列表只应出现一行，且时间线取 v4。
    writeDshSession(generationsHome, {
      version: 2,
      directory: "gen-project",
      extra: [
        {
          type: "user/message",
          seq: 7,
          time: 1_760_000_003_000,
          data: { id: "msg-v2-only", content: [{ type: "text", text: "v2 独有" }] },
        },
      ],
    });
    writeDshSession(generationsHome, { version: 4, directory: "gen-project" });
    await withDshHome(generationsHome, async () => {
      const rows = (await invoke(makeContext(), "list_agent_sessions", {
        filter: { page: 1, page_size: 10 },
      })) as JsonRow;
      assert.equal((rows.rows as JsonRow[]).length, 1);
      const timeline = (await invoke(makeContext(), "get_agent_session_timeline", {
        agentType: "deepseek-harness",
        sessionId: "dsh-session-1",
      })) as JsonRow;
      const contents = (timeline.events as JsonRow[]).map((event) => event.content);
      assert.equal(contents.includes("v2 独有"), false);
    });
  });

  it("未知代际不伪造数据：文件被忽略，读取报「未找到」", async () => {
    const home = tempDir("dsh-future-home");
    writeDshSession(home, { version: 5, directory: "future-project" });
    await withDshHome(home, async () => {
      const page = (await invoke(makeContext(), "list_agent_sessions", {
        filter: { page: 1, page_size: 10 },
      })) as JsonRow;
      assert.equal(page.total, 0);
      await assert.rejects(
        () =>
          invoke(makeContext(), "get_agent_session_timeline", {
            agentType: "deepseek-harness",
            sessionId: "dsh-session-1",
          }),
        /未找到 DeepSeek Harness 会话 dsh-session-1/,
      );
    });
  });

  it("sync_agent_data 会写入 DSH 快照，但不产生消息级原生账本", async () => {
    const home = tempDir("dsh-sync-home");
    writeDshSession(home);
    await withDshHome(home, async () => {
      const result = (await invoke(makeContext(), "sync_agent_data", {
        force: true,
        triggerSource: "manual",
      })) as JsonRow;
      assert.equal(result.started, true);
      assert.equal(result.changed, 1);
      assert.equal(result.failed, 0);
      const snapshot = storage.database()
        .prepare(
          "SELECT summary_json FROM agent_session_snapshots WHERE agent_type='deepseek-harness'",
        )
        .get() as JsonRow;
      assert.ok(snapshot, "DSH 会话必须写入快照");
      const summary = JSON.parse(String(snapshot.summary_json)) as JsonRow;
      assert.equal(summary.turnCount, 1);
      const usageEvents = storage.database()
        .prepare("SELECT COUNT(*) AS total FROM agent_usage_events WHERE agent_type='deepseek-harness'")
        .get() as JsonRow;
      assert.equal(Number(usageEvents.total), 0);
      const source = storage.database()
        .prepare("SELECT scanned_count FROM agent_source_sync_state WHERE agent_type='deepseek-harness'")
        .get() as JsonRow;
      assert.equal(Number(source.scanned_count), 1);
    });
  });
});
