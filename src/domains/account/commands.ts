import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AppError } from "../../shared/errors/AppError";
import type { AccountBalanceResult, AccountBalanceSnapshot, ChannelAccount, ModelSyncResult } from "./types";

const SCRAPE_LOGIN_TIMEOUT_MS = 45_000;
const SCRAPE_BALANCE_TIMEOUT_MS = 60_000;

/** Account command adapter. Pages/features call these; never spell
 *  "save_channel_accounts" / "test_connection" / "sync_models" / "query_balance"
 *  directly. */

export const accountCommands = {
  list: (): Promise<ChannelAccount[]> =>
    invokeCommand<ChannelAccount[]>("list_channel_accounts").catch(
      toAppErr("account_list_failed"),
    ),

  /** Persist the full account list. Returns the normalized list (credential
   *  status reset on API-key change) — the caller MUST use this as the new
   *  source of truth instead of its input draft. */
  saveAll: (accounts: ChannelAccount[]): Promise<ChannelAccount[]> =>
    invokeCommand<ChannelAccount[]>("save_channel_accounts", { accounts }).catch(
      toAppErr("account_save_failed"),
    ),

  testConnection: (input: {
    channel_id: string;
    api_key: string;
    base_url_override?: string | null;
  }): Promise<void> =>
    invokeCommand<void>("test_connection", {
      channelId: input.channel_id,
      apiKey: input.api_key,
      baseUrlOverride: input.base_url_override ?? null,
    }).catch(toAppErr("account_test_failed")),

  syncModels: (accountId: string): Promise<ModelSyncResult> =>
    invokeCommand<{ models_synced: number; models: { model: string; display_name?: string | null }[]; errors: string[] }>(
      "sync_models",
      { accountId },
    )
      .then((r) => ({ models_synced: r.models_synced, models: r.models, errors: r.errors }))
      .catch(toAppErr("account_sync_failed")),

  queryBalance: (accountId: string): Promise<AccountBalanceResult> =>
    invokeCommand<AccountBalanceResult>("query_balance", { accountId }).catch(
      toAppErr("account_balance_failed"),
    ),

  saveBalanceSnapshot: (snapshot: AccountBalanceSnapshot): Promise<void> =>
    invokeCommand<void>("save_balance_snapshot", { snapshot }).catch(
      toAppErr("account_balance_save_failed"),
    ),

  latestBalanceSnapshots: (): Promise<AccountBalanceSnapshot[]> =>
    invokeCommand<AccountBalanceSnapshot[]>("latest_balance_snapshots").catch(
      toAppErr("account_balance_list_failed"),
    ),

  // —— 控制台抓取 ——
  /** 抓取结果(前端展示用)。 */
  openScrapeConsole: (accountId: string): Promise<void> =>
    invokeCommand<void>("open_scrape_console", { accountId }).catch(
      toAppErr("account_scrape_failed"),
    ),
  closeScrapeConsole: (accountId: string): Promise<void> =>
    invokeCommand<void>("close_scrape_console", { accountId }).catch(
      toAppErr("account_scrape_failed"),
    ),
  /** 刷新控制台并等待页面业务响应。需要登录或页面未触发目标接口时 Rust 会展示 webview。 */
  probeScrapeLogin: (accountId: string, interactive = true): Promise<ScrapeLoginStatus> =>
    invokeCommand<ScrapeLoginStatus>("probe_scrape_login", { accountId, interactive }, SCRAPE_LOGIN_TIMEOUT_MS).catch(
      toAppErr("account_scrape_failed"),
    ),
  scrapeBalance: (accountId: string, interactive = true): Promise<ScrapeBalanceResult> =>
    invokeCommand<ScrapeBalanceResult>("scrape_balance", { accountId, interactive }, SCRAPE_BALANCE_TIMEOUT_MS).catch(
      toAppErr("account_scrape_failed"),
    ),
  syncScrapeBalances: (triggerSource: string): Promise<ScrapeBalanceSyncResult> =>
    invokeCommand<ScrapeBalanceSyncResult>("sync_scrape_balances", { triggerSource }, 10 * 60_000).catch(
      toAppErr("account_scrape_sync_failed"),
    ),
};

/** 控制台抓取结果类型(与 Rust ScrapeBalanceResult 对应)。 */
export type ScrapeBalanceResult = {
  balance: number | null;
  currency: string | null;
  plan_name: string | null;
  token_total: number | null;
  token_used: number | null;
  token_remaining: number | null;
  token_pack_expire_at: string | null;
  token_packs: string | null;
  raw_scraped_json: string | null;
  source: string;
  synced_at: string;
};

/** 登录态探测结果(与 Rust ScrapeLoginStatus 对应)。 */
export type ScrapeLoginStatus = {
  is_logged_in: boolean;
  channel_id: string;
  account_hint: string | null;
  probe_state: "captured" | "login_required" | "console_action_required" | "capture_timeout";
  message: string | null;
};

export type ScrapeBalanceSyncResult = {
  started: boolean;
  jobId: string | null;
  accounts: number;
  synced: number;
  failed: number;
  message: string;
};

function toAppErr(code: string) {
  return (err: unknown) => {
    throw toAppError(err, code);
  };
}

export type { AppError };
