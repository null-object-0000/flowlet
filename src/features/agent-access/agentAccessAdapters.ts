import type { AgentGlobalConfigOptions, AgentGlobalConfigReport, AgentSurface } from "../../domains/agent/types";
import type { ModelsCnCatalog } from "../../domains/modelCatalog/types";
import type { AgentGlobalConfigAdapterId } from "../../domains/pluginRegistry";
import { claudeCodeAdapter } from "./agent-access-adapters/claudeCode";
import { codexAdapter } from "./agent-access-adapters/codex";
import { openCodeAdapter } from "./agent-access-adapters/openCode";
import { piAdapter } from "./agent-access-adapters/pi";
import { deepSeekHarnessAdapter } from "./agent-access-adapters/deepSeekHarness";
import { hermesAdapter } from "./agent-access-adapters/hermes";

export type Translate = (source: string, values?: Record<string, string | number>) => string;

export type ManualSnippet = {
  label: string;
  displayValue: string;
  copyValue: string;
};

/** 客户端协议；接入抽屉按 Agent 实际写入协议过滤可用模型。 */
export type AgentModelProtocol = "openai" | "anthropic" | "responses";

/** 当前协议下可用的开放模型：模型规范化 ID + 该模型实际承载过的协议集合。 */
export type AgentAvailableModel = {
  model: string;
  protocols: AgentModelProtocol[];
};

export type AgentAccessContext = {
  endpoint: string;
  token: string;
  displayedToken: string;
  globalConfig?: AgentGlobalConfigReport;
  /** 由接入抽屉按「启用路由 + 健康账号 + 渠道支持协议」计算的可用模型池。 */
  availableModels: AgentAvailableModel[];
  /** 本机 models-cn 目录（已解析）；仅 Codex 的模型目录片段使用，缺失时为 null。 */
  modelCatalog?: ModelsCnCatalog | null;
  t: Translate;
};

export type AgentConfigStatus = { label: string; value: string };

export type AgentConfigControl = {
  id: string;
  label: string;
  descriptions: string[];
  checked: boolean;
  requiresRestart?: boolean;
  applyOptions: (checked: boolean) => AgentGlobalConfigOptions;
};

export type AgentModelOption = { label: string; value: string };

/** 通用默认模型选择器：每个 Agent 至少一个 primary；Claude Code 额外提供 fast。 */
export type AgentModelSelectorSpec = {
  id: "primary" | "fast";
  label: string;
  /** 当前值：来自 globalConfig 回读值（若仍在选项内），否则第一个选项；无可用模型时为空串。 */
  value: string;
  options: AgentModelOption[];
  applyOptions: (value: string) => AgentGlobalConfigOptions;
};

export type AgentAccessAdapter = {
  id: AgentGlobalConfigAdapterId;
  installationName: (surface: AgentSurface | undefined) => string;
  configStatuses: (context: AgentAccessContext) => AgentConfigStatus[];
  configControls: (context: AgentAccessContext) => AgentConfigControl[];
  applyOptions: (context: AgentAccessContext) => AgentGlobalConfigOptions | undefined;
  manualSnippets: (context: AgentAccessContext) => ManualSnippet[];
  /** 默认模型选择器；选项来自可用模型池并按 Agent 写入协议过滤。纯函数，不发查询。 */
  modelSelectors: (context: AgentAccessContext) => AgentModelSelectorSpec[];
};

const ADAPTERS: Record<AgentGlobalConfigAdapterId, AgentAccessAdapter> = {
  "claude-code": claudeCodeAdapter,
  opencode: openCodeAdapter,
  pi: piAdapter,
  codex: codexAdapter,
  "deepseek-harness": deepSeekHarnessAdapter,
  hermes: hermesAdapter,
};

export function agentAccessAdapter(adapterId: AgentGlobalConfigAdapterId): AgentAccessAdapter {
  const adapter = ADAPTERS[adapterId];
  if (!adapter) throw new Error(`Agent access adapter is not registered: ${adapterId}`);
  return adapter;
}
