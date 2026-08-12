import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type {
  AgentEnvironmentReport,
  AgentGlobalConfigOptions,
  AgentGlobalConfigReport,
  AgentLatestVersionsReport,
  CodexAccountReport,
  CodexAccountsReport,
} from "./types";

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

export function detectPiEnvironment(): Promise<AgentEnvironmentReport> {
  return detectAgentEnvironment("pi");
}

export function detectChatGptDesktopEnvironment(): Promise<AgentEnvironmentReport> {
  return detectAgentEnvironment("codex");
}

/** 检查所有受支持 Agent 的最新发布版本（npm registry），用于版本更新提示。 */
export function checkAgentLatestVersions(): Promise<AgentLatestVersionsReport> {
  return invokeCommand<AgentLatestVersionsReport>("check_agent_latest_versions", undefined, 30_000).catch((error) => {
    throw toAppError(error, "agent_version_check_failed");
  });
}

export function queryCodexAccounts(): Promise<CodexAccountsReport> {
  return invokeCommand<CodexAccountsReport>("query_codex_accounts", undefined, 60_000).catch((error) => {
    throw toAppError(error, "codex_account_query_failed");
  });
}

export function queryCodexAccount(accountId: string): Promise<CodexAccountReport> {
  return invokeCommand<CodexAccountReport>("query_codex_account", { accountId }, 60_000).catch((error) => {
    throw toAppError(error, "codex_account_query_failed");
  });
}

export function listCachedCodexAccounts(): Promise<CodexAccountsReport> {
  return invokeCommand<CodexAccountsReport>("list_cached_codex_accounts").catch((error) => {
    throw toAppError(error, "codex_account_cache_read_failed");
  });
}

export function authorizeCodexAccount(): Promise<CodexAccountReport> {
  return invokeCommand<CodexAccountReport>("authorize_codex_account", undefined, 6 * 60_000).catch((error) => {
    throw toAppError(error, "codex_account_authorization_failed");
  });
}

export function inspectAgentGlobalConfig(agentId: string): Promise<AgentGlobalConfigReport> {
  return invokeCommand<AgentGlobalConfigReport>("inspect_agent_global_config", { agentId }).catch((error) => {
    throw toAppError(error, "agent_global_config_inspection_failed");
  });
}

export function applyAgentGlobalConfig(agentId: string, options?: AgentGlobalConfigOptions): Promise<AgentGlobalConfigReport> {
  return invokeCommand<AgentGlobalConfigReport>("apply_agent_global_config", { agentId, options }).catch((error) => {
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

export function applyClaudeCodeGlobalConfig(options?: AgentGlobalConfigOptions): Promise<AgentGlobalConfigReport> {
  return applyAgentGlobalConfig("claude-code", options);
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

export function inspectPiGlobalConfig(): Promise<AgentGlobalConfigReport> {
  return inspectAgentGlobalConfig("pi");
}

export function applyPiGlobalConfig(options?: AgentGlobalConfigOptions): Promise<AgentGlobalConfigReport> {
  return applyAgentGlobalConfig("pi", options);
}

export function restorePiGlobalConfig(): Promise<AgentGlobalConfigReport> {
  return restoreAgentGlobalConfig("pi");
}

export function inspectCodexGlobalConfig(): Promise<AgentGlobalConfigReport> {
  return inspectAgentGlobalConfig("codex");
}

export function applyCodexGlobalConfig(): Promise<AgentGlobalConfigReport> {
  return applyAgentGlobalConfig("codex");
}

export function restoreCodexGlobalConfig(): Promise<AgentGlobalConfigReport> {
  return restoreAgentGlobalConfig("codex");
}
