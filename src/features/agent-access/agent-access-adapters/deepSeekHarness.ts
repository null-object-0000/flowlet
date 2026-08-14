import type { AgentAccessAdapter } from "../agentAccessAdapters";

function settingsSnippet(endpoint: string) {
  return [
    "llm-pi-ai:",
    "  providers:",
    "    flowlet:",
    "      displayName: Flowlet",
    "      apiKeyEnv: FLOWLET_CLIENT_TOKEN",
    "      api: openai-completions",
    `      baseURL: ${endpoint}`,
    "      models:",
    "        - id: flowlet-pro",
    "        - id: flowlet-flash",
    "agent-default-model:",
    "  provider: flowlet",
    "  model: flowlet-pro",
    "",
  ].join("\n");
}

export const deepSeekHarnessAdapter: AgentAccessAdapter = {
  id: "deepseek-harness",
  installationName: () => "DeepSeek Harness Web",
  configStatuses: ({ globalConfig, t }) => [{
    label: t("精确会话关联"),
    value: t(globalConfig?.session_extension ? "已启用" : "未启用（可选）"),
  }],
  configControls: ({ globalConfig, t }) => [{
    id: "session-extension",
    label: t("启用精确会话关联（高级）"),
    descriptions: [
      t("启用后会向已初始化的 DSH Profile 安装受管 Cordis 插件，把代理请求与原生会话精确关联。"),
      t("基础 Provider、默认模型和 Token 接入不依赖此插件；启用或关闭后需重启正在运行的 DSH。"),
    ],
    checked: globalConfig?.session_extension ?? false,
    applyOptions: (checked) => ({ sessionExtension: checked }),
  }],
  applyOptions: ({ globalConfig }) => ({ sessionExtension: globalConfig?.session_extension ?? false }),
  manualSnippets: ({ endpoint, token, displayedToken, t }) => {
    const settings = settingsSnippet(endpoint);
    return [
      { label: t("settings.yaml Provider 片段"), displayValue: settings, copyValue: settings },
      {
        label: t(".credentials.yaml 凭据片段"),
        displayValue: `FLOWLET_CLIENT_TOKEN: ${displayedToken}\n`,
        copyValue: `FLOWLET_CLIENT_TOKEN: ${token}\n`,
      },
    ];
  },
};
