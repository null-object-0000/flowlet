/** Channel-domain types (ChannelPreset template). No UI / React imports. */

/** 客户端协议。`responses`（OpenAI Responses API）复用渠道的 OpenAI Base URL
 *  与鉴权，仅路由归属独立；当前仅无状态透传（POST /v1/responses）。 */
export type ProtocolType = "openai" | "anthropic" | "responses";

export type AuthStrategy = "bearer" | "x_api_key";

export const CUSTOM_CHANNEL_ID = "custom";

/** ChatGPT (Codex) 伪装渠道 ID。Codex 账号由 Rust 端自动发现和同步，
 *  不需要用户手动创建。前端在概览页渠道账号卡片中作为只读伪账号行呈现
 *  （行点击打开只读详情抽屉），不参与路由，不在账号管理弹窗中出现。 */
export const CHATGPT_CHANNEL_ID = "chatgpt";

/** ChatGPT 伪渠道预设（仅前端新增账号抽屉用）。Codex 账号不是表单创建的，
 *  而是通过浏览器 OAuth 授权（authorize_codex_account）新增；该预设只提供
 *  「新增 ChatGPT」的入口与授权面板渲染，不进入 config.json / channels_config.rs，
 *  不参与路由。 */
export const CHATGPT_PSEUDO_PRESET: ChannelPreset = {
  id: CHATGPT_CHANNEL_ID,
  name: "ChatGPT",
  vendor: "openai",
  supported_protocols: [],
  openai_base_url: "",
  anthropic_base_url: "",
  openai_auth: "bearer",
  anthropic_auth: "bearer",
  default_model: "",
  small_model: null,
  platform_url: null,
  supports_model_list: false,
  supports_model_detail: false,
  supports_balance_query: false,
  supports_quota_query: false,
  supports_usage_query: false,
  supports_scrape_balance: false,
  created_at: "",
  updated_at: "",
};

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
 *  config.json channels_config.default_exposed_models。
 *  仅用于渠道预设的配置漂移检测（preset-sync），不再作为开放模型的白名单。
 *  白名单请使用 FLOWLET_SUPPORTED_MODELS（所有渠道的并集）。 */
export const DEFAULT_EXPOSED_MODELS_BY_CHANNEL: Record<string, string[]> = {
  longcat: ["LongCat-2.0"],
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
  kimi: ["kimi-k3", "kimi-k2.7-code"],
  qwen: ["qwen3.7-max", "qwen3.7-plus", "qwen3.7-flash", "qwen3.6-plus", "qwen3.6-flash"],
};

/** Token Plan 个人版账号的默认开放模型（qwen3.8-max-preview 仅 Token Plan 可用）。
 *  按量付费账号使用 DEFAULT_EXPOSED_MODELS_BY_CHANNEL.qwen。
 *  必须与 src-tauri/src/core/channels_config.rs 的
 *  QWEN_TOKEN_PLAN_DEFAULT_MODELS 保持一致。 */
export const QWEN_TOKEN_PLAN_DEFAULT_MODELS = ["qwen3.8-max-preview", "qwen3.6-flash"];

/** Flowlet 支持开放的上游模型全集（所有渠道的并集）。
 *  任意渠道账号只要底层 /models 返回了其中的模型，就可勾选开放——不再按渠道区分。
 *  必须与 src-tauri/src/core/channels_config.rs 的 supported_models() 保持一致。 */
export const FLOWLET_SUPPORTED_MODELS: string[] = Array.from(new Set([
  ...Object.values(DEFAULT_EXPOSED_MODELS_BY_CHANNEL).flat(),
  ...QWEN_TOKEN_PLAN_DEFAULT_MODELS,
]));

/** 上游模型变体 → 白名单规范模型 ID 的映射（键值均按小写匹配）。
 *  部分渠道端点的 /models 会返回与规范名不同、但实际是同一模型的日期快照或别名
 *  （如千问 Token Plan 套餐端点的 deepseek-v4-flash-0731 即 deepseek-v4-flash）。
 *  变体按规范 ID 参与白名单求交、编辑器勾选、用量合并与品牌/档位/价格解析；
 *  生成路由时 virtual_model_id 用规范 ID，upstream_model 保留 /models 返回的
 *  上游原名，转发时按上游实际支持的名字发起请求。
 *  必须与 src-tauri/src/core/channels_config.rs 的 MODEL_ALIASES 保持一致。 */
export const MODEL_ALIASES: Record<string, string> = {
  "deepseek-v4-flash-0731": "deepseek-v4-flash",
};

export function defaultExposedModels(channel: ChannelPreset): string[] {
  return DEFAULT_EXPOSED_MODELS_BY_CHANNEL[channel.id] ?? [channel.default_model].filter(Boolean);
}

export function isCustomChannel(channel: Pick<ChannelPreset, "id" | "vendor"> | undefined): boolean {
  return channel?.id === CUSTOM_CHANNEL_ID || channel?.vendor === "custom";
}

// ─── Qwen Token Plan ─────────────────────────────────────────────────────────
// 千问 AI 平台的一种账号资源模式：订阅制（Credits 计量），API Key 为 sk-sp- 前缀，
// 与按量付费（sk- 前缀）端点完全隔离。账号选择 token_plan 模式时，编辑器会把
// 以下专属 Base URL 写入账号级覆盖；团队版若控制台展示套餐专属地址，
// 用户可在高级设置中手动修改覆盖值。
// 官方文档: https://platform.qianwenai.com/docs/token-plan/overview
export const QWEN_CHANNEL_ID = "qwen";
export const QWEN_TOKEN_PLAN_OPENAI_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
export const QWEN_TOKEN_PLAN_ANTHROPIC_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic";

/** 模型身份与实际承载请求的渠道相互独立。
 *  自定义渠道只提供路由，不改变模型品牌、官方规格或基准价格归属。 */
const OFFICIAL_CHANNEL_BY_MODEL = new Map<string, string>([
  ...Object.entries(DEFAULT_EXPOSED_MODELS_BY_CHANNEL).flatMap(([channelId, models]) =>
    models.map((model) => [model.trim().toLowerCase(), channelId] as const)),
  ...QWEN_TOKEN_PLAN_DEFAULT_MODELS.map((model) =>
    [model.trim().toLowerCase(), QWEN_CHANNEL_ID] as const),
]);

const CANONICAL_MODEL_BY_ID = new Map<string, string>(
  FLOWLET_SUPPORTED_MODELS.map((model) => [model.trim().toLowerCase(), model]),
);

const ALIAS_TARGET_BY_ID = new Map<string, string>(
  Object.entries(MODEL_ALIASES).map(([alias, canonical]) => [
    alias.trim().toLowerCase(),
    canonical.trim().toLowerCase(),
  ]),
);

/** 把任意模型名解析为规范键（小写）：命中别名表返回映射目标，否则原样小写。
 *  规范键可直接与 FLOWLET_SUPPORTED_MODELS 的小写形式比较。 */
export function canonicalModelKey(modelId: string | null | undefined): string {
  const key = (modelId ?? "").trim().toLowerCase();
  return ALIAS_TARGET_BY_ID.get(key) ?? key;
}

export function officialChannelIdForModel(modelId: string | null | undefined): string | null {
  if (!modelId?.trim()) return null;
  return OFFICIAL_CHANNEL_BY_MODEL.get(canonicalModelKey(modelId)) ?? null;
}

export function canonicalModelId(modelId: string | null | undefined): string | null {
  if (!modelId?.trim()) return null;
  return CANONICAL_MODEL_BY_ID.get(canonicalModelKey(modelId)) ?? null;
}

/** 在账号最近一次 /models 结果（synced_models）中，为规范模型挑选实际转发用的
 *  上游模型名：/models 精确返回了同名模型（大小写不敏感）时返回白名单规范名
 *  （保持历史路由签名稳定），否则取第一个映射到该规范的变体条目并保留上游原名
 *  （保持 /models 返回顺序）。找不到返回 null。 */
export function pickUpstreamModelForCanonical(
  canonicalId: string,
  syncedModels: readonly string[] | null | undefined,
): string | null {
  const key = canonicalId.trim().toLowerCase();
  const synced = (syncedModels ?? []).map((model) => model.trim()).filter(Boolean);
  if (synced.some((model) => model.toLowerCase() === key)) return canonicalId.trim();
  return synced.find((model) => canonicalModelKey(model) === key) ?? null;
}

/** 判断账号是否为千问 Token Plan 模式。 */
export function isQwenTokenPlanAccount(account: { channel_id: string; resource_mode: string | null }): boolean {
  return account.channel_id === QWEN_CHANNEL_ID && account.resource_mode === "token_plan";
}

/** 判断是否为 ChatGPT (Codex) 伪账号。Codex 账号由 Rust 端同步，
 *  前端不可编辑、不参与路由，仅在概览页底部作为非交互展示项。 */
export function isChatGptAccount(account: { channel_id: string; resource_mode: string | null }): boolean {
  return account.channel_id === CHATGPT_CHANNEL_ID && account.resource_mode === "codex";
}
