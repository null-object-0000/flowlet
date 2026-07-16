import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AppError } from "../../shared/errors/AppError";
import type { AccountBalanceResult, AccountBalanceSnapshot, ChannelAccount, ModelSyncResult } from "./types";

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
};

function toAppErr(code: string) {
  return (err: unknown) => {
    throw toAppError(err, code);
  };
}

export type { AppError };
