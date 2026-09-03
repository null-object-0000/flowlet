import type { AgentGlobalConfigOptions, AgentGlobalConfigReport, AgentSurface } from "../../domains/agent/types";
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

export type AgentAccessContext = {
  endpoint: string;
  token: string;
  displayedToken: string;
  globalConfig?: AgentGlobalConfigReport;
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

/** 可选的默认模型选择器（如 Hermes 的 flowlet-pro / flowlet-flash）。 */
export type AgentModelSelector = {
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
  modelSelector?: (context: AgentAccessContext) => AgentModelSelector | undefined;
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
