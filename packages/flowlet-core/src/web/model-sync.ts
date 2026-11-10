// Web 命令 test_connection / fetch_channel_models 的实现。Owner: node-web.
//
// 权威实现：src-tauri/src/core/sync.rs（test_channel_connection / 各渠道模型同步）
// 与 core/web/commands.rs 的 "test_connection" | "fetch_channel_models" 分支。
// Web Host 只对「账号连接参数」做一次性拉取，不读写账号表（保存由前端 save_channel_accounts 完成）。
import type { JsonRow } from "../types.ts";
import { CommandError } from "../types.ts";
import type { WebContext } from "./context.ts";
import { accountModelsUrl, effectiveOpenaiBaseUrl, modelsEndpointUrl } from "./config-state.ts";
import { getUpstream, requestErrorDetail } from "./upstream.ts";

export interface ModelSyncResult {
  models_synced: number;
  models: JsonRow[];
  errors: string[];
}

/** 构造与 Rust `ChannelAccount` 默认值一致的最小连接参数。 */
export function transientAccount(args: {
  channelId: string;
  apiKey: string;
  baseUrlOverride: string | null;
  useUpstreamProxy: boolean | null;
}): JsonRow {
  return {
    id: "",
    workspace_account_id: null,
    channel_id: args.channelId,
    name: "",
    api_key: args.apiKey,
    management_key: null,
    enabled: true,
    priority: 0,
    remark: null,
    resource_mode: null,
    resource_sync_mode: "manual",
    base_url_override: args.baseUrlOverride,
    use_upstream_proxy: args.useUpstreamProxy,
    anthropic_base_url_override: null,
    workspace_default_base_url: null,
    workspace_default_anthropic_base_url: null,
    last_used_at: null,
    last_error: null,
    credential_status: "healthy",
    synced_models: null,
    models_synced_at: null,
    exposed_models: null,
    created_at: "",
    updated_at: "",
  };
}

function presetOf(ctx: WebContext, channelId: string): JsonRow | null {
  const channels = ctx.channelsConfig.channels;
  if (!Array.isArray(channels)) return null;
  return (channels as JsonRow[]).find((preset) => preset?.id === channelId) ?? null;
}

/** GET <models 端点>；返回 {status, body}。 */
async function fetchModelsRaw(
  ctx: WebContext,
  account: JsonRow,
  timeoutMs: number,
): Promise<{ status: number; body: string; url: string }> {
  if (String(account.api_key ?? "").trim() === "") throw new Error("API Key 未配置");
  const channelId = String(account.channel_id ?? "");
  const url = accountModelsUrl(account, ctx.channelsConfig);
  if (url === null) throw new Error(`不支持同步模型的渠道: ${channelId}`);
  const response = await getUpstream(url, {
    headers: { authorization: `Bearer ${String(account.api_key).trim()}` },
    timeoutMs,
    proxy: ctx.upstreamProxy,
    useUpstreamProxy: account.use_upstream_proxy as boolean | null,
    channelId,
  });
  return { ...response, url };
}

/** Rust `sync::test_channel_connection`：成功返回 null，失败 400 command_failed。 */
export async function testChannelConnection(ctx: WebContext, account: JsonRow): Promise<null> {
  if (String(account.api_key ?? "").trim() === "") {
    throw CommandError.badRequest("API Key 未配置");
  }
  const channelId = String(account.channel_id ?? "");
  const url = accountModelsUrl(account, ctx.channelsConfig);
  if (url === null) throw CommandError.badRequest(`不支持测试连接的渠道: ${channelId}`);
  let response: { status: number; body: string };
  try {
    response = await getUpstream(url, {
      headers: { authorization: `Bearer ${String(account.api_key).trim()}` },
      timeoutMs: 10_000,
      proxy: ctx.upstreamProxy,
      useUpstreamProxy: account.use_upstream_proxy as boolean | null,
      channelId,
    });
  } catch (error) {
    throw CommandError.badRequest(`GET ${url} 请求失败: ${requestErrorDetail(error)}`);
  }
  if (response.status >= 200 && response.status < 300) return null;
  if (response.status === 401) {
    throw CommandError.badRequest(`GET ${url} → HTTP 401，API Key 无效或鉴权方式不匹配`);
  }
  throw CommandError.badRequest(`GET ${url} → HTTP ${response.status}`);
}

function nowRfc3339(): string {
  return new Date().toISOString();
}

function channelModel(
  channelId: string,
  model: string,
  preset: JsonRow | null,
  syncedAt: string,
  extra: { displayName?: string | null; contextWindow?: number | null; maxOutputTokens?: number | null; pricing?: unknown },
): JsonRow {
  const protocols = Array.isArray(preset?.supported_protocols) ? preset.supported_protocols : ["openai"];
  return {
    id: `${channelId}-${model}`,
    channel_id: channelId,
    model,
    display_name: extra.displayName ?? model,
    supported_protocols: protocols,
    context_window: extra.contextWindow ?? null,
    max_output_tokens: extra.maxOutputTokens ?? null,
    pricing: extra.pricing ?? null,
    supports_stream: true,
    enabled: true,
    source: "synced",
    synced_at: syncedAt,
    created_at: syncedAt,
    updated_at: syncedAt,
  };
}

/** Rust `channel_capability_adapter::sync_channel_models` 的最小等价实现。 */
export async function fetchChannelModels(ctx: WebContext, account: JsonRow): Promise<ModelSyncResult> {
  const channelId = String(account.channel_id ?? "");
  const preset = presetOf(ctx, channelId);
  if (preset === null) {
    return { models_synced: 0, models: [], errors: [`渠道 ${channelId} 缺少运行时模板`] };
  }
  if (preset.supports_model_list !== true) {
    return { models_synced: 0, models: [], errors: ["当前渠道未声明模型列表能力"] };
  }
  let response: { status: number; body: string; url: string };
  try {
    response = await fetchModelsRaw(ctx, account, 15_000);
  } catch (error) {
    return {
      models_synced: 0,
      models: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      models_synced: 0,
      models: [],
      errors: [`HTTP ${response.status}: ${response.body}`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch (error) {
    return {
      models_synced: 0,
      models: [],
      errors: [`解析模型列表响应失败: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const entries = extractEntries(parsed);
  if (entries === null) {
    return { models_synced: 0, models: [], errors: ["解析模型列表响应失败: 缺少 data 数组"] };
  }
  const syncedAt = nowRfc3339();
  const models: JsonRow[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as JsonRow;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (id === "") continue;
    if (channelId === "deepseek") {
      models.push(channelModel(channelId, id, preset, syncedAt, { contextWindow: 1_000_000, maxOutputTokens: 384_000 }));
      continue;
    }
    models.push(
      channelModel(channelId, id, preset, syncedAt, {
        displayName: typeof row.name === "string" && row.name !== "" ? row.name : id,
        contextWindow: typeof row.context_length === "number" ? row.context_length : null,
        maxOutputTokens:
          typeof row.max_completion_tokens === "number" ? row.max_completion_tokens : null,
        pricing: row.pricing ?? null,
      }),
    );
  }
  return { models_synced: models.length, models, errors: [] };
}

function extractEntries(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === "object") {
    const rows = (parsed as JsonRow).data;
    if (Array.isArray(rows)) return rows;
    const models = (parsed as JsonRow).models;
    if (Array.isArray(models)) return models;
  }
  return null;
}

/** 渠道 endpoints 覆盖（供 sync_models_cn/dev 等命令使用）。 */
export function channelModelsEndpoint(ctx: WebContext, channelId: string): string | null {
  return modelsEndpointUrl(ctx.channelsConfig, channelId);
}

/** 账号是否使用自定义 OpenAI Base URL（余额命令的边界判断）。 */
export function hasCustomOpenAiBaseUrl(account: JsonRow): boolean {
  return effectiveOpenaiBaseUrl(account) !== null;
}