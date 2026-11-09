import type { AgentAccessAdapter, AgentModelProtocol } from "../agentAccessAdapters";
import { manualModelValue, modelOptions, modelSelectionOptions, selectedModelValue } from "./shared";

/** DeepSeek Harness 写入的是 OpenAI-compatible `/v1` provider，可用模型只取 openai 协议。 */
const DEEPSEEK_HARNESS_PROTOCOLS: AgentModelProtocol[] = ["openai"];

/// 与 Rust 写入端保持一致：只声明用户所选单个模型，条目只写 `id`，
/// 不声明 contextWindow 或输入模态（聚合模型能力声明已移除）。
function settingsSnippet(endpoint: string, primaryModel: string) {
  const declared = primaryModel ? [primaryModel] : ["<model-id>"];
  return [
    "llm-pi-ai:",
    "  providers:",
    "    flowlet:",
    "      displayName: Flowlet",
    "      apiKeyEnv: FLOWLET_CLIENT_TOKEN",
    "      api: openai-completions",
    `      baseURL: ${endpoint}`,
    "      models:",
    ...declared.map((model) => `        - id: ${model}`),
    "agent-default-model:",
    "  provider: flowlet",
    `  model: ${primaryModel}`,
    "",
  ].join("\n");
}

export const deepSeekHarnessAdapter: AgentAccessAdapter = {
  id: "deepseek-harness",
  installationName: () => "DeepSeek Harness Web",
  configStatuses: () => [],
  configControls: (context) => {
    const sessionExtension = context.globalConfig?.session_extension ?? false;
    const mcpServers = context.globalConfig?.mcp_servers ?? [];
    const primaryModel = selectedModelValue(modelOptions(context, DEEPSEEK_HARNESS_PROTOCOLS), context.globalConfig?.primary_model);
    return [{
      id: "session-extension",
      label: context.t("精确会话关联"),
      descriptions: [
        context.t("启用后会向已初始化的 DSH Profile 安装受管 Cordis 插件，把代理请求与原生会话精确关联。"),
        context.t("基础 Provider、默认模型和 Token 接入不依赖此插件；启用或关闭后需重启正在运行的 DSH。"),
      ],
      checked: sessionExtension,
      requiresRestart: true,
      applyOptions: (checked) => ({
        ...modelSelectionOptions(primaryModel),
        sessionExtension: checked,
        mcpServers,
      }),
    }];
  },
  applyOptions: (context) => ({
    ...modelSelectionOptions(selectedModelValue(modelOptions(context, DEEPSEEK_HARNESS_PROTOCOLS), context.globalConfig?.primary_model)),
    sessionExtension: context.globalConfig?.session_extension ?? false,
    mcpServers: context.globalConfig?.mcp_servers ?? [],
  }),
  manualSnippets: (context) => {
    const options = modelOptions(context, DEEPSEEK_HARNESS_PROTOCOLS);
    const primaryModel = manualModelValue(options, context.globalConfig?.primary_model);
    const settings = settingsSnippet(context.endpoint, primaryModel);
    return [
      { label: context.t("settings.yaml Provider 片段"), displayValue: settings, copyValue: settings },
      {
        label: context.t(".credentials.yaml 凭据片段"),
        displayValue: `version: 1\nrefs:\n  FLOWLET_CLIENT_TOKEN: ${context.displayedToken}\n`,
        copyValue: `version: 1\nrefs:\n  FLOWLET_CLIENT_TOKEN: ${context.token}\n`,
      },
    ];
  },
  modelSelectors: (context) => {
    const options = modelOptions(context, DEEPSEEK_HARNESS_PROTOCOLS);
    return [{
      id: "primary",
      label: context.t("主模型"),
      value: selectedModelValue(options, context.globalConfig?.primary_model),
      options,
      applyOptions: (value) => ({
        ...modelSelectionOptions(value),
        sessionExtension: context.globalConfig?.session_extension ?? false,
        mcpServers: context.globalConfig?.mcp_servers ?? [],
      }),
    }];
  },
};