import {
  LogFilter,
  LogMeta,
  LogPage,
  RequestLogRow,
  UsageSummaryRow,
} from "../../domain";
import { runCommand } from "../../services/flowletApi";
import { ActionContext } from "./types";

export function createUsageActions({ data, setMessage }: ActionContext) {
  const {
    setUsageRows,
    setRequestLogs,
    setLogMeta,
    setLogDetail,
  } = data;

  async function refreshUsage() {
    const rows = await runCommand<UsageSummaryRow[]>("usage_summary");
    setUsageRows(rows);
  }

  async function refreshLogs(filter?: LogFilter) {
    const f = filter ?? { page: 1, pageSize: 50, status: "all", client: "", channel: "", search: "" };
    const page = await runCommand<LogPage>("list_request_logs", {
      filter: {
        page: f.page,
        page_size: f.pageSize,
        status: f.status,
        client_id: f.client,
        channel_id: f.channel,
        search: f.search,
      },
    });
    setRequestLogs(page.rows);
    setLogMeta({
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      lastFetchedAt: Date.now(),
    });
  }

  async function fetchLogDetail(requestId: string) {
    const rows = await runCommand<RequestLogRow[]>("get_request_log_detail", {
      request_id: requestId,
    });
    setLogDetail(rows);
  }

  function clearLogDetail() {
    setLogDetail(null);
  }

  async function analyzeUsage() {
    const count = await runCommand<number>("analyze_usage");
    await refreshUsage();
    setMessage(`离线分析完成，新增 ${count} 条用量记录`);
  }

  return {
    refreshUsage,
    refreshLogs,
    refreshLogsWithFilter: refreshLogs,
    analyzeUsage,
    fetchLogDetail,
    clearLogDetail,
  };
}
