import { invokeCommand, toAppError } from "../../platform/tauri/client";

export type AntigravityQuota = {
  id: string;
  label: string;
  remaining_fraction: number | null;
  reset_at: string | null;
  description: string | null;
  disabled: boolean;
};

export type AntigravityAccountReport = {
  account_id: string;
  source: "local" | "oauth";
  stale: boolean;
  reauthorization_required: boolean;
  email: string | null;
  plan: string | null;
  quotas: AntigravityQuota[];
  quota_source: "summary" | "models" | null;
  updated_at: string;
  error: string | null;
};

export type AntigravityAccountsReport = { accounts: AntigravityAccountReport[] };

export function queryAntigravityAccounts(): Promise<AntigravityAccountsReport> {
  return invokeCommand<AntigravityAccountsReport>("query_antigravity_accounts", undefined, 120_000)
    .catch((error) => { throw toAppError(error, "antigravity_account_query_failed"); });
}

export function authorizeAntigravityAccount(): Promise<AntigravityAccountReport> {
  return invokeCommand<AntigravityAccountReport>("authorize_antigravity_account", undefined, 6 * 60_000)
    .catch((error) => { throw toAppError(error, "antigravity_authorization_failed"); });
}

export function deleteAntigravityAccount(accountId: string): Promise<void> {
  return invokeCommand<void>("delete_antigravity_account", { accountId }, 120_000)
    .catch((error) => { throw toAppError(error, "antigravity_deletion_failed"); });
}
