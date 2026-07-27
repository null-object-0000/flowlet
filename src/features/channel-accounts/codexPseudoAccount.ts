import type { CodexAccountReport, CodexUsageWindow } from "../../domains/agent/types";
import type { ChannelAccount } from "../../domains/account/types";
import { CHATGPT_CHANNEL_ID } from "../../domains/channel/types";
import { formatFullTimestamp } from "../../shared/formatters/datetime";

/**
 * 将一个 Codex 账号报告（来自 Rust `list_cached_codex_accounts`）
 * 转换为可插入渠道账号列表的伪 ChannelAccount 对象。
 *
 * 伪账号不可编辑、不参与路由、仅用于概览页底部非交互展示。
 */
export function codexAccountToPseudoChannelAccount(
  report: CodexAccountReport,
  index: number,
): ChannelAccount {
  const now = new Date().toISOString();
  return {
    id: `codex-${report.account_id}`,
    channel_id: CHATGPT_CHANNEL_ID,
    name: report.email || "ChatGPT 账号",
    api_key: "",
    enabled: true,
    priority: -1000 - index, // 远低于正常账号优先级，确保排在最后
    remark: null,
    resource_mode: "codex",
    resource_sync_mode: "auto",
    base_url_override: null,
    anthropic_base_url_override: null,
    last_used_at: null,
    last_error: report.error ?? null,
    credential_status: report.stale ? "invalid_key" : "healthy",
    synced_models: null,
    models_synced_at: null,
    exposed_models: null,
    created_at: report.updated_at,
    updated_at: now,
  };
}

/**
 * 从 Codex 用量窗口中提取展示信息。
 * 与 Qwen Token Plan 类似：主列显示周用量，副列显示 5 小时用量。
 */
export function getCodexUsageDisplay(
  report: CodexAccountReport,
  t: (source: string, variables?: Record<string, string | number>) => string,
  language: "zh-CN" | "en-US",
): { value: string; secondary: string; resetAt: string | null } {
  const primary = getWindowLabel(report.primary, t);
  const secondary = getWindowLabel(report.secondary, t);
  // 用量窗口重置时间：优先 primary，其次 secondary。
  const resetWindow = report.primary ?? report.secondary;
  const resetAt = resetWindow?.resets_at
    ? formatFullTimestamp(new Date(resetWindow.resets_at * 1000).toISOString(), language)
    : null;
  return { value: primary, secondary, resetAt };
}

function getWindowLabel(
  window: CodexUsageWindow | null | undefined,
  t: (source: string, variables?: Record<string, string | number>) => string,
): string {
  if (!window) return "";
  const remaining = Math.max(0, Math.round(100 - window.used_percent));
  const label =
    window.window_duration_mins <= 360
      ? t("5小时用量剩余 {percent}%", { percent: remaining })
      : t("每周用量剩余 {percent}%", { percent: remaining });
  return label;
}

/**
 * 从 Codex 账号提取名称行附加信息（套餐类型）。
 */
export function getCodexNameSummary(report: CodexAccountReport): string {
  if (report.plan_type) {
    return formatPlanLabel(report.plan_type);
  }
  return "";
}

function formatPlanLabel(plan: string): string {
  const labels: Record<string, string> = {
    free: "Free",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
  };
  return labels[plan.toLowerCase()] || plan;
}
