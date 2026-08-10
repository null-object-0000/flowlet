import { useEffect, useMemo, useState } from "react";
import { Toast } from "@douyinfe/semi-ui-19";
import { OverviewServiceStripView, type ProductProtocol } from "@flowlet/product-ui";
import type { ProxyBindConfig, ProxyRuntimeState, ProxyStatus } from "../../domains/proxy/types";
import type { UsageTodaySummary } from "../../domains/usage/types";
import { formatDuration, getProxyPhaseLabel } from "../../features/proxy-lifecycle/proxyStatusPresentation";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { formatCompactNumber } from "../../shared/formatters/number";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

type Props = {
  status: ProxyStatus | undefined;
  phase: ProxyRuntimeState;
  bindConfig: ProxyBindConfig | undefined;
  baseUrl: string;
  todayUsage: UsageTodaySummary | null;
  onOpenUsage: () => void;
  onOpenDetails: () => void;
};

export function OverviewServiceStrip({ status, phase, bindConfig, baseUrl, todayUsage, onOpenUsage, onOpenDetails }: Props) {
  const { language, t } = useAppPreferences();
  const running = status?.running === true;
  const [, forceTick] = useState(0);
  const startedAt = useMemo(() => (running ? parseDate(status?.started_at) : null), [running, status?.started_at]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => forceTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [running]);

  const uptimeText = startedAt && running ? formatDuration(Date.now() - startedAt.getTime(), language) : undefined;
  const startedAtTitle = running && status?.started_at
    ? t("启动于 {time}", { time: formatFullTimestamp(status.started_at, language) })
    : undefined;

  const copy = async (value: string, kind: "endpoint" | "token") => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(kind === "endpoint"
        ? t("{label} 已复制", { label: t("客户端接入") })
        : t("{label} 已复制", { label: t("客户端 Token") }));
    } catch {
      Toast.success(t("已复制到剪贴板"));
    }
  };

  const test = async (protocol: ProductProtocol) => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 650));
    Toast.success(t("{protocol} 接口连接正常", { protocol: protocol === "openai" ? "OpenAI" : "Anthropic" }));
  };

  return (
    <OverviewServiceStripView
      model={{
        running,
        statusTitle: getProxyPhaseLabel(phase),
        statusSubtitle: `${t("本地代理")} · ${uptimeText ? t("已运行 {time}", { time: uptimeText }) : t("已停止")}`,
        statusTooltip: startedAtTitle,
        usageLabel: t("今日消耗"),
        usageValue: todayUsage ? formatCompactNumber(todayUsage.total_tokens, language) : "—",
        usageUnit: t("Tokens"),
        usageAriaLabel: t("今日消耗，打开用量统计"),
        accessLabel: t("客户端接入"),
        detailLabel: t("接入详情"),
        endpoints: { openai: `${baseUrl}/v1`, anthropic: `${baseUrl}/anthropic` },
        tokenLabel: t("客户端 Token"),
        clientToken: bindConfig?.default_client_token,
      }}
      labels={{
        copyBaseUrl: t("复制 Base URL"),
        testConnection: t("测试连接"),
        copyToken: t("复制 Token"),
        showToken: t("显示{label}", { label: t("客户端 Token") }),
        hideToken: t("隐藏{label}", { label: t("客户端 Token") }),
      }}
      onOpenUsage={onOpenUsage}
      onOpenDetails={onOpenDetails}
      onCopy={copy}
      onTest={test}
    />
  );
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
