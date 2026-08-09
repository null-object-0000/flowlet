import type { CodexAccountReport } from "../../domains/agent/types";
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
    workspace_account_id: null,
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
    workspace_default_base_url: null,
    workspace_default_anthropic_base_url: null,
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
 * Codex 账号观测只展示有实际可观测数据的账号（订阅、用量、Credits 或错误）。
 *
 * Flowlet 代理 Codex 时会把 `~/.codex/auth.json` 写成 `OPENAI_API_KEY`（API Key
 * 登录态）。Codex app-server 的 `account/read` 会把该 Key 识别为一个已登录账号
 * （`auth_mode=apiKey`），但 API Key 模式拿不到任何订阅数据（email/plan/用量/
 * Credits 全空），只会渲染成一行空的「ChatGPT 账号」噪音，应过滤掉。
 * ChatGPT 订阅账号即使暂时无用量，也会有 email / plan 可展示，不会误伤。
 */
export function isObservableCodexAccount(report: CodexAccountReport): boolean {
  return Boolean(
    report.email ||
      report.plan_type ||
      report.primary ||
      report.secondary ||
      report.credits ||
      report.rate_limit_reset_credits ||
      report.error,
  );
}

/**
 * 从 Codex 用量窗口中提取展示信息。
 * 与 Qwen Token Plan 保持一致：主列显示 7 天剩余，副列显示周窗口重置时间。
 */
export function getCodexUsageDisplay(
  report: CodexAccountReport,
  t: (source: string, variables?: Record<string, string | number>) => string,
  language: "zh-CN" | "en-US",
): { value: string; secondary: string; resetAt: string | null } {
  const weeklyWindow = [report.primary, report.secondary]
    .find((window) => window && window.window_duration_mins > 360)
    ?? report.secondary
    ?? report.primary;
  const value = weeklyWindow
    ? t("7天剩余 {percent}%", {
      percent: Math.max(0, Math.round(100 - weeklyWindow.used_percent)),
    })
    : "";
  const resetAt = weeklyWindow?.resets_at
    ? formatFullTimestamp(new Date(weeklyWindow.resets_at * 1000).toISOString(), language)
    : null;
  return { value, secondary: "", resetAt };
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
