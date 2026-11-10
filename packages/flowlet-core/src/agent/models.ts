// Agent 接入的模型解析与 Codex 动态模型目录。
//
// 权威实现：
// - `src-tauri/src/commands/agent.rs`（可用模型 / 默认模型 / 快速模型解析）
// - `src-tauri/src/core/agent_global_config.rs`（canonical_known_model）
// - `src-tauri/src/core/codex_model_catalog.rs`（model-catalog.flowlet.json 生成）
import { modelCatalog } from "../catalog/index.ts";
import { ACCOUNT_CREDENTIAL_HEALTHY } from "../proxy/routing.ts";
import type { JsonRow } from "../types.ts";
import { agentDescriptor } from "./registry.ts";

export type AgentProtocol = "openai" | "anthropic" | "responses";

/** Agent 全局配置实际使用的协议（由插件注册表 `endpointSuffix` 决定）。 */
export function agentProtocols(adapterId: string): AgentProtocol[] {
  if (adapterId === "claude-code") return ["anthropic"];
  if (adapterId === "codex") return ["responses"];
  return ["openai"];
}

/** 未注册 Agent 的固定错误（Rust `agent_endpoint_suffix`）。 */
export function agentEndpointSuffix(agentId: string): string {
  const agent = agentDescriptor(agentId);
  if (agent === undefined) throw new Error(`未注册的 Agent 插件：${agentId}`);
  return agent.endpointSuffix;
}

export function agentGlobalConfigAdapterId(agentId: string): string {
  const agent = agentDescriptor(agentId);
  if (agent === undefined) throw new Error(`未注册的 Agent 插件：${agentId}`);
  return agent.globalConfigAdapterId;
}

/** 归一为 `model-catalog.json` 的规范模型 ID；未登记的名字一律拒绝。 */
export function canonicalKnownModel(model: string): string {
  const identity = modelCatalog().find(model);
  if (identity === null) {
    throw new Error(`模型 ${model} 不在 Flowlet 模型目录中，无法写入 Agent 配置`);
  }
  return identity.id;
}

/** 模型是否在模型目录中登记（inspect 识别历史聚合模型配置）。 */
export function isKnownCatalogModel(model: string): boolean {
  return modelCatalog().find(model) !== null;
}

export interface AgentModelChoices {
  primaryModel: string;
  fastModel: string;
}

/** 解析本次写入使用的（主模型，快速模型）；`primaryModel` 必须提供。 */
export function resolveModelChoices(options: AgentGlobalConfigOptions | null | undefined): AgentModelChoices {
  const requestedPrimary = options?.primaryModel?.trim();
  if (requestedPrimary === undefined || requestedPrimary === "") {
    throw new Error("未指定默认模型：请先在接入抽屉中选择一个已开放的模型");
  }
  const primaryModel = canonicalKnownModel(requestedPrimary);
  const requestedFast = options?.fastModel?.trim();
  const fastModel =
    requestedFast === undefined || requestedFast === ""
      ? primaryModel
      : canonicalKnownModel(requestedFast);
  return { primaryModel, fastModel };
}

/** 一键写入的可选参数（camelCase，与 Rust `AgentGlobalConfigOptions` 一致）。 */
export interface AgentGlobalConfigOptions {
  sessionExtension?: boolean;
  primaryModel?: string;
  fastModel?: string;
  mcpServers?: McpServerSpecInput[];
}

export interface McpServerSpecInput {
  id: string;
  serverName: string;
  transport: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** 当前 Agent 协议下可用的规范模型 ID，按字典序返回（Rust `available_agent_models`）。 */
export function availableAgentModels(snapshot: JsonRow, protocols: ReadonlyArray<AgentProtocol>): string[] {
  const routes = asRowArray(snapshot.routes);
  const accounts = asRowArray(snapshot.accounts);
  const channels = asRowArray(snapshot.channels);
  const models = new Set<string>();
  for (const route of routes) {
    if (route.enabled !== true) continue;
    const clientProtocol = route.client_protocol;
    if (typeof clientProtocol !== "string" || !protocols.includes(clientProtocol as AgentProtocol)) {
      continue;
    }
    const virtualModelId = typeof route.virtual_model_id === "string" ? route.virtual_model_id : "";
    const identity = modelCatalog().find(virtualModelId);
    if (identity === null) continue;
    const routeAccountId = route.account_id;
    const accountUsable = accounts.some(
      (account) =>
        account.id === routeAccountId &&
        account.enabled === true &&
        typeof account.api_key === "string" &&
        account.api_key.trim() !== "" &&
        account.credential_status === ACCOUNT_CREDENTIAL_HEALTHY,
    );
    if (!accountUsable) continue;
    const routeChannelId = route.channel_id;
    const channelUsable = channels.some(
      (channel) =>
        channel.id === routeChannelId &&
        channel.enabled === true &&
        Array.isArray(channel.supported_protocols) &&
        channel.supported_protocols.includes(clientProtocol),
    );
    if (channelUsable) models.add(identity.id);
  }
  return [...models].sort();
}

function asRowArray(value: unknown): JsonRow[] {
  return Array.isArray(value) ? value.filter(isRow) : [];
}

function isRow(value: unknown): value is JsonRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 解析单个模型的最终取值：用户传了就必须是已知模型，否则按字典序取第一个可用模型。 */
export function resolveRequestedModel(requested: string | null | undefined, available: ReadonlyArray<string>): string {
  const trimmed = requested?.trim();
  if (trimmed !== undefined && trimmed !== "") return canonicalKnownModel(trimmed);
  const first = available[0];
  if (first === undefined) {
    throw new Error("没有可用的开放模型：请先在模型服务页为当前 Agent 协议开放模型，并确保账号可用");
  }
  return first;
}

/** 解析快速模型：显式传值时校验并归一；缺省回退到已解析的主模型。 */
export function resolveFastModel(requested: string | null | undefined, primaryModel: string): string {
  const trimmed = requested?.trim();
  return trimmed === undefined || trimmed === "" ? primaryModel : canonicalKnownModel(trimmed);
}

// ─── Codex 动态模型目录 ─────────────────────────────────────────────────────

/** 查不到模型规格时的保守上下文窗口。 */
const FALLBACK_CONTEXT_WINDOW = 128_000;

/** Codex 启动时 serde 反序列化所需字段（缺任一即 `missing field ...`）。 */
export const CODEX_MODEL_REQUIRED_FIELDS: ReadonlyArray<string> = [
  "slug",
  "display_name",
  "description",
  "default_reasoning_level",
  "supported_reasoning_levels",
  "shell_type",
  "visibility",
  "supported_in_api",
  "priority",
  "base_instructions",
  "supports_reasoning_summaries",
  "support_verbosity",
  "truncation_policy",
  "supports_parallel_tool_calls",
  "context_window",
  "effective_context_window_percent",
  "experimental_supported_tools",
];

interface ModelsCnSpec {
  displayName: string | null;
  contextTokens: number | null;
  inputModalities: string[];
  thinking: boolean | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 在 models-cn.json 中按规范 ID 双侧归一查找模型能力事实。 */
function modelsCnSpec(modelsCn: JsonRow | null, model: string): ModelsCnSpec | null {
  const identity = modelCatalog().find(model);
  if (modelsCn === null || identity === null) return null;
  const providers = modelsCn.providers;
  if (!Array.isArray(providers)) return null;
  const wantedKey = modelCatalog().canonicalKey(identity.id);
  for (const provider of providers) {
    if (!isRow(provider) || provider.id !== identity.modelsCnProviderId) continue;
    const models = provider.models;
    if (!Array.isArray(models)) continue;
    for (const entry of models) {
      if (!isRow(entry) || typeof entry.id !== "string") continue;
      if (modelCatalog().canonicalKey(entry.id) !== wantedKey) continue;
      const limits = isRow(entry.limits) ? entry.limits : {};
      const capabilities = isRow(entry.capabilities) ? entry.capabilities : {};
      const rawModalities = Array.isArray(capabilities.inputModalities)
        ? capabilities.inputModalities
        : [];
      return {
        displayName: stringOrNull(entry.name),
        contextTokens:
          numberOrNull(limits.contextTokens) !== null && (limits.contextTokens as number) > 0
            ? (limits.contextTokens as number)
            : null,
        inputModalities: rawModalities
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim().toLowerCase())
          .filter((value) => value === "text" || value === "image"),
        thinking: typeof capabilities.thinking === "boolean" ? capabilities.thinking : null,
      };
    }
  }
  return null;
}

function reasoningEfforts(thinking: boolean | null): string[] {
  return thinking === true ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high"];
}

function defaultReasoningLevel(thinking: boolean | null): string {
  return thinking === true ? "high" : "medium";
}

function reasoningDescription(effort: string): string {
  switch (effort) {
    case "none":
      return "Disable reasoning";
    case "minimal":
      return "Minimal reasoning for simple tasks";
    case "low":
      return "Fast responses with lighter reasoning";
    case "medium":
      return "Greater reasoning depth for complex problems";
    case "high":
      return "Extra high reasoning depth for complex problems";
    case "xhigh":
      return "Maximum reasoning depth for the hardest problems";
    default:
      return "Reasoning";
  }
}

/** 生成按所选模型动态生成的单条目 Codex 模型目录（Rust `catalog_for_model`）。 */
export function catalogForModel(modelsCn: JsonRow | null, model: string): JsonRow {
  const spec = modelsCnSpec(modelsCn, model);
  const contextWindow = spec?.contextTokens ?? FALLBACK_CONTEXT_WINDOW;
  const inputModalities = ["text"];
  if (spec?.inputModalities.includes("image") === true) inputModalities.push("image");
  const efforts = reasoningEfforts(spec?.thinking ?? null);
  const generated: JsonRow = {
    models: [
      {
        slug: model,
        display_name: spec?.displayName ?? model,
        description: `Flowlet 本地代理转发的 ${model}`,
        default_reasoning_level: defaultReasoningLevel(spec?.thinking ?? null),
        supported_reasoning_levels: efforts.map((effort) => ({
          effort,
          description: reasoningDescription(effort),
        })),
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        base_instructions: "",
        supports_reasoning_summaries: spec?.thinking === true,
        default_reasoning_summary: "none",
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: "freeform",
        web_search_tool_type: "text",
        truncation_policy: { mode: "tokens", limit: 10000 },
        supports_parallel_tool_calls: true,
        supports_image_detail_original: false,
        context_window: contextWindow,
        max_context_window: contextWindow,
        auto_compact_token_limit: null,
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities: inputModalities,
        availability_nux: null,
        upgrade: null,
      },
    ],
  };
  return generated;
}

/** 生成写入磁盘的模型目录文本（pretty + 末尾换行）。 */
export function codexCatalogContent(modelsCn: JsonRow | null, model: string): string {
  return `${JSON.stringify(catalogForModel(modelsCn, model), null, 2)}\n`;
}

/** 判断磁盘上的模型目录是否声明了指定模型（inspect 使用）。 */
export function catalogDeclaresModel(raw: string, model: string): boolean {
  let catalog: unknown;
  try {
    catalog = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isRow(catalog) || !Array.isArray(catalog.models)) return false;
  return catalog.models.some((entry) => isRow(entry) && entry.slug === model);
}