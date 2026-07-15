/** Account-domain types. No UI / React imports. */

export type AccountCredentialStatus = "healthy" | "invalid_key";

export type AccountResourceMode = "token_pack" | "pay_as_you_go";

export type ChannelAccount = {
  id: string;
  channel_id: string;
  name: string;
  api_key: string;
  enabled: boolean;
  priority: number;
  remark: string | null;
  resource_mode: AccountResourceMode | null;
  base_url_override: string | null;
  last_used_at: string | null;
  last_error: string | null;
  credential_status: AccountCredentialStatus;
  created_at: string;
  updated_at: string;
};

export type AccountConnectionOk = { ok: true };
export type AccountBalanceResult = {
  balance: number | null;
  currency: string | null;
  is_available: boolean;
  error: string | null;
};

export type ModelSyncResult = {
  models_synced: number;
  models: { model: string; display_name?: string | null }[];
  errors: string[];
};

/** Initial blank account draft for the create form. The id is assigned here
 *  but Rust side normalizes the list on save. */
export function newAccount(channelId: string, index: number): ChannelAccount {
  return {
    id: `account-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channel_id: channelId,
    name: `账号 ${index + 1}`,
    api_key: "",
    enabled: true,
    priority: index,
    remark: "",
    resource_mode: null,
    base_url_override: null,
    last_used_at: null,
    last_error: null,
    credential_status: "healthy",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
