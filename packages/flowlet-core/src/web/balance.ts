// Web 命令 query_balance 的实现。Owner: node-web.
//
// 权威实现：src-tauri/src/core/account_balance.rs（公共编排 + 落库）与
// channel_capability_adapter/adapters/{deepseek,kimi,openrouter,vibetoken}.rs
// （各渠道官方余额接口的请求与响应解析）。官方余额接口需要网络；对拍脚本会跳过该命令
// 并在报告注明（不允许用真实 Key 打生产上游）。
import { randomUUID } from "node:crypto";

import type { JsonRow } from "../types.ts";
import { CommandError } from "../types.ts";
import type { WebContext } from "./context.ts";
import { effectiveOpenaiBaseUrl, presetSupportsBalance } from "./config-state.ts";
import { findAccount, getUpstream, requestErrorDetail } from "./upstream.ts";

export interface BalanceQueryResult {
  balance: number | null;
  currency: string | null;
  is_available: boolean;
  error: string | null;
}

interface BalanceStorage {
  saveBalanceSnapshot(snapshot: JsonRow): void;
  markAccountCredentialHealthy?(accountId: string): void;
  markAccountCredentialInvalid?(accountId: string): void;
  updateAccountLastError?(accountId: string, error: string | null): void;
  updateAccountLastUsed?(accountId: string): void;
}

function balanceError(error: string): BalanceQueryResult {
  return { balance: null, currency: null, is_available: false, error };
}

function presetOf(ctx: WebContext, channelId: string): JsonRow | null {
  const channels = ctx.channelsConfig.channels;
  if (!Array.isArray(channels)) return null;
  return (channels as JsonRow[]).find((preset) => preset?.id === channelId) ?? null;
}

function presetBaseUrl(ctx: WebContext, channelId: string): string {
  const preset = presetOf(ctx, channelId);
  const base = preset?.openai_base_url;
  return typeof base === "string" ? base : "";
}

/** Rust `ChannelsConfig::endpoint_or`：endpoints[channel][kind] 覆盖优先。 */
function endpointOr(ctx: WebContext, channelId: string, kind: string, fallback: () => string): string {
  const endpoints = ctx.channelsConfig.endpoints;
  if (endpoints !== null && typeof endpoints === "object" && !Array.isArray(endpoints)) {
    const overrides = (endpoints as JsonRow)[channelId];
    if (overrides !== null && typeof overrides === "object" && !Array.isArray(overrides)) {
      const url = (overrides as JsonRow)[kind];
      if (typeof url === "string") return url;
    }
  }
  return fallback();
}

function balanceEndpoint(ctx: WebContext, channelId: string): string {
  switch (channelId) {
    case "deepseek":
      return endpointOr(ctx, channelId, "balance", () => `${presetBaseUrl(ctx, channelId)}/user/balance`);
    case "kimi":
      return endpointOr(ctx, channelId, "balance", () => `${presetBaseUrl(ctx, channelId)}/users/me/balance`);
    case "openrouter":
      return endpointOr(ctx, channelId, "balance", () => `${presetBaseUrl(ctx, channelId).replace(/\/+$/, "")}/key`);
    case "vibetoken": {
      const base = presetBaseUrl(ctx, channelId).replace(/\/+$/, "").replace(/\/v1$/, "");
      return endpointOr(ctx, channelId, "balance", () => `${base}/api/v1/billing/balance`);
    }
    default:
      return "";
  }
}

function creditsEndpoint(ctx: WebContext): string {
  return endpointOr(ctx, "openrouter", "credits", () => `${presetBaseUrl(ctx, "openrouter").replace(/\/+$/, "")}/credits`);
}

/** 只在 Adapter 提供官方余额实现的渠道（Rust `supports_official_balance`）。 */
const OFFICIAL_BALANCE_CHANNELS = new Set(["deepseek", "kimi", "openrouter", "vibetoken"]);

export async function queryBalance(ctx: WebContext, accountId: string): Promise<BalanceQueryResult> {
  const snapshot = ctx.runtimeConfig.snapshot();
  const account = findAccount(snapshot, accountId);
  if (account === null) throw CommandError.badRequest("账号不存在");
  const channelId = String(account.channel_id ?? "");

  if (!presetSupportsBalance(snapshot, channelId) || !OFFICIAL_BALANCE_CHANNELS.has(channelId)) {
    return balanceError("当前渠道不支持官方余额查询");
  }
  if (effectiveOpenaiBaseUrl(account) !== null) {
    return balanceError("自定义 OpenAI Base URL 不支持官方余额自动同步");
  }

  const isOpenRouter = channelId === "openrouter";
  const rawManagementKey = account.management_key;
  const managementKey =
    isOpenRouter && typeof rawManagementKey === "string" && rawManagementKey.trim() !== ""
      ? rawManagementKey.trim()
      : null;
  const usesManagementKey = managementKey !== null;

  let result: BalanceQueryResult;
  try {
    result = await requestBalance(ctx, account, channelId, managementKey);
  } catch (error) {
    result = balanceError(`请求失败: ${requestErrorDetail(error)}`);
  }

  const storage = ctx.storage as unknown as BalanceStorage;
  if (result.error === null) {
    if (!usesManagementKey) storage.markAccountCredentialHealthy?.(accountId);
    ctx.runtimeConfig.update((draft) => {
      const accounts = draft.accounts;
      if (!Array.isArray(accounts)) return;
      const shared = (accounts as JsonRow[]).find((item) => item?.id === accountId);
      if (!shared) return;
      if (!usesManagementKey) shared.credential_status = "healthy";
      shared.last_error = null;
    });
    const now = new Date().toISOString();
    const snapshotRow: JsonRow = {
      id: `balance-${accountId}-${randomUUID()}`,
      account_id: accountId,
      balance: result.balance,
      currency: result.currency,
      token_pack_total: null,
      token_pack_used: null,
      token_pack_remaining: null,
      token_pack_expire_at: null,
      token_packs: null,
      raw_scraped_json: null,
      source: "sync",
      synced_at: now,
      remark: usesManagementKey
        ? "OpenRouter Management Key 账户 Credits 同步"
        : isOpenRouter
          ? "OpenRouter API Key 限额同步"
          : "官方余额接口同步",
      created_at: now,
      updated_at: now,
    };
    storage.saveBalanceSnapshot(snapshotRow);
    storage.updateAccountLastUsed?.(accountId);
  } else {
    const errorText = result.error;
    storage.updateAccountLastError?.(accountId, errorText);
    if (!usesManagementKey && (errorText.includes("HTTP 401") || errorText.includes("401"))) {
      storage.markAccountCredentialInvalid?.(accountId);
      ctx.runtimeConfig.update((draft) => {
        const accounts = draft.accounts;
        if (!Array.isArray(accounts)) return;
        const shared = (accounts as JsonRow[]).find((item) => item?.id === accountId);
        if (!shared) return;
        shared.credential_status = "invalid_key";
        shared.last_error = errorText;
      });
    }
  }
  return result;
}

async function requestBalance(
  ctx: WebContext,
  account: JsonRow,
  channelId: string,
  managementKey: string | null,
): Promise<BalanceQueryResult> {
  const apiKey = String(account.api_key ?? "").trim();
  if (apiKey === "") return balanceError("API Key 未配置");

  const usesManagementKey = managementKey !== null;
  const endpoint = usesManagementKey ? creditsEndpoint(ctx) : balanceEndpoint(ctx, channelId);
  const credential = usesManagementKey ? managementKey : apiKey;
  const response = await getUpstream(endpoint, {
    headers: { authorization: `Bearer ${credential}` },
    timeoutMs: 15_000,
    proxy: ctx.upstreamProxy,
    useUpstreamProxy: account.use_upstream_proxy as boolean | null,
    channelId,
  });

  const status = response.status;
  const body = response.body;
  if (status < 200 || status >= 300) {
    if (channelId === "openrouter") {
      const credentialName = usesManagementKey ? "Management Key" : "API Key";
      return balanceError(`${credentialName} 查询失败，HTTP ${status}: ${body}`);
    }
    return balanceError(`HTTP ${status}: ${body}`);
  }
  try {
    return parseBalance(channelId, body, usesManagementKey);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return balanceError(`解析响应失败: ${detail}`);
  }
}

function parseBalance(channelId: string, body: string, usesManagementKey: boolean): BalanceQueryResult {
  const json = JSON.parse(body) as JsonRow;
  switch (channelId) {
    case "deepseek": {
      const isAvailable = json.is_available === true;
      const infos = Array.isArray(json.balance_infos) ? (json.balance_infos as JsonRow[]) : [];
      const primary =
        infos.find((info) => info?.currency === "CNY") ?? (infos.length > 0 ? infos[0] : null);
      if (primary === null) {
        return { balance: null, currency: null, is_available: isAvailable, error: "未找到余额信息" };
      }
      const total = typeof primary.total_balance === "string" ? Number(primary.total_balance) : NaN;
      return {
        balance: Number.isFinite(total) ? total : null,
        currency: typeof primary.currency === "string" ? primary.currency : null,
        is_available: isAvailable,
        error: null,
      };
    }
    case "kimi": {
      const data = json.data;
      const code = typeof json.code === "number" ? json.code : 0;
      if (code !== 0) return balanceError(`余额查询失败，服务器返回 code=${code}`);
      const balance =
        data !== null && typeof data === "object" && typeof (data as JsonRow).available_balance === "number"
          ? ((data as JsonRow).available_balance as number)
          : null;
      return { balance, currency: "CNY", is_available: true, error: null };
    }
    case "vibetoken": {
      const available = typeof json.available === "number" ? json.available : NaN;
      return {
        balance: Number.isFinite(available) ? available : null,
        currency: typeof json.currency === "string" ? json.currency : null,
        is_available: Number.isFinite(available) && available > 0,
        error: null,
      };
    }
    case "openrouter": {
      const data = json.data;
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        return balanceError(
          usesManagementKey ? "未找到 OpenRouter 账户 Credits 信息" : "未找到 Key 状态信息",
        );
      }
      const row = data as JsonRow;
      if (usesManagementKey) {
        const totalCredits = typeof row.total_credits === "number" ? row.total_credits : NaN;
        const totalUsage = typeof row.total_usage === "number" ? row.total_usage : NaN;
        const balance = Number.isFinite(totalCredits) && Number.isFinite(totalUsage) ? totalCredits - totalUsage : null;
        return { balance, currency: "USD", is_available: true, error: null };
      }
      const limitRemaining = typeof row.limit_remaining === "number" ? row.limit_remaining : null;
      return { balance: limitRemaining, currency: "USD", is_available: true, error: null };
    }
    default:
      return balanceError("当前渠道不支持官方余额查询");
  }
}