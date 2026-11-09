import type { AgentGlobalConfigOptions } from "../../../domains/agent/types";
import { canonicalModelKey } from "../../../domains/modelCatalog/identity";
import type {
  AgentAccessContext,
  AgentModelOption,
  AgentModelProtocol,
} from "../agentAccessAdapters";

/** 无可用模型时手动片段中的占位模型 ID；一键接入此时已被禁用。 */
export const MODEL_PLACEHOLDER = "<model-id>";

export function credentialsSnippet(token: string, type: "api" | "api_key") {
  return JSON.stringify({ flowlet: { type, key: token } }, null, 2);
}

/** 按 Agent 实际写入协议过滤可用模型，标签直接使用规范模型 ID。 */
export function modelOptions(
  context: AgentAccessContext,
  protocols: readonly AgentModelProtocol[],
): AgentModelOption[] {
  return context.availableModels
    .filter((available) => available.protocols.some((protocol) => protocols.includes(protocol)))
    .map((available) => ({ label: available.model, value: available.model }));
}

/**
 * value 取值规则：globalConfig 回读值若仍在选项内就用它，否则回退第一个选项。
 * 回读值可能带 provider 前缀（OpenCode 的 `flowlet/<model>`），比较时按规范模型 ID 归一。
 */
export function selectedModelValue(
  options: readonly AgentModelOption[],
  current: string | null | undefined,
): string {
  const key = canonicalModelKey(current);
  if (key) {
    const match = options.find((option) => canonicalModelKey(option.value) === key);
    if (match) return match.value;
  }
  return options[0]?.value ?? "";
}

/** 手动片段使用具体模型名；没有可用模型时退化为占位符（一键接入已禁用）。 */
export function manualModelValue(
  options: readonly AgentModelOption[],
  current: string | null | undefined,
): string {
  return selectedModelValue(options, current) || MODEL_PLACEHOLDER;
}

/** 组装显式模型选择参数；空值不写入，把缺省行为留给 Rust command。 */
export function modelSelectionOptions(
  primaryModel: string,
  fastModel?: string,
): AgentGlobalConfigOptions {
  return {
    ...(primaryModel ? { primaryModel } : {}),
    ...(fastModel ? { fastModel } : {}),
  };
}
