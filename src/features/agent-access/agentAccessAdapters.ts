import type { AgentGlobalConfigOptions, AgentGlobalConfigReport, AgentSurface } from "../../domains/agent/types";
import type { AgentGlobalConfigAdapterId } from "../../domains/pluginRegistry";
import { claudeCodeAdapter } from "./agent-access-adapters/claudeCode";
import { codexAdapter } from "./agent-access-adapters/codex";
import { openCodeAdapter } from "./agent-access-adapters/openCode";
import { piAdapter } from "./agent-access-adapters/pi";
import { deepSeekHarnessAdapter } from "./agent-access-adapters/deepSeekHarness";

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
  applyOptions: (checked: boolean) => AgentGlobalConfigOptions;
};

export type AgentAccessAdapter = {
  id: AgentGlobalConfigAdapterId;
  installationName: (surface: AgentSurface | undefined) => string;
  configStatuses: (context: AgentAccessContext) => AgentConfigStatus[];
  configControls: (context: AgentAccessContext) => AgentConfigControl[];
  applyOptions: (context: AgentAccessContext) => AgentGlobalConfigOptions | undefined;
  manualSnippets: (context: AgentAccessContext) => ManualSnippet[];
};

const ADAPTERS: Record<AgentGlobalConfigAdapterId, AgentAccessAdapter> = {
  "claude-code": claudeCodeAdapter,
  opencode: openCodeAdapter,
  pi: piAdapter,
  codex: codexAdapter,
  "deepseek-harness": deepSeekHarnessAdapter,
};

export function agentAccessAdapter(adapterId: AgentGlobalConfigAdapterId): AgentAccessAdapter {
  const adapter = ADAPTERS[adapterId];
  if (!adapter) throw new Error(`Agent access adapter is not registered: ${adapterId}`);
  return adapter;
}
