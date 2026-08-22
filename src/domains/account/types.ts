/** Account-domain types. No UI / React imports. */

export type AccountCredentialStatus = "healthy" | "invalid_key";

export type AccountResourceMode = "token_pack" | "pay_as_you_go" | "token_plan" | "hybrid" | "codex";
export type AccountResourceSyncMode = "manual" | "auto";

export type ChannelAccount = {
  id: string;
  /** 同一 S3 工作区内稳定的账号身份；本地路由仍引用 id。 */
  workspace_account_id: string | null;
  channel_id: string;
  name: string;
  api_key: string;
  /** OpenRouter Management Key，仅用于读取账户 Credits，不参与模型请求或路由。 */
  management_key?: string | null;
  enabled: boolean;
  priority: number;
  remark: string | null;
  resource_mode: AccountResourceMode | null;
  resource_sync_mode: AccountResourceSyncMode;
  base_url_override: string | null;
  anthropic_base_url_override: string | null;
  /** 工作区共享默认地址；本设备 override 的优先级更高。 */
  workspace_default_base_url: string | null;
  workspace_default_anthropic_base_url: string | null;
  last_used_at: string | null;
  last_error: string | null;
  credential_status: AccountCredentialStatus;
  /** 最近一次 /models 拉取得到的该账号上游模型 ID 列表（候选池）。仅用于编辑器预填
   *  候选，null 表示尚未拉取。 */
  synced_models: string[] | null;
  /** 最近一次 /models 拉取成功的时间（ISO），与 synced_models 配套。 */
  models_synced_at: string | null;
  /** 用户显式勾选要开放的上游原始模型 ID 列表（按规范模型映射受全局白名单约束）。
   *  同一规范模型的多个上游 ID 可同时存在，分别生成 Route Candidate。
   *  null = 尚未用新流程配置（路由保持现状）；数组（可为空）= 按此列表严格对账路由。 */
  exposed_models: string[] | null;
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

export type AccountBalanceSnapshot = {
  id: string;
  account_id: string;
  balance: number | null;
  currency: string | null;
  token_pack_total: number | null;
  token_pack_used: number | null;
  token_pack_remaining: number | null;
  token_pack_expire_at: string | null;
  token_packs?: string | null;
  raw_scraped_json?: string | null;
  source: string;
  synced_at: string | null;
  remark: string | null;
  created_at: string;
  updated_at: string;
};

export type ModelSyncResult = {
  models_synced: number;
  models: {
    model: string;
    display_name?: string | null;
    created_at?: string | null;
    /** 上游 /models 返回的原始价格对象；OpenRouter 用它标识免费模型。 */
    pricing?: Record<string, unknown> | Array<Record<string, unknown>> | null;
  }[];
  errors: string[];
};

export function effectiveOpenAiBaseUrl(account: ChannelAccount): string | null {
  return account.base_url_override?.trim()
    || account.workspace_default_base_url?.trim()
    || null;
}

export function effectiveAnthropicBaseUrl(account: ChannelAccount): string | null {
  return account.anthropic_base_url_override?.trim()
    || account.workspace_default_anthropic_base_url?.trim()
    || null;
}

/** Initial blank account draft for the create form. The id is assigned here
 *  but Rust side normalizes the list on save. */
export function newAccount(channelId: string, index: number): ChannelAccount {
  return {
    id: `account-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    workspace_account_id: null,
    channel_id: channelId,
    name: `账号 ${index + 1}`,
    api_key: "",
    management_key: null,
    enabled: true,
    priority: index,
    remark: "",
    resource_mode: null,
    resource_sync_mode: "manual",
    base_url_override: null,
    anthropic_base_url_override: null,
    workspace_default_base_url: null,
    workspace_default_anthropic_base_url: null,
    last_used_at: null,
    last_error: null,
    credential_status: "healthy",
    synced_models: null,
    models_synced_at: null,
    exposed_models: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
