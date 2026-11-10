// Web Host 命令 dispatch。Owner: node-web.
//
// 权威实现：src-tauri/src/core/web/commands.rs。命令名、参数名（camelCase）、
// 返回形状、错误 (status, code, message) 必须逐条等价。
// 存储/配置读写全部通过注入的 storage / runtimeConfig / proxy，不在 web 里写 SQL。
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CommandError } from "../types.ts";
import type { JsonRow } from "../types.ts";
import type { WebContext } from "./context.ts";
import {
  LOG_CAPTURE_META_KEY,
  UPSTREAM_PROXY_META_KEY,
  normalizeBindConfig,
  parseBindConfigArg,
  parseLogCaptureArg,
  parseUpstreamProxyArg,
  validateBindConfig,
  validateUpstreamProxy,
} from "./config-state.ts";
import {
  argArray,
  argInteger,
  argObject,
  argOptionalBool,
  argOptionalString,
  argString,
  argsObject,
  requireFields,
} from "./errors.ts";
import {
  listCustomScrapeChannels,
  readModelsCnCatalog,
  readModelsCnCurrencies,
  readModelsDevProviderCatalog,
} from "./catalog-files.ts";
import { queryBalance } from "./balance.ts";
import {
  deleteCredential,
  exportCredentials,
  revealCredential,
  list as listCredentials,
  providers as credentialProviders,
  save as saveCredential,
  test as testCredential,
  type ServiceCredentialInput,
} from "./credentials.ts";
import { suggestEnvPrefixSegment } from "./env-prefix.ts";
import { fetchChannelModels, testChannelConnection, transientAccount } from "./model-sync.ts";
import { getUpstream, requestErrorDetail } from "./upstream.ts";
import { loadUaRules } from "../proxy/identity.ts";

/** 与 node-storage 确认过的 storage 方法签名（web 只按此调用）。 */
interface StorageFacade {
  getAppMeta(key: string): string | null;
  setAppMeta(key: string, value: string): void;
  listChannelAccounts(): JsonRow[];
  saveChannelAccounts(accounts: JsonRow[]): JsonRow[] | void;
  saveRouteCandidates(routes: JsonRow[]): void;
  saveVirtualModels(models: JsonRow[]): void;
  listChannelModels(): JsonRow[];
  saveChannelModels(models: JsonRow[]): void;
  latestBalanceSnapshots(): JsonRow[];
  saveBalanceSnapshot(snapshot: JsonRow): void;
  listRequestLogsPage(filter: JsonRow): JsonRow;
  listRequestLogsByRequestId(requestId: string): JsonRow[];
  listRequestLogClients(): JsonRow[];
  listRequestLogModels(): JsonRow;
  listRequestLogChannelAccounts(): JsonRow;
  cleanupOldLogs(keepDays: number): [number, number];
  listKnownDevices(identity: JsonRow): JsonRow[];
  deviceDailyUsage(currentDeviceId: string, deviceId?: string): JsonRow[];
  deviceHourlyUsage(currentDeviceId: string, deviceId?: string): JsonRow[];
  listObservedAgentSessionsPage(filter: JsonRow): JsonRow;
  listObservedAgentSessionChildren(agentType: string, parentSessionId: string): JsonRow[];
  accountRoutingScores(): JsonRow[];
  usageSummaryRange(
    startAt: string | null,
    endAt: string | null,
    groupBy: string,
    currentDeviceId: string,
  ): JsonRow[];
  usageTodaySummary(): JsonRow;
  repairAgentSessions(timeRange: string, uaRules: ReturnType<typeof loadUaRules>): JsonRow;
  repairCapturedUsage(timeRange: string): number;
  repairUnknownUsage(timeRange: string): number;
  repairUsageCosts(timeRange: string): number;
  markAccountCredentialHealthy(accountId: string): void;
  markAccountCredentialInvalid(accountId: string): void;
  updateAccountLastError(accountId: string, error: string | null): void;
}

function storageOf(ctx: WebContext): StorageFacade {
  return ctx.storage as unknown as StorageFacade;
}

// ─── 参数结构校验（复刻 serde 的必填字段 / 类型错误） ──────────────────────

const CHANNEL_ACCOUNT_REQUIRED = [
  "id",
  "channel_id",
  "name",
  "api_key",
  "enabled",
  "priority",
  "remark",
  "base_url_override",
  "last_used_at",
  "last_error",
  "created_at",
  "updated_at",
];
const ROUTE_CANDIDATE_REQUIRED = [
  "id",
  "virtual_model_id",
  "channel_id",
  "account_id",
  "upstream_model",
  "client_protocol",
  "priority",
  "enabled",
  "created_at",
  "updated_at",
];
const VIRTUAL_MODEL_REQUIRED = [
  "id",
  "name",
  "protocol_type",
  "routing_strategy",
  "enabled",
  "created_at",
  "updated_at",
];
const BALANCE_SNAPSHOT_REQUIRED = [
  "id",
  "account_id",
  "balance",
  "currency",
  "token_pack_total",
  "token_pack_used",
  "token_pack_remaining",
  "token_pack_expire_at",
  "token_packs",
  "source",
  "synced_at",
  "remark",
  "created_at",
  "updated_at",
];

function structArray(args: JsonRow, name: string, structName: string, required: string[]): JsonRow[] {
  const rows = argArray(args, name, structName);
  for (const row of rows) requireFields(row, name, required);
  return rows;
}

const LOGS_FILTER_REQUIRED = ["page", "page_size", "status", "client_id", "channel_id", "search"];
const LOGS_FILTER_OPTIONAL = ["time_range", "model", "model_kind", "start_at", "end_at", "token_status", "account_id"];

function parseLogsFilter(args: JsonRow): JsonRow {
  const filter = argObject(args, "filter", "LogsFilter");
  requireFields(filter, "filter", LOGS_FILTER_REQUIRED);
  for (const field of ["page", "page_size"]) {
    if (typeof filter[field] !== "number" || !Number.isInteger(filter[field])) {
      throw CommandError.badRequest(`参数 filter: field \`${field}\`: invalid type: ${describe(filter[field])}, expected u32`);
    }
  }
  for (const field of ["status", "client_id", "channel_id", "search"]) {
    if (typeof filter[field] !== "string") {
      throw CommandError.badRequest(`参数 filter: field \`${field}\`: invalid type: ${describe(filter[field])}, expected a string`);
    }
  }
  const next: JsonRow = { ...filter };
  for (const field of LOGS_FILTER_OPTIONAL) {
    if (next[field] === undefined) next[field] = "";
  }
  return next;
}

function parseAgentSessionsFilter(args: JsonRow): JsonRow {
  const filter = argObject(args, "filter", "AgentSessionsFilter");
  requireFields(filter, "filter", ["page", "page_size"]);
  for (const field of ["page", "page_size"]) {
    if (typeof filter[field] !== "number" || !Number.isInteger(filter[field])) {
      throw CommandError.badRequest(`参数 filter: field \`${field}\`: invalid type: ${describe(filter[field])}, expected u32`);
    }
  }
  const next: JsonRow = { ...filter };
  for (const field of ["search", "agent_type", "runtime_status", "project_path"]) {
    if (next[field] === undefined) next[field] = "";
  }
  return next;
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === "boolean") return `boolean \`${value}\``;
  return Array.isArray(value) ? "sequence" : "map";
}

/** Rust chrono `parse_from_rfc3339` 的常见错误文本（近似复刻）。 */
function parseRfc3339(label: string, value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!match) throw CommandError.badRequest("premature end of input");
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw CommandError.badRequest("premature end of input");
  void label;
  return time;
}

function snapshot(ctx: WebContext): JsonRow {
  return ctx.runtimeConfig.snapshot();
}

function snapshotArray(ctx: WebContext, field: string): JsonRow[] {
  const value = snapshot(ctx)[field];
  return Array.isArray(value) ? (value as JsonRow[]) : [];
}

function currentDeviceId(ctx: WebContext): string {
  return String(ctx.deviceIdentity.device_id ?? "");
}

function knownDeviceIdentity(ctx: WebContext): JsonRow {
  return {
    device_id: ctx.deviceIdentity.device_id,
    created_at: ctx.deviceIdentity.created_at,
    display_name: ctx.deviceIdentity.display_name,
    platform: ctx.deviceIdentity.platform,
    app_version: ctx.deviceIdentity.app_version,
  };
}

async function syncCatalog(
  ctx: WebContext,
  source: "models-cn" | "models.dev",
  sourceUrl: string,
): Promise<JsonRow> {
  const fileName = source === "models-cn" ? "models-cn.json" : "models-dev.json";
  const title = source === "models-cn" ? "models-cn 目录同步" : "models.dev 目录同步";
  void title;
  let body: string;
  try {
    const response = await getUpstream(sourceUrl, { timeoutMs: 30_000, proxy: ctx.upstreamProxy });
    if (response.status < 200 || response.status >= 300) {
      throw CommandError.badRequest(`${source} 返回 HTTP ${response.status}`);
    }
    body = response.body;
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw CommandError.badRequest(`请求 ${source} 失败：${requestErrorDetail(error)}`);
  }
  const contentHash = `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
  const filePath = path.join(ctx.catalogDir, fileName);
  let existing: string | null = null;
  try {
    existing = readFileSync(filePath, "utf8");
  } catch {
    existing = null;
  }
  if (existing !== null) {
    const existingHash = `sha256:${createHash("sha256").update(existing, "utf8").digest("hex")}`;
    if (existingHash === contentHash) {
      return {
        source,
        started: false,
        job_id: null,
        skipped: true,
        provider_count: 0,
        model_count: 0,
        message: `${source} 数据未变化，跳过保存`,
      };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw CommandError.badRequest(
      `解析 ${source} JSON 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const [providerCount, modelCount] = countCatalog(source, parsed);
  const tmpPath = `${filePath}.tmp`;
  try {
    writeFileSync(tmpPath, body);
    renameSync(tmpPath, filePath);
  } catch (error) {
    throw CommandError.badRequest(`写入目录文件失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    source,
    started: true,
    job_id: randomUUID(),
    skipped: false,
    provider_count: providerCount,
    model_count: modelCount,
    message: `同步完成：${providerCount} 个厂商、${modelCount} 个模型`,
  };
}

function countCatalog(source: "models-cn" | "models.dev", parsed: unknown): [number, number] {
  if (parsed === null || typeof parsed !== "object") return [0, 0];
  if (source === "models-cn") {
    const providers = (parsed as JsonRow).providers;
    if (!Array.isArray(providers)) return [0, 0];
    let models = 0;
    for (const provider of providers) {
      if (provider === null || typeof provider !== "object") continue;
      const rows = (provider as JsonRow).models;
      if (Array.isArray(rows)) models += rows.length;
    }
    return [providers.length, models];
  }
  const providers = Object.values(parsed as JsonRow);
  let models = 0;
  for (const provider of providers) {
    if (provider === null || typeof provider !== "object") continue;
    const rows = (provider as JsonRow).models;
    if (rows !== null && typeof rows === "object" && !Array.isArray(rows)) {
      models += Object.keys(rows).length;
    }
  }
  return [providers.length, models];
}

/** `save_service_credential` 的 input 结构校验（serde camelCase 必填字段）。 */
function parseServiceCredentialInput(args: JsonRow): ServiceCredentialInput {
  const value = argObject(args, "input", "ServiceCredentialInput");
  requireFields(value, "input", ["name", "provider", "baseUrl"]);
  for (const field of ["name", "provider", "baseUrl"]) {
    if (typeof value[field] !== "string") {
      throw CommandError.badRequest(
        `参数 input: field \`${field}\`: invalid type: ${describe(value[field])}, expected a string`,
      );
    }
  }
  for (const field of ["id", "token", "kind", "note", "envPrefix"]) {
    const item = value[field];
    if (item !== undefined && item !== null && typeof item !== "string") {
      throw CommandError.badRequest(
        `参数 input: field \`${field}\`: invalid type: ${describe(item)}, expected a string`,
      );
    }
  }
  if (value.enabled !== undefined && value.enabled !== null && typeof value.enabled !== "boolean") {
    throw CommandError.badRequest(
      `参数 input: field \`enabled\`: invalid type: ${describe(value.enabled)}, expected a boolean`,
    );
  }
  return value as unknown as ServiceCredentialInput;
}

// ─── dispatch ───────────────────────────────────────────────────────────────

export async function dispatch(ctx: WebContext, command: string, rawArgs: unknown): Promise<unknown> {
  const args = argsObject(rawArgs);
  const s = storageOf(ctx);

  switch (command) {
    case "ipc_ping":
      return { ok: true, host: "web" };
    case "list_channel_presets":
      return snapshotArray(ctx, "channels");
    case "list_channel_accounts":
      return snapshotArray(ctx, "accounts");
    case "list_route_candidates":
      return snapshotArray(ctx, "routes");
    case "list_virtual_models":
      return snapshotArray(ctx, "virtual_models");
    case "list_channel_models":
      return s.listChannelModels();

    case "save_channel_accounts": {
      const accounts = structArray(args, "accounts", "ChannelAccount", CHANNEL_ACCOUNT_REQUIRED);
      const saved = s.saveChannelAccounts(accounts);
      const normalized = Array.isArray(saved) ? saved : s.listChannelAccounts();
      ctx.runtimeConfig.update((draft) => {
        draft.accounts = normalized;
      });
      return normalized;
    }
    case "save_route_candidates": {
      const routes = structArray(args, "routes", "RouteCandidate", ROUTE_CANDIDATE_REQUIRED);
      s.saveRouteCandidates(routes);
      // Rust 直接把入参写进快照（不重新读取），这里保持同样语义。
      ctx.runtimeConfig.update((draft) => {
        draft.routes = routes;
      });
      return null;
    }
    case "save_virtual_models": {
      const models = structArray(args, "models", "VirtualModel", VIRTUAL_MODEL_REQUIRED);
      s.saveVirtualModels(models);
      ctx.runtimeConfig.update((draft) => {
        draft.virtual_models = models;
      });
      return null;
    }

    case "proxy_status":
      return ctx.proxy.status();
    case "start_proxy":
      await ctx.proxy.start();
      return null;
    case "stop_proxy":
      await ctx.proxy.stop();
      return null;
    case "get_proxy_bind_config":
      return ctx.proxy.bindConfig();
    case "web_connection_info":
      return {
        base_url: ctx.publicProxyUrl,
        client_token: ctx.proxy.bindConfig().default_client_token,
      };
    case "set_proxy_bind_config": {
      const config = parseBindConfigArg(args);
      const normalized = normalizeBindConfig(config);
      try {
        validateBindConfig(normalized);
      } catch (error) {
        throw CommandError.badRequest(error instanceof Error ? error.message : String(error));
      }
      // Rust 先更新内存 bind config，再持久化调用方传入的原始值（不写归一化结果）。
      ctx.storage.setAppMeta("proxy_bind_config", JSON.stringify(config));
      ctx.proxy.setBindConfig(normalized);
      return null;
    }

    case "list_custom_scrape_channels":
      if (ctx.customScrapeChannels === undefined || ctx.customScrapeChannels === null) {
        ctx.customScrapeChannels = listCustomScrapeChannels() as unknown as JsonRow[];
      }
      return ctx.customScrapeChannels;

    case "cleanup_old_logs": {
      const days = argInteger(args, "keepDays");
      if (days < 0) throw CommandError.badRequest("保留天数不能小于零");
      return s.cleanupOldLogs(days);
    }
    case "latest_balance_snapshots":
      return s.latestBalanceSnapshots();
    case "save_balance_snapshot": {
      const balance = argObject(args, "snapshot", "AccountBalanceSnapshot");
      requireFields(balance, "snapshot", BALANCE_SNAPSHOT_REQUIRED);
      s.saveBalanceSnapshot(balance);
      return null;
    }
    case "query_balance":
      return queryBalance(ctx, argString(args, "accountId"));

    case "list_request_logs": {
      // Rust LogsPageResult 是 camelCase 结构体：page/pageSize。storage 层曾用
      // page_size（历史 stub 契约），这里做一次字段归一，保证 Web 输出与 Rust 逐字段一致。
      const page = s.listRequestLogsPage(parseLogsFilter(args));
      if (page && typeof page === "object" && !("pageSize" in page) && "page_size" in page) {
        const { page_size: pageSize, ...rest } = page as JsonRow;
        return { ...rest, pageSize };
      }
      return page;
    }
    case "list_known_devices":
      return s.listKnownDevices(knownDeviceIdentity(ctx));
    case "device_daily_usage": {
      const deviceId = argOptionalString(args, "deviceId");
      return s.deviceDailyUsage(currentDeviceId(ctx), deviceId ?? undefined);
    }
    case "device_hourly_usage": {
      const deviceId = argOptionalString(args, "deviceId");
      return s.deviceHourlyUsage(currentDeviceId(ctx), deviceId ?? undefined);
    }
    case "list_request_log_clients":
      return s.listRequestLogClients();
    case "list_request_log_models":
      return s.listRequestLogModels();
    case "list_request_log_channel_accounts":
      return s.listRequestLogChannelAccounts();
    case "get_request_log_detail":
      return s.listRequestLogsByRequestId(argString(args, "requestId"));

    case "list_agent_sessions":
      return s.listObservedAgentSessionsPage(parseAgentSessionsFilter(args));
    case "list_agent_session_children":
      return s.listObservedAgentSessionChildren(
        argString(args, "agentType"),
        argString(args, "parentSessionId"),
      );
    case "account_routing_scores":
      return s.accountRoutingScores();

    case "usage_summary": {
      const start = argOptionalString(args, "startAt");
      const end = argOptionalString(args, "endAt");
      const group = argString(args, "groupBy");
      if (group !== "hour" && group !== "day") throw CommandError.badRequest("无效的分组粒度");
      if (start === null && end === null) {
        /* 无范围 */
      } else if (start !== null && end !== null) {
        if (parseRfc3339("startAt", start) >= parseRfc3339("endAt", end)) {
          throw CommandError.badRequest("开始时间必须早于结束时间，且必须同时提供");
        }
      } else {
        throw CommandError.badRequest("开始时间必须早于结束时间，且必须同时提供");
      }
      return s.usageSummaryRange(start, end, group, currentDeviceId(ctx));
    }
    case "usage_today_tokens":
      return s.usageTodaySummary();

    // 桌面端「设置 → 数据维护 → 数据完整性检查」四阶段（Web Host 等价实现）。
    case "repair_agent_sessions":
      return s.repairAgentSessions(argString(args, "timeRange"), loadUaRules(ctx.configPath));
    case "repair_captured_usage":
      return s.repairCapturedUsage(argString(args, "timeRange"));
    case "repair_unknown_usage":
      return s.repairUnknownUsage(argString(args, "timeRange"));
    case "repair_usage_costs":
      return s.repairUsageCosts(argString(args, "timeRange"));

    case "get_log_capture_config":
      return { ...ctx.logCapture };
    case "set_log_capture_config": {
      const capture = parseLogCaptureArg(args);
      ctx.storage.setAppMeta(LOG_CAPTURE_META_KEY, JSON.stringify(capture));
      ctx.logCapture = capture;
      return null;
    }
    case "read_app_meta":
      return s.getAppMeta(argString(args, "key"));
    case "write_app_meta": {
      const key = argString(args, "key");
      if (key !== "model_exposure_mode" && key !== "usage_cost_display_config") {
        throw CommandError.badRequest("Web 模式不允许修改此内部设置");
      }
      s.setAppMeta(key, argString(args, "value"));
      return null;
    }

    case "get_models_cn_catalog":
      return readModelsCnCatalog(ctx.catalogDir);
    case "get_models_dev_provider_catalog":
      return readModelsDevProviderCatalog(ctx.catalogDir, argString(args, "providerId"));
    case "get_models_cn_currencies":
      return readModelsCnCurrencies(ctx.catalogDir);

    case "list_credential_providers":
      return credentialProviders();
    case "list_service_credentials":
      return listCredentials(ctx);
    case "save_service_credential": {
      const input = parseServiceCredentialInput(args);
      const insecure = argOptionalBool(args, "insecure");
      return saveCredential(ctx, input, insecure ?? false);
    }
    case "test_service_credential":
      return testCredential(ctx, argString(args, "id"), argOptionalBool(args, "insecure") ?? false);
    case "delete_service_credential":
      return deleteCredential(ctx, argString(args, "id"));
    case "export_service_credentials":
      return exportCredentials(ctx);
    case "reveal_service_credential":
      return revealCredential(ctx, argString(args, "id"));

    // CLI 浏览器授权（`flowlet login`）：授权码由已登录会话签发，token 只读服务凭据。
    case "create_cli_auth_code":
      return ctx.cliAuth.authorize({
        redirectUri: argString(args, "redirectUri"),
        state: argString(args, "state"),
        codeChallenge: argString(args, "codeChallenge"),
        name: argOptionalString(args, "name"),
      });
    case "list_cli_auth_tokens":
      return ctx.cliAuth.list();
    case "revoke_cli_auth_token":
      return ctx.cliAuth.revoke(argString(args, "id"));

    // 环境前缀「AI 生成」：用已开放模型把名称/备注概括成片段（显式按钮触发，会计一次模型调用）。
    case "suggest_env_prefix_segment":
      return suggestEnvPrefixSegment(ctx, {
        provider: argString(args, "provider"),
        providerDefault: argString(args, "providerDefault"),
        name: argString(args, "name"),
        note: argOptionalString(args, "note"),
        // `used` 是字符串数组（非结构体数组）；缺省/非数组按空处理，交给服务端截断。
        used: Array.isArray(args["used"])
          ? (args["used"] as unknown[]).filter((item): item is string => typeof item === "string")
          : [],
      });

    case "get_upstream_proxy_config":
      return { ...ctx.upstreamProxy };
    case "set_upstream_proxy_config": {
      const config = parseUpstreamProxyArg(args);
      try {
        validateUpstreamProxy(config);
      } catch (error) {
        throw CommandError.badRequest(
          error instanceof Error ? error.message.replace(/^参数 config: /, "") : String(error),
        );
      }
      ctx.storage.setAppMeta(UPSTREAM_PROXY_META_KEY, JSON.stringify(config));
      ctx.upstreamProxy = config;
      return null;
    }

    case "test_connection": {
      const account = transientAccount({
        channelId: argString(args, "channelId"),
        apiKey: argString(args, "apiKey"),
        baseUrlOverride: argOptionalString(args, "baseUrlOverride"),
        useUpstreamProxy: argOptionalBool(args, "useUpstreamProxy"),
      });
      await testChannelConnection(ctx, account);
      return null;
    }
    case "fetch_channel_models": {
      const channelId = argString(args, "channelId");
      const account = transientAccount({
        channelId,
        apiKey: argString(args, "apiKey"),
        baseUrlOverride: argOptionalString(args, "baseUrlOverride"),
        useUpstreamProxy: argOptionalBool(args, "useUpstreamProxy"),
      });
      const result = await fetchChannelModels(ctx, account);
      if (result.errors.length === 0) {
        const models = s.listChannelModels().filter((model) => model.channel_id !== channelId);
        models.push(...result.models);
        s.saveChannelModels(models);
      }
      return result;
    }
    case "sync_models_cn_catalog": {
      const source = argString(args, "sourceUrl");
      argString(args, "triggerSource");
      return syncCatalog(ctx, "models-cn", source);
    }
    case "sync_models_dev_catalog": {
      const source = argString(args, "sourceUrl");
      argString(args, "triggerSource");
      return syncCatalog(ctx, "models.dev", source);
    }

    default:
      throw CommandError.notImplemented(command);
  }
}

