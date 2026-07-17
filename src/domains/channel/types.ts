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
  created_at: string;
  updated_at: string;
};

/** Per-channel default exposed upstream models. Must stay in sync with
 *  config.json channels_config.default_exposed_models. */
export const DEFAULT_EXPOSED_MODELS_BY_CHANNEL: Record<string, string[]> = {
  longcat: ["LongCat-2.0"],
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
  kimi: ["kimi-k3", "kimi-k2.7-code"],
};

/** Per-channel Flowlet aggregate tier mapping. Must stay in sync with
 *  config.json channels_config.flowlet_tiers. */
export const FLOWLET_TIER_BY_CHANNEL_MODEL: Record<string, Record<string, "pro" | "flash">> = {
  longcat: {
    "longcat-2.0": "pro",
  },
  deepseek: {
    "deepseek-v4-pro": "pro",
    "deepseek-v4-flash": "flash",
  },
  kimi: {
    "kimi-k3": "pro",
    "kimi-k2.7-code": "pro",
  },
};

export function defaultExposedModels(channel: ChannelPreset): string[] {
  return DEFAULT_EXPOSED_MODELS_BY_CHANNEL[channel.id] ?? [channel.default_model].filter(Boolean);
}
