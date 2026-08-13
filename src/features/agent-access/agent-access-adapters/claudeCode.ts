import type { AgentAccessAdapter } from "../agentAccessAdapters";

export const claudeCodeAdapter: AgentAccessAdapter = {
  id: "claude-code",
  installationName: () => "Claude Code",
  configStatuses: () => [],
  configControls: ({ globalConfig, t }) => {
    const primaryLongContext = globalConfig?.primary_long_context ?? false;
    const fastLongContext = globalConfig?.fast_long_context ?? false;
    return [
      {
        id: "primary-long-context",
        label: t("flowlet-pro 1M 长上下文"),
        descriptions: [t("用于 Claude Code 主会话及 Opus、Sonnet、Fable 模型映射。"), t("仅当 flowlet-pro 的所有启用路由都支持 1M 时开启。")],
        checked: primaryLongContext,
        applyOptions: (checked) => ({ primaryLongContext: checked, fastLongContext }),
      },
      {
        id: "fast-long-context",
        label: t("flowlet-flash 1M 长上下文"),
        descriptions: [t("用于 Haiku、快速后台任务和子 Agent 模型映射。"), t("仅当 flowlet-flash 的所有启用路由都支持 1M 时开启。")],
        checked: fastLongContext,
        applyOptions: (checked) => ({ primaryLongContext, fastLongContext: checked }),
      },
    ];
  },
  applyOptions: ({ globalConfig }) => ({
    primaryLongContext: globalConfig?.primary_long_context ?? false,
    fastLongContext: globalConfig?.fast_long_context ?? false,
  }),
  manualSnippets: ({ endpoint, token, displayedToken, globalConfig, t }) => {
    const primaryModel = globalConfig?.primary_long_context ? "flowlet-pro[1m]" : "flowlet-pro";
    const fastModel = globalConfig?.fast_long_context ? "flowlet-flash[1m]" : "flowlet-flash";
    const value = (authToken: string) => JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: endpoint,
        ANTHROPIC_AUTH_TOKEN: authToken,
        ANTHROPIC_MODEL: primaryModel,
        ANTHROPIC_DEFAULT_FABLE_MODEL: primaryModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: primaryModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: primaryModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: fastModel,
        ANTHROPIC_SMALL_FAST_MODEL: fastModel,
        CLAUDE_CODE_SUBAGENT_MODEL: fastModel,
      },
    }, null, 2);
    return [{ label: t("settings.json 配置片段"), displayValue: value(displayedToken), copyValue: value(token) }];
  },
};
