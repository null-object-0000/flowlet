// 桌面 Agent 接入命令（批次 1）。Owner: desktop-agent。
//
// 负责 17 条命令：detect_agent_environment / start_agent_runtime / stop_agent_runtime /
// check_agent_latest_versions / list_cached_codex_accounts / query_codex_account /
// query_codex_accounts / query_antigravity_accounts / authorize_antigravity_account /
// delete_antigravity_account / sync_codex_accounts / authorize_codex_account /
// delete_codex_account / inspect_agent_global_config / apply_agent_global_config /
// restore_agent_global_config / list_agent_capabilities。
//
// 权威行为：src-tauri/src/commands/agent.rs 与 src-tauri/src/core/agent_*.rs。
// 本机文件读写（Codex/Claude Code/OpenCode/Pi/DSH/Hermes 全局配置）保注释与格式，
// 生命周期契约见 AGENTS.md §8（inspect → apply → reapply → disable → restore）。
import path from "node:path";

import type { JsonRow } from "../types.ts";
import { CommandError } from "../types.ts";
import { argString } from "../web/errors.ts";
import {
  applyAgentGlobalConfig as applyGlobalConfig,
  inspectAgentGlobalConfig as inspectGlobalConfig,
  restoreAgentGlobalConfig as restoreGlobalConfig,
} from "../agent/adapters/index.ts";
import {
  authorizeAntigravityAccount,
  deleteAntigravityAccount,
  queryAntigravityOauthAccounts,
} from "../agent/antigravity-oauth.ts";
import { queryAntigravityAccounts } from "../agent/antigravity.ts";
import {
  authorizeCodexAccount,
  codexAccountsDir,
  deleteCodexAccount,
  listCachedCodexAccounts,
  queryCodexAccount,
  queryCodexAccounts,
  syncCodexAccounts,
} from "../agent/codex-account.ts";
import {
  detectAgentEnvironment,
  runtimeCommandFor,
  type AgentEnvironmentReport,
} from "../agent/environment.ts";
import { readModelsCnSource } from "../agent/models-cn.ts";
import {
  agentEndpointSuffix,
  agentGlobalConfigAdapterId,
  agentProtocols,
  availableAgentModels,
  resolveFastModel,
  resolveRequestedModel,
  type AgentGlobalConfigOptions,
  type McpServerSpecInput,
} from "../agent/models.ts";
import { agentDescriptor, capabilitiesReport } from "../agent/registry.ts";
import { checkAgentLatestVersions } from "../agent/version.ts";
import type { DesktopContext, DesktopHandlerMap } from "./types.ts";

const RUNTIME_HEALTH_ADDRESS = "127.0.0.1:3080";

export const handlers: DesktopHandlerMap = {
  list_agent_capabilities: () => capabilitiesReport(),
  detect_agent_environment: detectEnvironmentHandler,
  start_agent_runtime: startRuntimeHandler,
  stop_agent_runtime: stopRuntimeHandler,
  check_agent_latest_versions: checkVersionsHandler,
  query_codex_accounts: queryCodexAccountsHandler,
  list_cached_codex_accounts: listCachedCodexAccountsHandler,
  sync_codex_accounts: syncCodexAccountsHandler,
  authorize_codex_account: authorizeCodexAccountHandler,
  query_codex_account: queryCodexAccountHandler,
  delete_codex_account: deleteCodexAccountHandler,
  inspect_agent_global_config: inspectGlobalConfigHandler,
  apply_agent_global_config: applyGlobalConfigHandler,
  restore_agent_global_config: restoreGlobalConfigHandler,
  query_antigravity_accounts: queryAntigravityAccountsHandler,
  authorize_antigravity_account: authorizeAntigravityAccountHandler,
  delete_antigravity_account: deleteAntigravityAccountHandler,
};

// ─── 环境与运行时 ───────────────────────────────────────────────────────────

async function detectEnvironmentHandler(ctx: DesktopContext, args: JsonRow): Promise<unknown> {
  const agentId = argString(args, "agentId");
  const report = await detectAgentEnvironment(agentId);
  await enrichRuntime(ctx, agentId, report);
  return report;
}

async function startRuntimeHandler(ctx: DesktopContext, args: JsonRow): Promise<unknown> {
  const agentId = argString(args, "agentId");
  const report = await detectAgentEnvironment(agentId);
  const status = await runtimeStatus(ctx);
  report.runtime_managed = status.managed;
  report.runtime_command = runtimeCommandFor(report);
  if (report.runtime_running === true) {
    if (status.managed) return report;
    throw new Error(
      "DSH Web 已由 Flowlet 之外的进程启动；为避免终止未知进程，Flowlet 不会接管。请先在原启动位置停止后重试。",
    );
  }
  if (status.managed) throw new Error("DSH Web 正在由 Flowlet 启动，请稍候再试。");

  const started = await ctx.desktop.host.invoke<JsonRow>("agentRuntime.start", {
    agentType: agentId,
  });
  const ready = await detectAgentEnvironment(agentId);
  const after = await runtimeStatus(ctx);
  ready.runtime_managed = after.managed;
  ready.runtime_command = runtimeCommandFor(ready);
  // 宿主报告启动成功但健康检查仍未通过时，以宿主结果为准并保持 managed；否则视为未就绪。
  if (ready.runtime_running !== true && started.running !== true) {
    const command = ready.runtime_command ?? "dsh web --no-open";
    throw new Error(`\`${command}\` 启动后 20 秒内未就绪（${RUNTIME_HEALTH_ADDRESS}）`);
  }
  if (ready.runtime_running !== true) ready.runtime_running = true;
  if (started.running === true) ready.runtime_managed = true;
  return ready;
}

async function stopRuntimeHandler(ctx: DesktopContext, args: JsonRow): Promise<unknown> {
  const agentId = argString(args, "agentId");
  const report = await detectAgentEnvironment(agentId);
  const status = await runtimeStatus(ctx);
  report.runtime_managed = status.managed;
  report.runtime_command = runtimeCommandFor(report);
  if (report.runtime_running === true && !status.managed) {
    throw new Error("DSH Web 不是由当前 Flowlet 启动；为避免终止未知进程，请在原启动位置停止。");
  }
  if (status.managed) {
    await ctx.desktop.host.invoke("agentRuntime.stop", { agentType: agentId });
  }
  const stopped = await detectAgentEnvironment(agentId);
  const after = await runtimeStatus(ctx);
  stopped.runtime_managed = after.managed;
  stopped.runtime_command = runtimeCommandFor(stopped);
  if (stopped.runtime_running === true || after.managed) {
    throw new Error("DSH Web 在 8 秒内未停止");
  }
  return stopped;
}

async function enrichRuntime(
  ctx: DesktopContext,
  agentId: string,
  report: AgentEnvironmentReport,
): Promise<void> {
  const descriptor = agentDescriptor(agentId);
  if (descriptor === undefined || descriptor.environmentAdapterId !== "deepseek-harness") return;
  const status = await runtimeStatus(ctx);
  report.runtime_managed = status.managed;
  const command = runtimeCommandFor(report);
  if (command !== undefined) report.runtime_command = command;
}

async function runtimeStatus(ctx: DesktopContext): Promise<{ running: boolean; managed: boolean }> {
  const status = await ctx.desktop.host.invoke<JsonRow>("agentRuntime.status", {});
  const running = status !== null && typeof status === "object" && status.running === true;
  const managed = running && status.external !== true;
  return { running, managed };
}

// ─── 版本检查 ───────────────────────────────────────────────────────────────

async function checkVersionsHandler(ctx: DesktopContext): Promise<unknown> {
  return await checkAgentLatestVersions({
    enabled: ctx.upstreamProxy.enabled,
    url: ctx.upstreamProxy.url,
  });
}

// ─── Codex 账号 ─────────────────────────────────────────────────────────────

function codexRoot(ctx: DesktopContext): string {
  return codexAccountsDir(ctx.desktop.dataDir);
}

async function queryCodexAccountsHandler(ctx: DesktopContext): Promise<unknown> {
  return await queryCodexAccounts(codexRoot(ctx), {
    enabled: ctx.upstreamProxy.enabled,
    url: ctx.upstreamProxy.url,
  });
}

function listCachedCodexAccountsHandler(ctx: DesktopContext): unknown {
  return listCachedCodexAccounts(codexRoot(ctx));
}

let codexSyncRunning = false;

async function syncCodexAccountsHandler(ctx: DesktopContext, args: JsonRow): Promise<unknown> {
  const triggerSource = argString(args, "triggerSource");
  return await syncCodexAccounts({
    storage: ctx.storage,
    managedRoot: codexRoot(ctx),
    trigger: triggerSource,
    proxy: { enabled: ctx.upstreamProxy.enabled, url: ctx.upstreamProxy.url },
    tryAcquire: () => {
      if (codexSyncRunning) return false;
      codexSyncRunning = true;
      return true;
    },
    release: () => {
      codexSyncRunning = false;
    },
  });
}

async function authorizeCodexAccountHandler(ctx: DesktopContext): Promise<unknown> {
  return await authorizeCodexAccount(
    codexRoot(ctx),
    async (url) => {
      try {
        await ctx.desktop.host.invoke("platform.openExternal", { url });
      } catch (error) {
        throw new Error(
          `无法打开 Codex 账号授权页面：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    { enabled: ctx.upstreamProxy.enabled, url: ctx.upstreamProxy.url },
  );
}

async function queryCodexAccountHandler(ctx: DesktopContext, args: JsonRow): Promise<unknown> {
  const accountId = argString(args, "accountId");
  return await queryCodexAccount(codexRoot(ctx), accountId, {
    enabled: ctx.upstreamProxy.enabled,
    url: ctx.upstreamProxy.url,
  });
}

function deleteCodexAccountHandler(ctx: DesktopContext, args: JsonRow): unknown {
  const accountId = argString(args, "accountId");
  return deleteCodexAccount(codexRoot(ctx), accountId);
}

// ─── Antigravity 账号 ───────────────────────────────────────────────────────

function antigravityRoot(ctx: DesktopContext): string {
  return path.join(ctx.desktop.dataDir, "antigravity-accounts");
}

async function queryAntigravityAccountsHandler(ctx: DesktopContext): Promise<unknown> {
  const root = antigravityRoot(ctx);
  const proxy = { enabled: ctx.upstreamProxy.enabled, url: ctx.upstreamProxy.url };
  const [remoteResult, localResult] = await Promise.allSettled([
    queryAntigravityOauthAccounts(root, proxy),
    queryAntigravityAccounts(),
  ]);
  if (remoteResult.status === "rejected") {
    throw remoteResult.reason instanceof Error
      ? remoteResult.reason
      : new Error(String(remoteResult.reason));
  }
  const report = remoteResult.value;
  if (localResult.status === "rejected") {
    if (report.accounts.length === 0) {
      throw localResult.reason instanceof Error
        ? localResult.reason
        : new Error(String(localResult.reason));
    }
    return report;
  }
  for (const account of localResult.value.accounts) {
    const duplicate = report.accounts.some(
      (saved) =>
        saved.email !== null &&
        account.email !== null &&
        saved.email.toLowerCase() === account.email.toLowerCase(),
    );
    if (!duplicate) report.accounts.push(account);
  }
  return report;
}

async function authorizeAntigravityAccountHandler(ctx: DesktopContext): Promise<unknown> {
  return await authorizeAntigravityAccount({
    root: antigravityRoot(ctx),
    proxy: { enabled: ctx.upstreamProxy.enabled, url: ctx.upstreamProxy.url },
    openUrl: async (url) => {
      try {
        await ctx.desktop.host.invoke("platform.openExternal", { url });
      } catch {
        throw new Error("无法打开 Google 授权页面");
      }
    },
  });
}

async function deleteAntigravityAccountHandler(ctx: DesktopContext, args: JsonRow): Promise<unknown> {
  const accountId = argString(args, "accountId");
  await deleteAntigravityAccount(antigravityRoot(ctx), accountId);
  return null;
}

// ─── Agent 全局配置 ─────────────────────────────────────────────────────────

function expectedBaseUrl(ctx: DesktopContext, agentId: string): string {
  const bind = ctx.proxy.bindConfig();
  return `http://127.0.0.1:${bind.port}${agentEndpointSuffix(agentId)}`;
}

function inspectGlobalConfigHandler(ctx: DesktopContext, args: JsonRow): unknown {
  const agentId = argString(args, "agentId");
  const adapterId = agentGlobalConfigAdapterId(agentId);
  const report = inspectGlobalConfig(adapterId, expectedBaseUrl(ctx, agentId));
  report.agent_id = agentId;
  return report;
}

async function applyGlobalConfigHandler(ctx: DesktopContext, args: JsonRow): Promise<unknown> {
  const agentId = argString(args, "agentId");
  const adapterId = agentGlobalConfigAdapterId(agentId);
  const expected = expectedBaseUrl(ctx, agentId);
  const bind = ctx.proxy.bindConfig();
  const clientToken = bind.default_client_token;
  const options = parseGlobalConfigOptions(args.options);
  const snapshot = ctx.runtimeConfig.snapshot();
  const available = availableAgentModels(snapshot, agentProtocols(adapterId));
  // 默认模型由用户显式选择；未选择时按当前协议可用模型字典序补齐。
  // 非法模型在写文件之前拒绝，避免把不存在的模型写进客户端配置。
  const primaryModel = resolveRequestedModel(options?.primaryModel ?? null, available);
  const fastModel = resolveFastModel(options?.fastModel ?? null, primaryModel);
  const merged: AgentGlobalConfigOptions = {
    ...(options ?? {}),
    primaryModel,
    fastModel,
  };
  const report = applyGlobalConfig({
    adapterId,
    expectedBaseUrl: expected,
    clientToken,
    options: merged,
    modelsCn: readModelsCnSource(ctx.catalogDir),
  });
  report.agent_id = agentId;
  return report;
}

function restoreGlobalConfigHandler(ctx: DesktopContext, args: JsonRow): unknown {
  const agentId = argString(args, "agentId");
  const adapterId = agentGlobalConfigAdapterId(agentId);
  const report = restoreGlobalConfig(adapterId, expectedBaseUrl(ctx, agentId));
  report.agent_id = agentId;
  return report;
}

/** 解析 `AgentGlobalConfigOptions`（camelCase）；未知字段忽略（serde 默认行为）。 */
function parseGlobalConfigOptions(value: unknown): AgentGlobalConfigOptions | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw CommandError.badRequest(
      `参数 options: invalid type: ${describeValue(value)}, expected struct AgentGlobalConfigOptions`,
    );
  }
  const row = value as JsonRow;
  const options: AgentGlobalConfigOptions = {};
  for (const key of ["sessionExtension"] as const) {
    const item = row[key];
    if (item === undefined) continue;
    if (typeof item !== "boolean") {
      throw CommandError.badRequest(
        `参数 options: field \`${key}\`: invalid type: ${describeValue(item)}, expected a boolean`,
      );
    }
    options.sessionExtension = item;
  }
  for (const key of ["primaryModel", "fastModel"] as const) {
    const item = row[key];
    if (item === undefined) continue;
    if (typeof item !== "string") {
      throw CommandError.badRequest(
        `参数 options: field \`${key}\`: invalid type: ${describeValue(item)}, expected a string`,
      );
    }
    options[key] = item;
  }
  const servers = row.mcpServers;
  if (servers !== undefined) {
    if (!Array.isArray(servers)) {
      throw CommandError.badRequest(
        `参数 options: field \`mcpServers\`: invalid type: ${describeValue(servers)}, expected a sequence`,
      );
    }
    options.mcpServers = servers.map((item, index) => parseMcpServerSpec(item, index));
  }
  return options;
}

function parseMcpServerSpec(value: unknown, index: number): McpServerSpecInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw CommandError.badRequest(
      `参数 options: field \`mcpServers[${index}]\`: invalid type: ${describeValue(value)}, expected struct McpServerSpec`,
    );
  }
  const row = value as JsonRow;
  const requiredString = (key: string): string => {
    const item = row[key];
    if (typeof item !== "string") {
      throw CommandError.badRequest(
        `参数 options: field \`mcpServers[${index}].${key}\`: invalid type: ${describeValue(item)}, expected a string`,
      );
    }
    return item;
  };
  const spec: McpServerSpecInput = {
    id: requiredString("id"),
    serverName: requiredString("serverName"),
    transport: requiredString("transport"),
  };
  if (row.command !== undefined) spec.command = requiredString("command");
  if (row.cwd !== undefined) spec.cwd = requiredString("cwd");
  if (row.url !== undefined) spec.url = requiredString("url");
  if (row.args !== undefined) {
    const args = row.args;
    if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
      throw CommandError.badRequest(
        `参数 options: field \`mcpServers[${index}].args\`: invalid type: ${describeValue(args)}, expected a sequence`,
      );
    }
    spec.args = args as string[];
  }
  if (row.env !== undefined) spec.env = parseStringMap(row.env, index, "env");
  if (row.headers !== undefined) spec.headers = parseStringMap(row.headers, index, "headers");
  return spec;
}

function parseStringMap(value: unknown, index: number, key: string): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw CommandError.badRequest(
      `参数 options: field \`mcpServers[${index}].${key}\`: invalid type: ${describeValue(value)}, expected a map`,
    );
  }
  const result: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value as JsonRow)) {
    if (typeof entryValue !== "string") {
      throw CommandError.badRequest(
        `参数 options: field \`mcpServers[${index}].${key}.${entryKey}\`: invalid type: ${describeValue(entryValue)}, expected a string`,
      );
    }
    result[entryKey] = entryValue;
  }
  return result;
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "number") {
    return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  }
  if (typeof value === "boolean") return `boolean \`${value}\``;
  return Array.isArray(value) ? "sequence" : "map";
}
