/** Channel-domain types (ChannelPreset template). No UI / React imports. */

export type ProtocolType = "openai" | "anthropic";

export type AuthStrategy = "bearer" | "x_api_key";

export type ChannelPreset = {
  id: string;
  name: string;
  vendor: string;
  supported_protocols: ProtocolType[];
  openai_base_url: string;
  anthropic_base_url: string;
  openai_auth: AuthStrategy;
  anthropic_auth: AuthStrategy;
  default_model: string;
  small_model: string | null;
  /** Optional platform console URL for obtaining an API key. */
  platform_url: string | null;
  supports_model_list: boolean;
  supports_model_detail: boolean;
  supports_balance_query: boolean;
  supports_quota_query: boolean;
  supports_usage_query: boolean;
  supports_scrape_balance: boolean;
  created_at: string;
  updated_at: string;
};

/** Per-channel default exposed upstream models. Must stay in sync with
 *  config.json channels_config.default_exposed_models. */
export const DEFAULT_EXPOSED_MODELS_BY_CHANNEL: Record<string, string[]> = {
  longcat: ["LongCat-2.0"],
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
  kimi: ["kimi-k3", "kimi-k2.7-code"],
  qwen: ["qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash"],
};

/** Per-channel Flowlet aggregate tier mapping. Must stay in sync with
 *  config.json channels_config.flowlet_tiers. */
export const FLOWLET_TIERS_BY_CHANNEL_MODEL: Record<string, Record<string, Array<"pro" | "flash">>> = {
  longcat: {
    "longcat-2.0": ["pro", "flash"],
  },
  deepseek: {
    "deepseek-v4-pro": ["pro"],
    "deepseek-v4-flash": ["flash"],
  },
  kimi: {
    "kimi-k3": ["pro"],
    "kimi-k2.7-code": ["pro"],
  },
  qwen: {
    "qwen3.8-max-preview": ["pro"],
    "qwen3.7-plus": ["pro"],
    "qwen3.7-max": ["pro"],
    "qwen3.6-plus": ["pro"],
    "qwen3.6-flash": ["flash"],
  },
};

export function defaultExposedModels(channel: ChannelPreset): string[] {
  return DEFAULT_EXPOSED_MODELS_BY_CHANNEL[channel.id] ?? [channel.default_model].filter(Boolean);
}

// ─── 千问 Qwen Token Plan ────────────────────────────────────────────────────
// 千问 AI 平台的一种账号资源模式：订阅制（Credits 计量），API Key 为 sk-sp- 前缀，
// 与按量付费（sk- 前缀）端点完全隔离。账号选择 token_plan 模式时，编辑器会把
// 以下专属 Base URL 写入账号级覆盖；团队版若控制台展示套餐专属地址，
// 用户可在高级设置中手动修改覆盖值。
// 官方文档: https://platform.qianwenai.com/docs/token-plan/overview
export const QWEN_CHANNEL_ID = "qwen";
export const QWEN_TOKEN_PLAN_OPENAI_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
export const QWEN_TOKEN_PLAN_ANTHROPIC_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic";
export const QWEN_TOKEN_PLAN_CONSOLE_URL = "https://platform.qianwenai.com/home/billing/subscription/token-plan-individual";

/** Token Plan 个人版账号的默认开放模型（qwen3.8-max-preview 仅 Token Plan 可用）。
 *  按量付费账号使用 DEFAULT_EXPOSED_MODELS_BY_CHANNEL.qwen。
 *  必须与 src-tauri/src/core/channels_config.rs 的
 *  QWEN_TOKEN_PLAN_DEFAULT_MODELS 保持一致。 */
export const QWEN_TOKEN_PLAN_DEFAULT_MODELS = ["qwen3.8-max-preview", "qwen3.6-flash"];

/** 判断账号是否为千问 Token Plan 模式。 */
export function isQwenTokenPlanAccount(account: { channel_id: string; resource_mode: string | null }): boolean {
  return account.channel_id === QWEN_CHANNEL_ID && account.resource_mode === "token_plan";
}
