import {
  LogFilter,
  LogMeta,
  LogPage,
  ModelPrice,
  RequestLogRow,
  UsageSummaryRow,
  createModelPrice,
} from "../../domain";
import { runCommand } from "../../services/flowletApi";
import { ActionContext } from "./types";

export function createUsageActions({ data, setMessage }: ActionContext) {
  const {
    channels,
    prices,
    setPrices,
    setUsageRows,
    setRequestLogs,
    setLogMeta,
    setLogDetail,
  } = data;

  async function savePrices() {
    const filtered = prices.filter((p) => p.upstream_model.trim() && p.channel_id.trim());
    await runCommand("save_model_prices", { prices: filtered });
    setPrices(filtered);
    setMessage("价格表已保存");
  }

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

  function addPrice() {
    const channelId = channels[0]?.id ?? "longcat";
    setPrices((current) => [...current, createModelPrice(channelId, current.length)]);
  }

  function updatePrice(index: number, patch: Partial<ModelPrice>) {
    setPrices((current) =>
      current.map((p, i) => (i === index ? { ...p, ...patch, updated_at: new Date().toISOString() } : p))
    );
  }

  function removePrice(index: number) {
    setPrices((current) => current.filter((_, i) => i !== index));
  }

  return {
    savePrices,
    refreshUsage,
    refreshLogs,
    refreshLogsWithFilter: refreshLogs,
    analyzeUsage,
    addPrice,
    updatePrice,
    removePrice,
    fetchLogDetail,
    clearLogDetail,
  };
}
