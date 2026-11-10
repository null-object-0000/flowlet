// 桌面观测命令（批次 3）。Owner: desktop-observability。
//
// 负责：list_opencode_session_permissions / reply_opencode_permission /
// get_agent_session_native_summary / get_agent_session_last_interaction /
// get_agent_session_timeline / get_agent_session_flowlet_usage / sync_agent_data /
// get_agent_sync_status / list_background_jobs / get_background_job_detail /
// cancel_background_job / cleanup_background_jobs / list_agent_session_clients /
// agent_native_usage_summary / preview_sync_channel_presets /
// apply_sync_channel_presets / probe_cost_ledger_sources。
//
// 权威行为：src-tauri/src/commands/observability.rs + commands/usage.rs + commands/scrape.rs，
// core/agent_session_timeline*.rs、core/opencode_control.rs、core/storage_tasks.rs、
// core/storage_usage.rs、core/cost_ledger_source_probe.rs。
//
// 契约要点：
// - 参数名按 Tauri 规则 camelCase（Rust snake_case 形参 → JS camelCase）；
// - 返回字段 snake_case / camelCase 混用，逐字段照 Rust serde 输出，不做「统一」；
// - 错误用 `CommandError.badRequest`，文案对齐 Rust `Err(String)`。
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { JsonRow } from "../types.ts";
import { CommandError } from "../types.ts";
import {
  argBool,
  argError,
  argInteger,
  argObject,
  argOptionalString,
  argString,
  invalidType,
  requireFields,
  serdeTypeName,
} from "../web/errors.ts";
import type { DesktopContext, DesktopHandlerMap } from "./types.ts";
import {
  cleanupBackgroundJobs,
  getBackgroundJobDetail,
  listBackgroundJobs,
  requestBackgroundJobCancel,
  type BackgroundJobsFilter,
} from "../storage/background-jobs.ts";
import {
  agentNativeUsageSummary,
  listAgentSessionClients,
  listAgentSnapshotDetails,
  sessionTimeMillis,
} from "../storage/agent-native.ts";
import {
  agentSessionFlowletUsage,
  listObservedAgentSessions,
} from "../storage/sessions.ts";
import {
  applyNativeCostEstimateToSummary,
  applyNativeCostEstimateToTimeline,
  getNativeAgentSessionLastInteraction,
  getNativeAgentSessionSummary,
  getNativeAgentSessionTimeline,
  sliceNativeAgentSessionTimeline,
} from "../agent/sessions/timeline.ts";
import {
  agentSyncStatus,
  releaseAgentDataSync,
  syncAgentData,
  tryAcquireAgentDataSync,
} from "../agent/sessions/sync.ts";
import {
  listSessionPermissions,
  parsePermissionDecision,
  pendingSessionIds,
  replyPermission,
} from "../agent/opencode-control.ts";
import {
  agentSessionsPage,
  applyOpencodePendingSessions,
  enrichNativeAgentSessions,
  listNativeAgentSessions,
  markUnassociatedFlowletRequests,
  mergeAgentSessionCatalog,
  sessionKey,
  unassociatedFlowletClients,
} from "../agent/sessions/native.ts";
import { probeCostLedgerSources } from "../agent/cost-ledger-probe.ts";
import {
  DEFAULT_BUILTIN_CONFIG,
  mergeDefaultRoutes,
  parseChannelsConfig,
  readJsonFile,
} from "../config/index.ts";

// ─── 参数辅助 ───────────────────────────────────────────────────────────────

/** Rust `BackgroundJobsFilter` 必填字段（无 `#[serde(default)]`）。 */
const BACKGROUND_JOBS_FILTER_REQUIRED = ["page", "page_size"];

function parseBackgroundJobsFilter(args: JsonRow): BackgroundJobsFilter {
  const raw = argObject(args, "filter", "BackgroundJobsFilter");
  requireFields(raw, "filter", BACKGROUND_JOBS_FILTER_REQUIRED);
  return {
    page: argInteger(raw, "page", "u32"),
    pageSize: argInteger(raw, "page_size", "u32"),
    status: optionalStringField(raw, "status"),
    jobType: optionalStringField(raw, "job_type"),
    triggerSource: optionalStringField(raw, "trigger_source"),
  };
}

/** Rust `AgentSessionsFilter` 必填字段（page/page_size 无 serde default）。 */
const AGENT_SESSIONS_FILTER_REQUIRED = ["page", "page_size"];

/**
 * 解析桌面 `list_agent_sessions` 的 filter。字段名沿用 Rust/前端发送的 snake_case
 * （前端 `src/domains/agent-session/commands.ts` 直接传 page_size / agent_type）。
 */
function parseAgentSessionsFilter(args: JsonRow): {
  page: number;
  pageSize: number;
  search: string;
  agentType: string;
  runtimeStatus: string;
  projectPath: string;
} {
  const raw = argObject(args, "filter", "AgentSessionsFilter");
  requireFields(raw, "filter", AGENT_SESSIONS_FILTER_REQUIRED);
  for (const field of AGENT_SESSIONS_FILTER_REQUIRED) {
    const value = raw[field];
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw CommandError.badRequest(
        `参数 filter: field \`${field}\`: invalid type: ${serdeTypeName(value)}, expected u32`,
      );
    }
  }
  const text = (field: string): string => {
    const value = raw[field];
    if (value === null || value === undefined) return "";
    if (typeof value !== "string") {
      throw CommandError.badRequest(
        `参数 filter: field \`${field}\`: invalid type: ${serdeTypeName(value)}, expected a string`,
      );
    }
    return value;
  };
  return {
    page: raw.page as number,
    pageSize: raw.page_size as number,
    search: text("search"),
    agentType: text("agent_type"),
    runtimeStatus: text("runtime_status"),
    projectPath: text("project_path"),
  };
}

function optionalStringField(args: JsonRow, name: string): string | undefined {
  const value = args[name];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw invalidType(value, "a string", name);
  return value;
}

/** 读取并解析 config.json（与 Rust `std::fs::read_to_string` + serde_json 错误前缀一致）。 */
function readConfigJson(configPath: string): JsonRow {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    throw CommandError.badRequest(`读取 config.json 失败：${errorMessage(error)}`);
  }
  try {
    return JSON.parse(raw) as JsonRow;
  } catch (error) {
    throw CommandError.badRequest(`解析 config.json 失败：${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rust `presets::builtin_channel_presets()`：内置 config.json 的渠道模板。 */
function builtinChannelPresets(): JsonRow[] {
  const builtin = readJsonFile(DEFAULT_BUILTIN_CONFIG);
  if (builtin === null) return [];
  try {
    return parseChannelsConfig(builtin).presets;
  } catch {
    return [];
  }
}

function parseConfigChannelsConfig(configValue: JsonRow): JsonRow[] {
  try {
    return parseChannelsConfig(configValue).presets;
  } catch (error) {
    throw CommandError.badRequest(`构建 ChannelsConfig 失败：${errorMessage(error)}`);
  }
}

interface PresetDiffItem {
  id: string;
  name: string;
  status: string;
  before: string | null;
  after: string | null;
}

interface NewExposedModel {
  channelId: string;
  channelName: string;
  modelId: string;
}

function presetSummary(preset: JsonRow): string {
  return `${String(preset.name ?? "")}/${String(preset.default_model ?? "")}`;
}

function sameStringArray(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const leftItems = normalize(left);
  const rightItems = normalize(right);
  return (
    leftItems.length === rightItems.length &&
    leftItems.every((item, index) => item === rightItems[index])
  );
}

function diffPresets(newPresets: JsonRow[], existing: JsonRow[], builtin: JsonRow[]): PresetDiffItem[] {
  const existingById = new Map(existing.map((preset) => [String(preset.id), preset]));
  const newById = new Map(newPresets.map((preset) => [String(preset.id), preset]));
  const items: PresetDiffItem[] = [];
  for (const preset of newPresets) {
    if (existingById.has(String(preset.id))) continue;
    items.push({
      id: String(preset.id),
      name: String(preset.name ?? ""),
      status: "added",
      before: null,
      after: presetSummary(preset),
    });
  }
  for (const preset of existing) {
    if (newById.has(String(preset.id))) continue;
    if (builtin.some((item) => item.id === preset.id)) continue;
    items.push({
      id: String(preset.id),
      name: String(preset.name ?? ""),
      status: "removed",
      before: presetSummary(preset),
      after: null,
    });
  }
  for (const preset of newPresets) {
    const current = existingById.get(String(preset.id));
    if (current === undefined) continue;
    const changes: string[] = [];
    if (current.name !== preset.name) {
      changes.push(`名称：${String(current.name ?? "")} → ${String(preset.name ?? "")}`);
    }
    if (current.default_model !== preset.default_model) {
      changes.push(
        `默认模型：${String(current.default_model ?? "")} → ${String(preset.default_model ?? "")}`,
      );
    }
    const currentSmall = typeof current.small_model === "string" ? current.small_model : null;
    const nextSmall = typeof preset.small_model === "string" ? preset.small_model : null;
    if (current.small_model !== preset.small_model) {
      const before = currentSmall ?? "-";
      const after = nextSmall ?? "-";
      if (before !== after) changes.push(`小型模型：${before} → ${after}`);
    }
    if ((current.platform_url ?? null) !== (preset.platform_url ?? null)) {
      changes.push("平台地址已更新");
    }
    if (!sameStringArray(current.supported_protocols, preset.supported_protocols)) {
      changes.push("支持协议已变更");
    }
    if (changes.length > 0) {
      items.push({
        id: String(preset.id),
        name: String(preset.name ?? ""),
        status: "updated",
        before: presetSummary(current),
        after: changes.join("；"),
      });
    }
  }
  return items;
}

/**
 * Rust `preview_new_exposed_models`：用与 `merge_default_routes` 相同的规则计算本次
 * 同步会补齐的模型（保留原数组顺序，只取追加项）。
 */
function previewNewExposedModels(
  existingRoutes: JsonRow[],
  accounts: JsonRow[],
  presets: JsonRow[],
): NewExposedModel[] {
  const merged = mergeDefaultRoutes(existingRoutes, accounts, presets);
  const channelNames = new Map(presets.map((preset) => [String(preset.id), String(preset.name ?? "")]));
  const seen = new Set<string>();
  const additions: NewExposedModel[] = [];
  for (const route of merged.slice(existingRoutes.length)) {
    const key = `${String(route.channel_id)}\0${String(route.upstream_model)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const channelId = String(route.channel_id);
    additions.push({
      channelId,
      channelName: channelNames.get(channelId) ?? channelId,
      modelId: String(route.upstream_model),
    });
  }
  return additions;
}

/**
 * Rust `migrate_channel_presets_from_config(storage, config_path, disable_newly_added)`：
 * 全量替换渠道预设；新增渠道默认禁用，已有渠道保留原启用状态。
 */
function migrateChannelPresets(ctx: DesktopContext, disableNewlyAdded: boolean): JsonRow[] {
  const configValue = readConfigJson(ctx.configPath);
  const presets = parseConfigChannelsConfig(configValue).map((preset) => ({ ...preset }));
  const builtin = builtinChannelPresets();
  for (const preset of builtin) {
    if (!presets.some((current) => current.id === preset.id)) presets.push({ ...preset });
  }
  const existingPresets = ctx.storage.listChannelPresets();
  const enabledById = new Map(existingPresets.map((preset) => [String(preset.id), Boolean(preset.enabled)]));
  for (const preset of presets) {
    const id = String(preset.id);
    if (disableNewlyAdded) {
      preset.enabled = enabledById.has(id) ? (enabledById.get(id) as boolean) : false;
    } else if (enabledById.has(id)) {
      preset.enabled = enabledById.get(id) as boolean;
    }
  }
  ctx.storage.saveChannelPresets(presets);
  return presets;
}

export const handlers: DesktopHandlerMap = {
  // ─── 会话目录（覆盖 Web Host 的 observed-only 实现） ─────────────────────
  "list_agent_sessions": async (ctx: DesktopContext, args: JsonRow) => {
    const filter = parseAgentSessionsFilter(args);
    const pending = await pendingSessionIds();
    return ctx.storage.withDatabase((db) => {
      const observed = listObservedAgentSessions(db);
      const native = enrichNativeAgentSessions(
        listNativeAgentSessions(),
        listAgentSnapshotDetails(db),
        ctx.storage.prices(),
      );
      const catalog = mergeAgentSessionCatalog(observed, native);
      applyOpencodePendingSessions(catalog, pending);
      markUnassociatedFlowletRequests(catalog, unassociatedFlowletClients(db));
      return agentSessionsPage(catalog, filter);
    });
  },

  "list_agent_session_children": (ctx: DesktopContext, args: JsonRow) => {
    const agentType = argString(args, "agentType");
    const parentSessionId = argString(args, "parentSessionId");
    const type = agentType.trim();
    const parent = parentSessionId.trim();
    if (type === "" || parent === "") return [];
    return ctx.storage.withDatabase((db) => {
      const observed = listObservedAgentSessions(db);
      const native = enrichNativeAgentSessions(
        listNativeAgentSessions(),
        listAgentSnapshotDetails(db),
        ctx.storage.prices(),
      );
      const catalog = mergeAgentSessionCatalog(observed, native);
      const rows = catalog.filter(
        (row) => row.agentType === type && row.parentSessionId === parent,
      );
      rows.sort(
        (left, right) =>
          sessionTimeMillis(String(right.activityAt)) - sessionTimeMillis(String(left.activityAt)),
      );
      return rows;
    });
  },

  // ─── OpenCode 权限 ───────────────────────────────────────────────────────
  "list_opencode_session_permissions": async (_ctx: DesktopContext, args: JsonRow) => {
    const sessionId = argString(args, "sessionId");
    return listSessionPermissions(sessionId);
  },

  "reply_opencode_permission": async (_ctx: DesktopContext, args: JsonRow) => {
    const permissionId = argString(args, "permissionId");
    const rawDecision = argString(args, "decision");
    let decision;
    try {
      decision = parsePermissionDecision(rawDecision);
    } catch (error) {
      throw argError("decision", errorMessage(error));
    }
    await replyPermission(permissionId, decision);
    return null;
  },

  // ─── Agent 原生会话读路径 ────────────────────────────────────────────────
  "get_agent_session_native_summary": (ctx: DesktopContext, args: JsonRow) => {
    const agentType = argString(args, "agentType");
    const sessionId = argString(args, "sessionId");
    const summary = getNativeAgentSessionSummary(agentType, sessionId);
    applyNativeCostEstimateToSummary(agentType, summary, ctx.storage.prices());
    return summary;
  },

  "get_agent_session_last_interaction": (ctx: DesktopContext, args: JsonRow) => {
    const agentType = argString(args, "agentType");
    const sessionId = argString(args, "sessionId");
    const interaction = getNativeAgentSessionLastInteraction(agentType, sessionId);
    if (interaction !== null) {
      applyNativeCostEstimateToTimeline(agentType, interaction, ctx.storage.prices());
    }
    return interaction;
  },

  "get_agent_session_timeline": (ctx: DesktopContext, args: JsonRow) => {
    const agentType = argString(args, "agentType");
    const sessionId = argString(args, "sessionId");
    const startedAt = argOptionalString(args, "startedAt");
    const endedAt = argOptionalString(args, "endedAt");
    let timeline = getNativeAgentSessionTimeline(agentType, sessionId);
    timeline = sliceNativeAgentSessionTimeline(timeline, startedAt, endedAt);
    applyNativeCostEstimateToTimeline(agentType, timeline, ctx.storage.prices());
    return timeline;
  },

  "get_agent_session_flowlet_usage": (ctx: DesktopContext, args: JsonRow) => {
    const agentType = argString(args, "agentType");
    const sessionId = argString(args, "sessionId");
    return ctx.storage.withDatabase((db) => agentSessionFlowletUsage(db, agentType, sessionId));
  },

  // ─── Agent 数据同步 ─────────────────────────────────────────────────────
  "sync_agent_data": (ctx: DesktopContext, args: JsonRow) => {
    const force = argBool(args, "force");
    const triggerSource = argString(args, "triggerSource");
    if (!tryAcquireAgentDataSync()) {
      return {
        started: false,
        jobId: null,
        scanned: 0,
        changed: 0,
        failed: 0,
        message: "已有 Agent 数据同步正在运行",
      };
    }
    const jobId = randomUUID();
    try {
      return syncAgentData(ctx.storage, { force, triggerSource, jobId });
    } finally {
      releaseAgentDataSync();
    }
  },

  "get_agent_sync_status": (ctx: DesktopContext) => agentSyncStatus(ctx.storage),

  // ─── 后台任务 ───────────────────────────────────────────────────────────
  "list_background_jobs": (ctx: DesktopContext, args: JsonRow) => {
    const filter = parseBackgroundJobsFilter(args);
    return ctx.storage.withDatabase((db) => listBackgroundJobs(db, filter));
  },

  "get_background_job_detail": (ctx: DesktopContext, args: JsonRow) => {
    const jobId = argString(args, "jobId");
    const detail = ctx.storage.withDatabase((db) => getBackgroundJobDetail(db, jobId));
    if (detail === null) throw CommandError.badRequest("任务日志不存在");
    return detail;
  },

  "cancel_background_job": (ctx: DesktopContext, args: JsonRow) => {
    const jobId = argString(args, "jobId");
    return ctx.storage.withDatabase((db) => requestBackgroundJobCancel(db, jobId));
  },

  "cleanup_background_jobs": (ctx: DesktopContext, args: JsonRow) => {
    const keepDays = argInteger(args, "keepDays", "u32");
    return ctx.storage.withDatabase((db) => cleanupBackgroundJobs(db, keepDays));
  },

  // ─── 会话筛选 / 原生用量 ────────────────────────────────────────────────
  "list_agent_session_clients": (ctx: DesktopContext) =>
    ctx.storage.withDatabase((db) => listAgentSessionClients(db)),

  "agent_native_usage_summary": (ctx: DesktopContext) =>
    ctx.storage.withDatabase((db) => agentNativeUsageSummary(db)),

  // ─── 渠道预设同步预览 / 应用 ────────────────────────────────────────────
  "preview_sync_channel_presets": (ctx: DesktopContext) => {
    const configValue = readConfigJson(ctx.configPath);
    const newPresets = parseConfigChannelsConfig(configValue).map((preset) => ({ ...preset }));
    const builtin = builtinChannelPresets();
    for (const preset of builtin) {
      if (!newPresets.some((current) => current.id === preset.id)) newPresets.push({ ...preset });
    }
    const existing = ctx.storage.listChannelPresets();
    const items = diffPresets(newPresets, existing, builtin);
    const existingRoutes = ctx.storage.listRouteCandidates();
    const existingAccounts = ctx.storage.listChannelAccounts();
    const newExposedModels = previewNewExposedModels(existingRoutes, existingAccounts, newPresets);
    const addedCount = items.filter((item) => item.status === "added").length;
    const removedCount = items.filter((item) => item.status === "removed").length;
    const updatedCount = items.filter((item) => item.status === "updated").length;
    return {
      hasChanges: items.length > 0 || newExposedModels.length > 0,
      addedCount,
      removedCount,
      updatedCount,
      newExposedModels,
      items,
    };
  },

  "apply_sync_channel_presets": (ctx: DesktopContext) => {
    const presets = migrateChannelPresets(ctx, true);
    const accounts = ctx.storage.listChannelAccounts();
    const existingRoutes = ctx.storage.listRouteCandidates();
    const merged = mergeDefaultRoutes(existingRoutes, accounts, presets);
    if (merged.length !== existingRoutes.length) {
      ctx.storage.saveRouteCandidates(merged);
    }
    ctx.runtimeConfig.update((snapshot) => {
      snapshot.channels = presets;
      snapshot.accounts = accounts;
      snapshot.routes = merged;
    });
    return null;
  },

  // ─── 成本账本数据源探测 ─────────────────────────────────────────────────
  "probe_cost_ledger_sources": (ctx: DesktopContext) =>
    probeCostLedgerSources(ctx.storage),
};
