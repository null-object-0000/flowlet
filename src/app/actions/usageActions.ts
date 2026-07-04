import { ModelPrice, RequestLogRow, UsageSummaryRow, createModelPrice } from "../../domain";
import { runCommand } from "../../services/flowletApi";
import { ActionContext } from "./types";

export function createUsageActions({ data, setMessage }: ActionContext) {
  const { channels, prices, setPrices, setUsageRows, setRequestLogs } = data;

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

  async function refreshLogs() {
    const rows = await runCommand<RequestLogRow[]>("list_request_logs");
    setRequestLogs(rows);
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

  return { savePrices, refreshUsage, refreshLogs, analyzeUsage, addPrice, updatePrice, removePrice };
}
