// Web Host 命令 dispatch。Owner: node-web.
//
// 权威实现：src-tauri/src/core/web/commands.rs。命令名、参数名（camelCase）、
// 返回形状、错误 (status, code, message) 必须逐条等价。
// 存储/配置读写全部通过注入的 storage / runtimeConfig / proxy，不在 web 里写 SQL。
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CommandError } from "../types.ts";
import { a2aGateway } from "../a2a/gateway.ts";
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
  invalidType,
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
  checkGithubProvider,
  deleteGithubProvider,
  readGithubProvider,
  readGithubProviderSummary,
  saveGithubProvider,
  type GithubProviderInput,
} from "./auth-providers.ts";
import {
  checkOidcProvider,
  deleteOidcProvider,
  readLoginMode,
  readOidcProviderSummary,
  saveLoginMode,
  saveOidcProvider,
  type OidcProviderInput,
} from "./auth-oidc-provider.ts";
import type { AuthProviderId, GithubConfig } from "./auth.ts";
import {
  logout as qwenPlatformLogout,
  pollLogin as qwenPlatformPollLogin,
  startLogin as qwenPlatformStartLogin,
  status as qwenPlatformStatus,
  syncAccount as qwenPlatformSyncAccount,
} from "./qwen-platform.ts";
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

/**
 * 模型入口候选地址：`FLOWLET_PUBLIC_PROXY_URLS`（逗号分隔）优先，否则退回单个
 * `FLOWLET_PUBLIC_PROXY_URL`（即 `ctx.publicProxyUrl`）。首条为默认，去空白/尾斜杠/重复。
 *
 * 多个入口存在的理由：同一套服务可能同时挂内网 IP 和公网域名，管理台里展示的
 * `base_url` 必须跟访问者当前所在的 origin 一致，否则复制出来连不上。
 */
function publicProxyUrlsFromEnv(fallback: string): string[] {
  const raw = (process.env.FLOWLET_PUBLIC_PROXY_URLS ?? "").trim();
  const items = raw !== "" ? raw.split(",") : [fallback];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const value = item.trim().replace(/\/+$/, "");
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** 登录提供方表单参数：接受 snake_case（管理台）与 camelCase（旧调用）两种写法。 */
function parseGithubProviderArg(args: JsonRow): GithubProviderInput {
  const str = (key: string): string | null => {
    const value = args[key];
    return typeof value === "string" ? value : null;
  };
  const orCamel = (snake: string, camel: string): string | null => str(snake) ?? str(camel);
  const list = (key: string): string[] | null => {
    const value = args[key];
    return Array.isArray(value) ? value.map((item) => String(item)) : null;
  };
  const bool = (key: string): boolean | null =>
    typeof args[key] === "boolean" ? (args[key] as boolean) : null;
  return {
    client_id: orCamel("client_id", "clientId") ?? "",
    client_secret: orCamel("client_secret", "clientSecret"),
    scopes: str("scopes"),
    display_name: orCamel("display_name", "displayName"),
    allowed_logins: list("allowed_logins") ?? list("allowedLogins"),
    allowed_emails: list("allowed_emails") ?? list("allowedEmails"),
    allowed_orgs: list("allowed_orgs") ?? list("allowedOrgs"),
    admin_logins: list("admin_logins") ?? list("adminLogins"),
    admin_emails: list("admin_emails") ?? list("adminEmails"),
    allow_any: bool("allow_any") ?? bool("allowAny"),
    authorize_url: orCamel("authorize_url", "authorizeUrl"),
    token_url: orCamel("token_url", "tokenUrl"),
    api_base: orCamel("api_base", "apiBase"),
  };
}

/** 可选的字符串数组参数：缺省 / null 视为「没传」。 */
function optionalStringList(args: JsonRow, name: string): string[] | null {
  const value = args[name];
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw invalidType(value, "a sequence", name);
  return value.map((item) => {
    if (typeof item !== "string") throw invalidType(item, "a string", name);
    return item;
  });
}

/** OIDC 登录提供方表单参数：与 GitHub 同一套 snake_case / camelCase 兼容规则。 */
function parseOidcProviderArg(args: JsonRow): OidcProviderInput {
  const str = (key: string): string | null => {
    const value = args[key];
    return typeof value === "string" ? value : null;
  };
  const orCamel = (snake: string, camel: string): string | null => str(snake) ?? str(camel);
  const list = (key: string): string[] | null => optionalStringList(args, key);
  const bool = (key: string): boolean | null =>
    typeof args[key] === "boolean" ? (args[key] as boolean) : null;
  return {
    issuer: str("issuer"),
    discovery_url: orCamel("discovery_url", "discoveryUrl"),
    client_id: orCamel("client_id", "clientId"),
    client_secret: orCamel("client_secret", "clientSecret"),
    scopes: str("scopes"),
    redirect_urls: list("redirect_urls") ?? list("redirectUrls"),
    display_name: orCamel("display_name", "displayName"),
    email_claim: orCamel("email_claim", "emailClaim"),
    name_claim: orCamel("name_claim", "nameClaim"),
    groups_claim: orCamel("groups_claim", "groupsClaim"),
    allowed_subs: list("allowed_subs") ?? list("allowedSubs"),
    allowed_groups: list("allowed_groups") ?? list("allowedGroups"),
    allowed_emails: list("allowed_emails") ?? list("allowedEmails"),
    allowed_domains: list("allowed_domains") ?? list("allowedDomains"),
    admin_subs: list("admin_subs") ?? list("adminSubs"),
    admin_emails: list("admin_emails") ?? list("adminEmails"),
    allow_any: bool("allow_any") ?? bool("allowAny"),
    allow_http_issuer: bool("allow_http_issuer") ?? bool("allowHttpIssuer"),
    insecure_http: bool("insecure_http") ?? bool("insecureHttp"),
    pkce: str("pkce"),
    nonce: str("nonce"),
  };
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
  for (const field of ["id", "token", "kind", "note", "envPrefix", "username"]) {
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
    case "list_a2a_agents":
      return a2aGateway(ctx).list();
    case "inspect_a2a_agent":
      return a2aGateway(ctx).inspect(args.input);
    case "save_a2a_agent":
      return a2aGateway(ctx).save(args.input);
    case "delete_a2a_agent":
      a2aGateway(ctx).store.remove(argString(args, "id")); return null;
    case "list_a2a_keys":
      return a2aGateway(ctx).store.keys();
    case "create_a2a_key":
      return a2aGateway(ctx).createKey(args.name, args.agentIds);
    case "revoke_a2a_key":
      a2aGateway(ctx).store.revokeKey(argString(args, "id")); return null;
    case "list_a2a_calls":
      return a2aGateway(ctx).calls(argOptionalString(args, "agentId") ?? undefined);
    case "invoke_a2a_agent":
      return a2aGateway(ctx).invoke(argString(args, "id"), args.rpc);
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
    case "web_connection_info": {
      // 同一套服务可能有多个入口（内网 IP + 公网域名）：界面按当前 origin 挑一条。
      // 这里直接读环境变量，避免把展示用的候选列表塞进 WebHostOptions（改动面最小）。
      const baseUrls = publicProxyUrlsFromEnv(ctx.publicProxyUrl);
      return {
        base_url: baseUrls[0] ?? ctx.publicProxyUrl,
        base_urls: baseUrls,
        client_token: ctx.proxy.bindConfig().default_client_token,
      };
    }
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

    // 千问平台 device-flow 登录与 HTTP 直连同步：Web Host 没有 WebView，这条路径是
    // 它获取余额与免费额度的唯一方式（权威实现 src-tauri/src/core/qwen_platform.rs）。
    case "qwen_platform_status":
      return qwenPlatformStatus(ctx, argString(args, "accountId"));
    case "qwen_platform_login_start":
      return qwenPlatformStartLogin(ctx, argString(args, "accountId"));
    case "qwen_platform_login_poll":
      return qwenPlatformPollLogin(ctx, argString(args, "accountId"));
    case "qwen_platform_logout":
      qwenPlatformLogout(ctx, argString(args, "accountId"));
      return null;
    case "qwen_platform_sync":
      return qwenPlatformSyncAccount(ctx, argString(args, "accountId"));

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

    // ── 管理台登录提供方（GitHub）：改完立即热替换，不用重启进程 ──────────
    case "get_github_auth_provider":
      return readGithubProviderSummary(ctx.storage, ctx.auth?.config.github ?? null);
    case "set_github_auth_provider": {
      const input = parseGithubProviderArg(args);
      let config: GithubConfig;
      try {
        config = saveGithubProvider(ctx.storage, ctx.secrets, input);
      } catch (error) {
        throw CommandError.badRequest(error instanceof Error ? error.message : String(error));
      }
      ctx.auth?.applyGithubConfig(config);
      return null;
    }
    case "delete_github_auth_provider": {
      const auth = ctx.auth;
      if (auth && auth.enabledProviders().includes("github") &&
          !auth.enabledProviders().some((id) => id === "oidc" && auth.oidcDeployed()) &&
          auth.mode() !== "token" && !auth.config.allowTokenLogin) {
        throw CommandError.badRequest("不能删除最后一个可用登录方式，请先启用 OIDC 或静态管理凭据兜底");
      }
      deleteGithubProvider(ctx.storage);
      ctx.auth?.applyGithubConfig(null);
      return null;
    }
    // ── 管理台登录提供方（OIDC / GitLab）：准入与角色可在界面上改，改完立即生效 ──
    case "get_oidc_auth_provider": {
      const summary = readOidcProviderSummary(ctx.storage, ctx.auth?.config.oidc ?? null);
      // 部署级配置缺失时，光有库里记录也登录不了：明确告诉界面「开关无效」。
      return { ...summary, deployment_ready: ctx.auth?.oidcDeployed() === true };
    }
    case "set_oidc_auth_provider": {
      const input = parseOidcProviderArg(args);
      let override: ReturnType<typeof saveOidcProvider>;
      try {
        override = saveOidcProvider(ctx.storage, input, ctx.auth?.oidcDeployment ?? null);
      } catch (error) {
        throw CommandError.badRequest(error instanceof Error ? error.message : String(error));
      }
      ctx.auth?.applyOidcRuntimeConfig(override);
      return null;
    }
    case "delete_oidc_auth_provider": {
      const auth = ctx.auth;
      if (auth === undefined || auth.config.oidc === null) {
        deleteOidcProvider(ctx.storage);
        return null;
      }
      deleteOidcProvider(ctx.storage);
      auth.resetOidcRuntimeConfig();
      return null;
    }
    case "check_oidc_auth_provider": {
      const env = ctx.auth?.oidcDeployment;
      if (!env) throw CommandError.badRequest("请先在部署环境配置 OIDC");
      return await checkOidcProvider({
        issuer: env.issuer,
        discoveryUrl: env.discoveryUrl,
        clientId: env.clientId,
        clientSecret: env.clientSecret,
        insecureHttp: env.insecureHttp,
      });
    }

    // ── 启用哪些登录方式：oidc / github 可各自开关 ─────────────────────────
    case "get_admin_login_mode": {
      const auth = ctx.auth;
      const resolved = readLoginMode(ctx.storage, {
        oidc: auth?.oidcDeployed() === true,
        github: auth?.config.github != null,
      });
      const enabled = auth?.enabledProviders() ?? [];
      return {
        enabled,
        source: resolved.source,
        oidc_configured: auth?.oidcDeployed() === true,
        github_configured: auth?.config.github != null,
        token_login: auth?.config.allowTokenLogin === true || auth?.mode() === "token",
      };
    }
    case "set_admin_login_mode": {
      const requested = optionalStringList(args, "enabled");
      if (requested === null || requested.some((id) => id !== "oidc" && id !== "github")) {
        throw CommandError.badRequest("enabled 必须是 oidc / github 字符串数组");
      }
      const enabled = [...new Set(requested)] as AuthProviderId[];
      const auth = ctx.auth;
      if (auth !== undefined) {
        if (enabled.length > 0 && auth.mode() !== "oidc") {
          throw CommandError.badRequest("启用 SSO 登录前，请先在部署环境设置 FLOWLET_ADMIN_AUTH_MODE=oidc");
        }
        if (enabled.some((id) => id === "oidc" ? !auth.oidcDeployed() : !auth.config.github)) {
          throw CommandError.badRequest("不能启用尚未配置的登录方式");
        }
        const previous = auth.config.enabledProviders;
        const tokenUsable = auth.mode() === "token" || auth.config.allowTokenLogin;
        const stillHasProvider = enabled.some((id) =>
          id === "oidc" ? auth.oidcDeployed() : auth.config.github != null,
        );
        if (!stillHasProvider && !tokenUsable) {
          // OIDC-only 部署里关掉最后一个登录方式 = 把自己锁在门外（静态凭据要
          // FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN=1 才生效）。先拒绝，别等保存完才发现。
          throw CommandError.badRequest(
            "至少要保留一个可用的登录方式：请保留 OIDC / GitHub 之一，或先在部署环境开启静态管理凭据兜底（FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN=1）",
          );
        }
        auth.setEnabledProviders(enabled);
        // 持久化失败就把开关退回原值，避免「界面显示关了、重启又打开」。
        try {
          saveLoginMode(ctx.storage, {
            oidc: enabled.includes("oidc"),
            github: enabled.includes("github"),
          });
        } catch (error) {
          auth.setEnabledProviders(previous);
          throw error;
        }
      } else {
        saveLoginMode(ctx.storage, {
          oidc: enabled.includes("oidc"),
          github: enabled.includes("github"),
        });
      }
      return { oidc: enabled.includes("oidc"), github: enabled.includes("github") };
    }

    case "check_github_auth_provider": {
      const input = parseGithubProviderArg(args);
      const stored = readGithubProvider(ctx.storage, ctx.secrets) ?? ctx.auth?.config.github ?? null;
      const clientId = (input.client_id ?? "").trim();
      // 表单不回显 secret：留空就用已存的，避免为了点一次「校验」逼用户重填。
      const clientSecret = (input.client_secret ?? "").trim() || stored?.clientSecret || "";
      if (clientId === "" || clientSecret === "") {
        throw CommandError.badRequest("校验需要 client_id 与 client_secret");
      }
      return await checkGithubProvider({
        clientId,
        clientSecret,
        tokenUrl:
          (input.token_url ?? "").trim() ||
          stored?.tokenUrl ||
          "https://github.com/login/oauth/access_token",
      });
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

