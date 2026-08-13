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
    "      headers:",
    "        x-flowlet-client: deepseek-harness",
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
  configStatuses: () => [],
  configControls: () => [],
  applyOptions: () => undefined,
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
