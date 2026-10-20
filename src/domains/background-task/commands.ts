import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AgentDataSyncResult, AgentSyncStatusReport, CatalogSyncResult, CodexAccountSyncResult } from "./types";

export const backgroundTaskCommands = {
  syncAgentData: (force: boolean, triggerSource: string) => invokeCommand<AgentDataSyncResult>("sync_agent_data", { force, triggerSource }, 120_000).catch((error) => { throw toAppError(error, "agent_sync_failed"); }),
  syncCodexAccounts: (triggerSource: string) => invokeCommand<CodexAccountSyncResult>("sync_codex_accounts", { triggerSource }, 120_000).catch((error) => { throw toAppError(error, "codex_account_sync_failed"); }),
  agentSyncStatus: () => invokeCommand<AgentSyncStatusReport>("get_agent_sync_status").catch((error) => { throw toAppError(error, "agent_sync_status_failed"); }),
  syncModelsCnCatalog: (sourceUrl: string, triggerSource: string) => invokeCommand<CatalogSyncResult>("sync_models_cn_catalog", { sourceUrl, triggerSource }, 60_000).catch((error) => { throw toAppError(error, "models_cn_sync_failed"); }),
  syncModelsDevCatalog: (sourceUrl: string, triggerSource: string) => invokeCommand<CatalogSyncResult>("sync_models_dev_catalog", { sourceUrl, triggerSource }, 60_000).catch((error) => { throw toAppError(error, "models_dev_sync_failed"); }),
  getModelsCnCatalog: () => invokeCommand<string | null>("get_models_cn_catalog").catch((error) => { throw toAppError(error, "models_cn_catalog_read_failed"); }),
  getModelsDevProviderCatalog: (providerId: string) => invokeCommand<string | null>("get_models_dev_provider_catalog", { providerId }).catch((error) => { throw toAppError(error, "models_dev_catalog_read_failed"); }),
  getModelsCnCurrencies: () => invokeCommand<Array<[string, string]>>("get_models_cn_currencies").catch((error) => { throw toAppError(error, "models_cn_currencies_failed"); }),
};
