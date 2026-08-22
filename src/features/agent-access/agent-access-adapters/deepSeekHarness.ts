import type { AgentAccessAdapter } from "../agentAccessAdapters";

/// 与 Rust 写入端 `provider_profile_with_inputs` 保持一致：
/// 「聚合模型规格」关闭时模型条目只有 id；开启后写入 1M 上下文窗口，并按
/// 当前可用路由声明输入能力（text 恒在，image 仅在路由支持时出现）。
function settingsSnippet(
  endpoint: string,
  modelSpecs: boolean,
  modelInputs?: Record<string, string[]>,
) {
  const model = (id: "flowlet-pro" | "flowlet-flash"): string[] => {
    if (!modelSpecs) return [`        - id: ${id}`];
    const declared = modelInputs?.[id] ?? [];
    const input = declared.includes("image") ? ["text", "image"] : ["text"];
    return [
      `        - id: ${id}`,
      "          contextWindow: 1048576",
      "          input:",
      ...input.map((value) => `            - ${value}`),
    ];
  };
  return [
    "llm-pi-ai:",
    "  providers:",
    "    flowlet:",
    "      displayName: Flowlet",
    "      apiKeyEnv: FLOWLET_CLIENT_TOKEN",
    "      api: openai-completions",
    `      baseURL: ${endpoint}`,
    "      models:",
    ...model("flowlet-pro"),
    ...model("flowlet-flash"),
    "agent-default-model:",
    "  provider: flowlet",
    "  model: flowlet-pro",
    "",
  ].join("\n");
}

export const deepSeekHarnessAdapter: AgentAccessAdapter = {
  id: "deepseek-harness",
  installationName: () => "DeepSeek Harness Web",
  configStatuses: () => [],
  configControls: ({ globalConfig, t }) => {
    const sessionExtension = globalConfig?.session_extension ?? false;
    const modelSpecs = globalConfig?.model_specs ?? false;
    const approvalBridge = globalConfig?.approval_bridge ?? false;
    return [
      {
        id: "session-extension",
        label: t("精确会话关联"),
        descriptions: [
          t("启用后会向已初始化的 DSH Profile 安装受管 Cordis 插件，把代理请求与原生会话精确关联。"),
          t("基础 Provider、默认模型和 Token 接入不依赖此插件；启用或关闭后需重启正在运行的 DSH。"),
        ],
        checked: sessionExtension,
        requiresRestart: true,
        applyOptions: (checked) => ({ sessionExtension: checked, modelSpecs, approvalBridge }),
      },
      {
        id: "model-specs",
        label: t("聚合模型规格"),
        descriptions: [
          t("开启后向 settings.yaml 写入 1M 上下文窗口，并按当前可用路由分别声明文本或图像输入能力。"),
          t("图像请求会由 Flowlet 再次筛选支持图像的上游；不声明最大输出上限，保持 DSH 默认的保守值。"),
        ],
        checked: modelSpecs,
        applyOptions: (checked) => ({ sessionExtension, modelSpecs: checked, approvalBridge }),
      },
      {
        id: "approval-bridge",
        label: t("交互确认桥"),
        descriptions: [
          t("启用后会向已初始化的 DSH Profile 安装受管确认桥插件，把 headless 会话的权限请求经文件桥转交 Flowlet 桌面端确认或否决。"),
          t("启用后需要重启正在运行的 DSH；关闭后移除受管插件，确认请求恢复为无人应答（fail-closed）。"),
        ],
        checked: approvalBridge,
        requiresRestart: true,
        applyOptions: (checked) => ({ sessionExtension, modelSpecs, approvalBridge: checked }),
      },
    ];
  },
  applyOptions: ({ globalConfig }) => ({
    sessionExtension: globalConfig?.session_extension ?? false,
    modelSpecs: globalConfig?.model_specs ?? false,
    approvalBridge: globalConfig?.approval_bridge ?? false,
  }),
  manualSnippets: ({ endpoint, token, displayedToken, globalConfig, t }) => {
    const settings = settingsSnippet(
      endpoint,
      globalConfig?.model_specs ?? false,
      globalConfig?.model_input_modalities,
    );
    return [
      { label: t("settings.yaml Provider 片段"), displayValue: settings, copyValue: settings },
      {
        label: t(".credentials.yaml 凭据片段"),
        displayValue: `version: 1\nrefs:\n  FLOWLET_CLIENT_TOKEN: ${displayedToken}\n`,
        copyValue: `version: 1\nrefs:\n  FLOWLET_CLIENT_TOKEN: ${token}\n`,
      },
    ];
  },
};
