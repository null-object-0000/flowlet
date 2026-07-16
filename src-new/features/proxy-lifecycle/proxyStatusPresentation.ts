import type { ConfigurationStatus } from "../../domains/model/types";
import type { ProxyRuntimeState } from "../../domains/proxy/types";
import { translate, type AppLanguage } from "../../app/preferences/translations";

export function formatRfc3339(value?: string | null): string {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function formatDuration(ms: number, language: AppLanguage = "zh-CN"): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (language === "en-US") {
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }
  if (days > 0) return `${days}天 ${hours}小时 ${minutes}分钟`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  return `${minutes}分钟`;
}

export function getProxyPhaseLabel(phase: ProxyRuntimeState): string {
  if (phase === "running") return "运行中";
  if (phase === "starting") return "正在启动";
  if (phase === "failed") return "启动失败";
  return "已停止";
}

export function getProxyHint(
  phase: ProxyRuntimeState,
  configurationStatus: ConfigurationStatus,
  autoStartAttempted: boolean,
  errorMessage?: string | null,
  language: AppLanguage = "zh-CN",
): string {
  if (phase === "failed") return translate(language, "错误原因：{message}", { message: errorMessage ?? translate(language, "未知错误") });
  if (phase === "starting") return translate(language, "正在启动本地代理服务…");
  if (phase === "stopped") {
    return translate(language, autoStartAttempted ? "代理服务已停止，可重新启动。" : "等待启动代理服务。");
  }
  if (configurationStatus === "unconfigured") {
    return translate(language, "代理服务已启动，但尚未配置渠道账号，当前没有可用模型。");
  }
  if (configurationStatus === "no_models") {
    return translate(language, "渠道账号已配置，请开放至少一个模型后开始使用。");
  }
  return translate(language, "本地代理正在监听请求");
}
