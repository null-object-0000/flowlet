import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AgentDataSyncResult, AgentSyncStatusReport, BackgroundJobDetail, BackgroundJobsFilter, BackgroundJobsPage, CleanupBackgroundJobsResult, CodexAccountSyncResult, ModelsCnSyncResult } from "./types";

export const backgroundTaskCommands = {
  list: (filter: BackgroundJobsFilter) => invokeCommand<BackgroundJobsPage>("list_background_jobs", { filter: { page: filter.page, page_size: filter.pageSize, status: filter.status, job_type: filter.jobType, trigger_source: filter.triggerSource } }).catch((error) => { throw toAppError(error, "task_list_failed"); }),
  detail: (jobId: string) => invokeCommand<BackgroundJobDetail>("get_background_job_detail", { jobId }).catch((error) => { throw toAppError(error, "task_detail_failed"); }),
  syncAgentData: (force: boolean, triggerSource: string) => invokeCommand<AgentDataSyncResult>("sync_agent_data", { force, triggerSource }, 120_000).catch((error) => { throw toAppError(error, "agent_sync_failed"); }),
  syncCodexAccounts: (triggerSource: string) => invokeCommand<CodexAccountSyncResult>("sync_codex_accounts", { triggerSource }, 120_000).catch((error) => { throw toAppError(error, "codex_account_sync_failed"); }),
  agentSyncStatus: () => invokeCommand<AgentSyncStatusReport>("get_agent_sync_status").catch((error) => { throw toAppError(error, "agent_sync_status_failed"); }),
  cancel: (jobId: string) => invokeCommand<boolean>("cancel_background_job", { jobId }).catch((error) => { throw toAppError(error, "task_cancel_failed"); }),
  cleanup: (keepDays: number) => invokeCommand<CleanupBackgroundJobsResult>("cleanup_background_jobs", { keepDays }).catch((error) => { throw toAppError(error, "task_cleanup_failed"); }),
  syncModelsCnCatalog: (sourceUrl: string, triggerSource: string) => invokeCommand<ModelsCnSyncResult>("sync_models_cn_catalog", { sourceUrl, triggerSource }, 60_000).catch((error) => { throw toAppError(error, "models_cn_sync_failed"); }),
  getModelsCnCatalog: () => invokeCommand<string | null>("get_models_cn_catalog").catch((error) => { throw toAppError(error, "models_cn_catalog_read_failed"); }),
  getModelsCnCurrencies: () => invokeCommand<Array<[string, string]>>("get_models_cn_currencies").catch((error) => { throw toAppError(error, "models_cn_currencies_failed"); }),
};
