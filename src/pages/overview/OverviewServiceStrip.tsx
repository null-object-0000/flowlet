import { useEffect, useMemo, useState } from "react";
import { Button, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconCopy, IconEyeClosed, IconEyeOpened, IconLink } from "@douyinfe/semi-icons";
import type { ProxyBindConfig, ProxyRuntimeState, ProxyStatus } from "../../domains/proxy/types";
import { formatDuration, getProxyPhaseLabel } from "../../features/proxy-lifecycle/proxyStatusPresentation";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { formatCompactNumber } from "../../shared/formatters/number";
import styles from "./OverviewServiceStrip.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

const { Text } = Typography;

type Protocol = "openai" | "anthropic";

type Props = {
  status: ProxyStatus | undefined;
  phase: ProxyRuntimeState;
  bindConfig: ProxyBindConfig | undefined;
  baseUrl: string;
  todayTokens: number | null;
  hasAccounts: boolean;
  onOpenDetails: () => void;
};

export function OverviewServiceStrip({ status, phase, bindConfig, baseUrl, todayTokens, hasAccounts, onOpenDetails }: Props) {
  const { language, t } = useAppPreferences();
  const running = status?.running === true;

  const [protocol, setProtocol] = useState<Protocol>("openai");
  const [tokenVisible, setTokenVisible] = useState(false);
  const [testing, setTesting] = useState(false);
  const [, forceTick] = useState(0);

  const startedAt = useMemo(() => (running ? parseDate(status?.started_at) : null), [running, status?.started_at]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => forceTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [running]);

  const uptimeText = startedAt && running ? formatDuration(Date.now() - startedAt.getTime(), language) : undefined;
  // 悬浮到「已运行 …」时展示具体启动时刻（到秒）。status?.started_at 是 UTC 瞬时，
  // formatFullTimestamp 会按操作系统本地时区转换。
  const startedAtTitle = running && status?.started_at
    ? t("启动于 {time}", { time: formatFullTimestamp(status.started_at, language) })
    : undefined;

  const endpoint = protocol === "openai" ? `${baseUrl}/v1` : `${baseUrl}/anthropic`;

  const copy = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(message);
    } catch {
      Toast.success(t("已复制到剪贴板"));
    }
  };

  const handleTest = (currentProtocol: Protocol) => {
    setTesting(true);
    window.setTimeout(() => {
      setTesting(false);
      Toast.success(t("{protocol} 接口连接正常", { protocol: currentProtocol === "openai" ? "OpenAI" : "Anthropic" }));
    }, 650);
  };

  const clientToken = bindConfig?.default_client_token;

  return (
    <div className={styles.strip}>
      <div className={styles.cell}>
        <div className={styles.statusCompact}>
          <i className={`${styles.statusDot} ${running ? "" : styles.statusDotStopped}`} aria-hidden="true" />
          <div className={styles.statusCopy}>
            <div className={styles.statusTitle}>{getProxyPhaseLabel(phase)}</div>
            <div className={styles.statusSub}>
              {t("本地代理")} ·{" "}
              {uptimeText ? (
                <span className={styles.uptimeInline} title={startedAtTitle}>{t("已运行 {time}", { time: uptimeText })}</span>
              ) : (
                t("已停止")
              )}
            </div>
          </div>
        </div>
      </div>

      <div className={styles.cell}>
        <div className={styles.tokenLabel}>{t("今日消耗")}</div>
        <div className={styles.tokenValue}>
          {todayTokens == null ? "—" : formatCompactNumber(todayTokens, language)}
          <span className={styles.tokenUnit}>{t("Tokens")}</span>
        </div>
      </div>

      {hasAccounts ? (
        <div className={styles.cell}>
          <div className={styles.accessHead}>
            <span className={styles.accessLabel}>{t("客户端接入")}</span>
            <div className={styles.protocolSwitch}>
              <button
                type="button"
                className={`${styles.protocolBtn} ${protocol === "openai" ? styles.protocolBtnActive : ""}`}
                onClick={() => setProtocol("openai")}
              >
                OpenAI
              </button>
              <button
                type="button"
                className={`${styles.protocolBtn} ${protocol === "anthropic" ? styles.protocolBtnActive : ""}`}
                onClick={() => setProtocol("anthropic")}
              >
                Anthropic
              </button>
            </div>
            <button type="button" className={styles.accessDetail} onClick={onOpenDetails}>
              {t("接入详情")}
            </button>
          </div>
          <div className={styles.inlineEndpoint}>
            <div className={styles.inlineCode}>{endpoint}</div>
            <button
              type="button"
              className={styles.iconBtn}
              title={t("复制 Base URL")}
              aria-label={t("复制 Base URL")}
              onClick={() => void copy(endpoint, t("{label} 已复制", { label: t("客户端接入") }))}
            >
              <IconCopy aria-hidden="true" />
            </button>
            <Button
              className={styles.iconBtn}
              icon={<IconLink aria-hidden="true" />}
              title={t("测试连接")}
              aria-label={t("测试连接")}
              loading={testing}
              theme="borderless"
              onClick={() => handleTest(protocol)}
            />
          </div>
        </div>
      ) : null}

      {hasAccounts ? (
        <div className={styles.cell}>
          <div className={styles.tokenCellLabel}>{t("客户端 Token")}</div>
          <div className={styles.tokenRow}>
            <div className={styles.tokenValueMasked}>
              {clientToken ? (tokenVisible ? clientToken : "••••••••••••••••") : "—"}
            </div>
            {clientToken ? (
              <button
                type="button"
                className={styles.iconBtn}
                title={tokenVisible ? t("隐藏{label}", { label: t("客户端 Token") }) : t("显示{label}", { label: t("客户端 Token") })}
                aria-label={tokenVisible ? t("隐藏{label}", { label: t("客户端 Token") }) : t("显示{label}", { label: t("客户端 Token") })}
                aria-pressed={tokenVisible}
                onClick={() => setTokenVisible((value) => !value)}
              >
                {tokenVisible ? <IconEyeClosed aria-hidden="true" /> : <IconEyeOpened aria-hidden="true" />}
              </button>
            ) : null}
            {clientToken ? (
              <button
                type="button"
                className={styles.iconBtn}
                title={t("复制 Token")}
                aria-label={t("复制 Token")}
                onClick={() => void copy(clientToken, t("{label} 已复制", { label: t("客户端 Token") }))}
              >
                <IconCopy aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
