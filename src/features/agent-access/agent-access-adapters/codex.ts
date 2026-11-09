import type { ModelsCnCatalog, ModelsCnModel } from "../../../domains/modelCatalog/types";
import { canonicalModelKey, modelsCnProviderIdForModel } from "../../../domains/modelCatalog/identity";
import type { AgentAccessAdapter, AgentModelProtocol } from "../agentAccessAdapters";
import { manualModelValue, modelOptions, modelSelectionOptions, selectedModelValue } from "./shared";

const RESPONSES_PROTOCOLS: AgentModelProtocol[] = ["responses"];

/** Codex 推理档位：只使用 Codex 支持的 none/minimal/low/medium/high/xhigh。 */
const REASONING_DESCRIPTIONS: Record<string, string> = {
  low: "Fast responses with lighter reasoning",
  medium: "Greater reasoning depth for complex problems",
  high: "Extra high reasoning depth for complex problems",
  xhigh: "Maximum reasoning depth for the hardest problems",
};

/** 与 Rust 端一致：在 models-cn 的官方 provider 内按规范模型 ID 双侧归一查找。 */
function findCatalogModel(catalog: ModelsCnCatalog | null | undefined, modelId: string): ModelsCnModel | null {
  if (!catalog) return null;
  const providerId = modelsCnProviderIdForModel(modelId);
  if (!providerId) return null;
  const provider = catalog.providers.find((item) => item.id === providerId);
  if (!provider) return null;
  const canonical = canonicalModelKey(modelId);
  return provider.models.find((model) => canonicalModelKey(model.id) === canonical) ?? null;
}

function inputModalities(model: ModelsCnModel | null): string[] {
  const declared = (model?.capabilities?.inputModalities ?? []).map((value) => value.trim().toLowerCase());
  // Codex 只声明官方支持的输入模态；文本是对话必需项，始终声明。
  return declared.includes("image") ? ["text", "image"] : ["text"];
}

/**
 * 按所选模型动态生成单条目 Codex 模型目录，规则与 Rust `codex_model_catalog` 对齐：
 * context_window 取 models-cn 的 limits.contextTokens，input 取 capabilities.inputModalities，
 * 推理档位按 capabilities.thinking 给；查不到模型时使用保守条目。其余字段沿用原静态常量。
 */
function codexModelCatalogSnippet(modelId: string, catalog: ModelsCnCatalog | null | undefined): string {
  const model = findCatalogModel(catalog, modelId);
  const contextTokens = model?.limits?.contextTokens;
  const contextWindow = typeof contextTokens === "number" && contextTokens > 0 ? contextTokens : 128000;
  const thinking = model?.capabilities?.thinking === true;
  const levels = thinking
    ? ["low", "medium", "high", "xhigh"]
    : ["low", "medium", "high"];
  const displayName = model?.name?.trim() || modelId;
  const entry = {
    slug: modelId,
    display_name: displayName,
    description: `Flowlet 本地代理转发的 ${modelId}`,
    default_reasoning_level: thinking ? "high" : "medium",
    supported_reasoning_levels: levels.map((effort) => ({
      effort,
      description: REASONING_DESCRIPTIONS[effort],
    })),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    base_instructions: "",
    supports_reasoning_summaries: thinking,
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
    input_modalities: inputModalities(model),
    availability_nux: null,
    upgrade: null,
  };
  return JSON.stringify({ models: [entry] }, null, 2);
}

function selectedPrimary(context: Parameters<AgentAccessAdapter["applyOptions"]>[0]): string {
  return selectedModelValue(modelOptions(context, RESPONSES_PROTOCOLS), context.globalConfig?.primary_model);
}

export const codexAdapter: AgentAccessAdapter = {
  id: "codex",
  installationName: (surface) => surface === "desktop" ? "ChatGPT Desktop" : "Codex CLI",
  configStatuses: ({ globalConfig, t }) => [{ label: t("模型目录"), value: t(globalConfig?.model_catalog_configured ? "已配置" : "未配置") }],
  configControls: () => [],
  applyOptions: (context) => modelSelectionOptions(selectedPrimary(context)),
  manualSnippets: (context) => {
    const options = modelOptions(context, RESPONSES_PROTOCOLS);
    const model = manualModelValue(options, context.globalConfig?.primary_model);
    const config = [
      `model = "${model}"`,
      'model_provider = "flowlet"',
      "disable_response_storage = true",
      'preferred_auth_method = "apikey"',
      'model_catalog_json = "~/.codex/model-catalog.flowlet.json"',
      "",
      "[model_providers.flowlet]",
      'name = "flowlet"',
      `base_url = "${context.endpoint}"`,
      'wire_api = "responses"',
      "requires_openai_auth = true",
    ].join("\n");
    const credentials = (apiKey: string) => JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2);
    const catalog = codexModelCatalogSnippet(model, context.modelCatalog);
    return [
      { label: context.t("config.toml 配置片段"), displayValue: config, copyValue: config },
      { label: context.t("auth.json 凭据片段"), displayValue: credentials(context.displayedToken), copyValue: credentials(context.token) },
      { label: context.t("模型目录片段（保存为 ~/.codex/model-catalog.flowlet.json）"), displayValue: catalog, copyValue: catalog },
    ];
  },
  modelSelectors: (context) => {
    const options = modelOptions(context, RESPONSES_PROTOCOLS);
    return [{
      id: "primary",
      label: context.t("主模型"),
      value: selectedModelValue(options, context.globalConfig?.primary_model),
      options,
      applyOptions: (value) => modelSelectionOptions(value),
    }];
  },
};
