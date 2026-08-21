import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type {
  AgentEnvironmentReport,
  AgentCapabilitiesReport,
  AgentGlobalConfigOptions,
  AgentGlobalConfigReport,
  AgentLatestVersionsReport,
  CodexAccountDeletionResult,
  CodexAccountReport,
  CodexAccountsReport,
} from "./types";

export function listAgentCapabilities(): Promise<AgentCapabilitiesReport> {
  return invokeCommand<AgentCapabilitiesReport>("list_agent_capabilities").catch((error) => {
    throw toAppError(error, "agent_capabilities_read_failed");
  });
}

export function detectAgentEnvironment(agentId: string): Promise<AgentEnvironmentReport> {
  return invokeCommand<AgentEnvironmentReport>("detect_agent_environment", { agentId }, 10_000).catch((error) => {
    throw toAppError(error, "agent_environment_detection_failed");
  });
}

export function startAgentRuntime(agentId: string): Promise<AgentEnvironmentReport> {
  return invokeCommand<AgentEnvironmentReport>("start_agent_runtime", { agentId }, 30_000).catch((error) => {
    throw toAppError(error, "agent_runtime_start_failed");
  });
}

export function stopAgentRuntime(agentId: string): Promise<AgentEnvironmentReport> {
  return invokeCommand<AgentEnvironmentReport>("stop_agent_runtime", { agentId }, 15_000).catch((error) => {
    throw toAppError(error, "agent_runtime_stop_failed");
  });
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

export function deleteCodexAccount(accountId: string): Promise<CodexAccountDeletionResult> {
  return invokeCommand<CodexAccountDeletionResult>("delete_codex_account", { accountId }).catch((error) => {
    throw toAppError(error, "codex_account_deletion_failed");
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
