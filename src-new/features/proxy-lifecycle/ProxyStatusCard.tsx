import { useEffect, useState } from "react";
import { Button, Card, Typography } from "@douyinfe/semi-ui-19";
import { IconPlay, IconRefresh } from "@douyinfe/semi-icons";
import type { ConfigurationStatus } from "../../domains/model/types";
import type { ProxyBindConfig, ProxyRuntimeState, ProxyStatus } from "../../domains/proxy/types";
import {
  formatDuration,
  formatRfc3339,
  getProxyHint,
  getProxyPhaseLabel,
} from "./proxyStatusPresentation";
import styles from "./ProxyStatusCard.module.css";
import secondaryButtonStyles from "../../shared/ui/SecondaryButton.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { translate } from "../../app/preferences/translations";

const { Text } = Typography;

type Props = {
  status: ProxyStatus;
  bindConfig?: ProxyBindConfig;
  phase: ProxyRuntimeState;
  errorMessage?: string | null;
  autoStartAttempted: boolean;
  configurationStatus: ConfigurationStatus;
  actionLabel: string;
  actionBusy: boolean;
  actionDisabled: boolean;
  onAction: () => void;
};

export function ProxyStatusCard({
  status,
  bindConfig,
  phase,
  errorMessage,
  autoStartAttempted,
  configurationStatus,
  actionLabel,
  actionBusy,
  actionDisabled,
  onAction,
}: Props) {
  const { language, t } = useAppPreferences();
  const [observedStartedAt, setObservedStartedAt] = useState<Date | null>(status.running ? new Date() : null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!status.running) {
      setObservedStartedAt(null);
      return;
    }
    const backendStartedAt = parseDate(status.started_at);
    setObservedStartedAt((current) => backendStartedAt ?? current ?? new Date());
  }, [status.running, status.started_at]);

  useEffect(() => {
    const timer = window.setInterval(() => forceTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const port = bindConfig?.port || Number(status.bind_addr.split(":").pop()) || 18_640;
  const startedAt = parseDate(status.started_at) ?? observedStartedAt;
  const metrics = [
    { label: t("监听地址"), value: status.running ? `${bindConfig?.host || "127.0.0.1"}:${port}` : "-" },
    {
      label: t("运行时长"),
      value: startedAt ? formatDuration(Date.now() - startedAt.getTime(), language) : "-",
      hint: startedAt ? t("启动于 {time}", { time: formatRfc3339(startedAt.toISOString()) }) : undefined,
    },
  ];

  return (
    <Card className={styles.card} bodyStyle={{ padding: 0 }}>
      <div className={styles.layout}>
        <div className={`${styles.statusOrb} ${status.running ? styles.runningOrb : ""}`}><i /></div>
        <div className={styles.intro}>
          <h3>{getServiceTitle(phase, language)}</h3>
          <Text
            size="small"
            className={`${styles.stateText} ${phase === "running" ? styles.running : ""} ${phase === "failed" ? styles.failed : ""}`}
          >
            {getProxyHint(phase, configurationStatus, autoStartAttempted, errorMessage, language)}
          </Text>
        </div>

        <div className={styles.metrics}>
          {metrics.map((metric) => (
            <div className={styles.metric} key={metric.label} title={metric.hint}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
            </div>
          ))}
        </div>
        <Button
          className={`${secondaryButtonStyles.button} ${secondaryButtonStyles.regular}`}
          aria-label={actionLabel}
          icon={phase === "running" ? <IconRefresh /> : <IconPlay />}
          type="tertiary"
          loading={actionBusy}
          disabled={actionDisabled}
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      </div>
    </Card>
  );
}

function getServiceTitle(phase: ProxyRuntimeState, language: "zh-CN" | "en-US") {
  if (phase === "running") return translate(language, "服务运行正常");
  if (phase === "starting") return translate(language, "服务正在启动");
  if (phase === "failed") return translate(language, "服务启动失败");
  return translate(language, "服务已停止");
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
