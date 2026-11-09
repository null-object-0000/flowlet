import type { AgentAccessAdapter, AgentModelProtocol } from "../agentAccessAdapters";
import {
  manualModelValue,
  modelOptions,
  modelSelectionOptions,
  selectedModelValue,
} from "./shared";

const ANTHROPIC_PROTOCOLS: AgentModelProtocol[] = ["anthropic"];

function currentModels(context: Parameters<AgentAccessAdapter["applyOptions"]>[0]) {
  const options = modelOptions(context, ANTHROPIC_PROTOCOLS);
  const primary = selectedModelValue(options, context.globalConfig?.primary_model);
  // fast 缺省等于 primary（Rust 写入端的缺省规则）；未显式配置快速模型时同步展示 primary。
  const fast = selectedModelValue(options, context.globalConfig?.fast_model) || primary;
  return { options, primary, fast };
}

export const claudeCodeAdapter: AgentAccessAdapter = {
  id: "claude-code",
  installationName: () => "Claude Code",
  configStatuses: () => [],
  // Claude Code 不再有 1M 长上下文等派生能力；高级配置区为空。
  configControls: () => [],
  applyOptions: (context) => {
    const { primary, fast } = currentModels(context);
    return modelSelectionOptions(primary, fast);
  },
  manualSnippets: (context) => {
    const options = modelOptions(context, ANTHROPIC_PROTOCOLS);
    const primary = manualModelValue(options, context.globalConfig?.primary_model);
    const fast = manualModelValue(options, context.globalConfig?.fast_model) || primary;
    const value = (authToken: string) => JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: context.endpoint,
        ANTHROPIC_AUTH_TOKEN: authToken,
        ANTHROPIC_MODEL: primary,
        ANTHROPIC_DEFAULT_FABLE_MODEL: primary,
        ANTHROPIC_DEFAULT_OPUS_MODEL: primary,
        ANTHROPIC_DEFAULT_SONNET_MODEL: primary,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: fast,
        ANTHROPIC_SMALL_FAST_MODEL: fast,
        CLAUDE_CODE_SUBAGENT_MODEL: fast,
      },
    }, null, 2);
    return [{
      label: context.t("settings.json 配置片段"),
      displayValue: value(context.displayedToken),
      copyValue: value(context.token),
    }];
  },
  modelSelectors: (context) => {
    const { options, primary, fast } = currentModels(context);
    return [
      {
        id: "primary",
        label: context.t("主模型"),
        value: primary,
        options,
        applyOptions: (value) => modelSelectionOptions(value, fast),
      },
      {
        id: "fast",
        label: context.t("快速模型"),
        value: fast,
        options,
        applyOptions: (value) => modelSelectionOptions(primary, value),
      },
    ];
  },
};
