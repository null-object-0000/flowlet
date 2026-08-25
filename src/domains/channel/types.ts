/** Channel-domain types (ChannelPreset template). No UI / React imports. */

import {
  DEFAULT_EXPOSED_MODELS_BY_CHANNEL,
  FLOWLET_SUPPORTED_MODELS,
  canonicalModelId,
  canonicalModelKey,
  officialChannelIdForModel,
  stripAggregateVendorPrefix,
} from "../modelCatalog/identity";

export {
  DEFAULT_EXPOSED_MODELS_BY_CHANNEL,
  FLOWLET_SUPPORTED_MODELS,
  MODEL_ALIASES,
  canonicalModelId,
  canonicalModelKey,
  officialChannelIdForModel,
  stripAggregateVendorPrefix,
} from "../modelCatalog/identity";

/** 客户端协议。`responses`（OpenAI Responses API）复用渠道的 OpenAI Base URL
 *  与鉴权，仅路由归属独立；当前仅无状态透传（POST /v1/responses）。 */
export type ProtocolType = "openai" | "anthropic" | "responses";

export type AuthStrategy = "bearer" | "x_api_key";

export const CUSTOM_CHANNEL_ID = "custom";

/** OpenRouter 聚合渠道 ID。OpenRouter 的 `/models` 返回全部主流模型（带
 *  `vendor/` 前缀），因此其账号天然可以勾选开放任意 Flowlet 白名单模型——
 *  未来白名单新增模型时，只要 OpenRouter `/models` 返回即可由用户勾选开放。
 *  `DEFAULT_EXPOSED_MODELS_BY_CHANNEL.openrouter` 仅登记 OpenRouter 独占模型的
 *  官方归属，不代表账号默认勾选；开放哪些模型仍由用户显式选择。 */
export const OPENROUTER_CHANNEL_ID = "openrouter";

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

/** Token Plan 个人版账号的默认开放模型。
 *  qwen3.8-max 为正式版（Token Plan 与按量付费均可用）。
 *  按量付费账号使用 DEFAULT_EXPOSED_MODELS_BY_CHANNEL.qwen。
 *  该列表表达套餐推荐值；模型身份仍以 model-catalog.json 为准。 */
export const QWEN_TOKEN_PLAN_DEFAULT_MODELS = ["qwen3.8-max", "qwen3.6-flash"];

/** 渠道预设模型从 model-catalog.json 按官方归属派生；未知渠道回退到预设默认模型。 */
export function defaultExposedModels(channel: ChannelPreset): string[] {
  // OpenRouter 的目录归属条目只描述其独占模型，不改变聚合渠道的显式选择语义。
  if (channel.id === OPENROUTER_CHANNEL_ID) return [channel.default_model].filter(Boolean);
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

/** 兼容旧版只保存规范 ID 的 exposed_models：在 synced_models 中优先找精确规范 ID，
 *  否则取首个映射到该规范模型的上游原始 ID。新选择直接保存原始 ID，不使用此
 *  函数合并多个独立上游资源。 */
export function pickUpstreamModelForCanonical(
  canonicalId: string,
  syncedModels: readonly string[] | null | undefined,
): string | null {
  const key = canonicalId.trim().toLowerCase();
  const synced = (syncedModels ?? []).map((model) => model.trim()).filter(Boolean);
  if (synced.some((model) => model.toLowerCase() === key)) return canonicalId.trim();
  return synced.find((model) => canonicalModelKey(model) === key) ?? null;
}

/** 将 exposed_models 解析为当前 synced_models 中实际选中的上游原始 ID。
 *  新数据按原始 ID 精确匹配；旧版只保存规范 ID 且规范 ID 未精确返回时，回退到
 *  同规范模型的首个上游 ID。返回值按选择顺序去重。 */
export function resolveSelectedUpstreamModelIds(
  selectedModels: readonly string[] | null | undefined,
  syncedModels: readonly string[] | null | undefined,
): string[] {
  const synced = (syncedModels ?? []).map((model) => model.trim()).filter(Boolean);
  const syncedById = new Map(synced.map((model) => [model.toLowerCase(), model] as const));
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const selected of selectedModels ?? []) {
    const selectedRaw = selected.trim();
    if (!selectedRaw) continue;
    const selectedKey = selectedRaw.toLowerCase();
    const canonicalKey = canonicalModelKey(selectedRaw);
    const upstream = syncedById.get(selectedKey)
      ?? (selectedKey === canonicalKey && canonicalModelId(selectedRaw)
        ? pickUpstreamModelForCanonical(selectedRaw, synced)
        : null);
    const upstreamKey = upstream?.toLowerCase();
    if (!upstream || !upstreamKey || seen.has(upstreamKey)) continue;
    seen.add(upstreamKey);
    resolved.push(upstream);
  }

  return resolved;
}

/** 判断账号是否为千问 Token Plan 模式。 */
export function isQwenTokenPlanAccount(account: { channel_id: string; resource_mode: string | null }): boolean {
  return account.channel_id === QWEN_CHANNEL_ID && account.resource_mode === "token_plan";
}

/** 判断账号是否为千问 API 按量付费模式（福利页免费额度抓取）。
 *  千问渠道默认资源模式为按量付费；历史账号 resource_mode 未写入(NULL)时按默认处理,
 *  与前端 defaultResourceMode 及 Rust default_resource_mode 兜底保持一致。 */
export function isQwenPayAsYouGoAccount(account: { channel_id: string; resource_mode: string | null }): boolean {
  return account.channel_id === QWEN_CHANNEL_ID &&
    (account.resource_mode === "pay_as_you_go" || account.resource_mode === null);
}

/** 判断是否为 ChatGPT (Codex) 伪账号。Codex 账号由 Rust 端同步，
 *  前端不可编辑、不参与路由，仅在概览页底部作为非交互展示项。 */
export function isChatGptAccount(account: { channel_id: string; resource_mode: string | null }): boolean {
  return account.channel_id === CHATGPT_CHANNEL_ID && account.resource_mode === "codex";
}
