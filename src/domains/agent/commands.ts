import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AgentEnvironmentReport, AgentGlobalConfigReport, CodexAccountsReport } from "./types";

export function detectAgentEnvironment(agentId: string): Promise<AgentEnvironmentReport> {
  return invokeCommand<AgentEnvironmentReport>("detect_agent_environment", { agentId }, 10_000).catch((error) => {
    throw toAppError(error, "agent_environment_detection_failed");
  });
}

export function detectClaudeCodeEnvironment(): Promise<AgentEnvironmentReport> {
  return detectAgentEnvironment("claude-code");
}

export function detectOpenCodeEnvironment(): Promise<AgentEnvironmentReport> {
  return detectAgentEnvironment("opencode");
}

export function detectChatGptDesktopEnvironment(): Promise<AgentEnvironmentReport> {
  return detectAgentEnvironment("chatgpt-desktop");
}

export function queryCodexAccounts(): Promise<CodexAccountsReport> {
  return invokeCommand<CodexAccountsReport>("query_codex_accounts", undefined, 60_000).catch((error) => {
    throw toAppError(error, "codex_account_query_failed");
  });
}

export function inspectAgentGlobalConfig(agentId: string): Promise<AgentGlobalConfigReport> {
  return invokeCommand<AgentGlobalConfigReport>("inspect_agent_global_config", { agentId }).catch((error) => {
    throw toAppError(error, "agent_global_config_inspection_failed");
  });
}

export function applyAgentGlobalConfig(agentId: string): Promise<AgentGlobalConfigReport> {
  return invokeCommand<AgentGlobalConfigReport>("apply_agent_global_config", { agentId }).catch((error) => {
    throw toAppError(error, "agent_global_config_apply_failed");
  });
}

export function restoreAgentGlobalConfig(agentId: string): Promise<AgentGlobalConfigReport> {
  return invokeCommand<AgentGlobalConfigReport>("restore_agent_global_config", { agentId }).catch((error) => {
    throw toAppError(error, "agent_global_config_restore_failed");
  });
}

export function inspectClaudeCodeGlobalConfig(): Promise<AgentGlobalConfigReport> {
  return inspectAgentGlobalConfig("claude-code");
}

export function applyClaudeCodeGlobalConfig(): Promise<AgentGlobalConfigReport> {
  return applyAgentGlobalConfig("claude-code");
}

export function restoreClaudeCodeGlobalConfig(): Promise<AgentGlobalConfigReport> {
  return restoreAgentGlobalConfig("claude-code");
}

export function inspectOpenCodeGlobalConfig(): Promise<AgentGlobalConfigReport> {
  return inspectAgentGlobalConfig("opencode");
}

export function applyOpenCodeGlobalConfig(): Promise<AgentGlobalConfigReport> {
  return applyAgentGlobalConfig("opencode");
}

export function restoreOpenCodeGlobalConfig(): Promise<AgentGlobalConfigReport> {
  return restoreAgentGlobalConfig("opencode");
}
