import React from "react";
import { ActionIcon, Badge, Group, Text, Tooltip } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { Panel } from "../../components/ui";
import { ProxyBindConfig, ProxyStatus } from "../../domain";
import styles from "./ProxyStatusCard.module.css";

type ConfigurationStatus = "unconfigured" | "no_models" | "ready";

type ProxyStatusCardProps = {
  status: ProxyStatus;
  bindConfig: ProxyBindConfig;
  proxyStarting: boolean;
  proxyStartError: string | null;
  autoStartAttempted: boolean;
  configurationStatus: ConfigurationStatus;
};

/** RFC3339 字符串转换为 YYYY-MM-DD HH:mm:ss（与前端展示风格一致）。 */
function formatRfc3339(value?: string | null): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "-";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}天 ${hours}小时 ${minutes}分钟`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  return `${minutes}分钟`;
}

function StatusSignal({ running }: { running: boolean }) {
  return (
    <div className={running ? styles.signal + " " + styles.running : styles.signal} aria-hidden="true">
      <svg viewBox="0 0 64 64">
        <path d="M10 34h10l5-15 10 30 7-20h12" />
      </svg>
    </div>
  );
}

export function ProxyStatusCard({
  status,
  bindConfig,
  proxyStarting,
  proxyStartError,
  autoStartAttempted,
  configurationStatus,
}: ProxyStatusCardProps) {
  const [observedStartedAt, setObservedStartedAt] = React.useState<Date | null>(status.running ? new Date() : null);
  const [, forceTick] = React.useState(0);

  // 当后端回传的 running / started_at 状态变化时同步本地显示起点。
  React.useEffect(() => {
    if (status.running) {
      const backendStamp = status.started_at;
      if (backendStamp && observedStartedAt) {
        const observedIso = observedStartedAt.toISOString();
        if (observedIso !== backendStamp) setObservedStartedAt(new Date(backendStamp));
      }
      if (!observedStartedAt && !backendStamp) setObservedStartedAt(new Date());
    } else {
      if (observedStartedAt) setObservedStartedAt(null);
    }
  }, [status.running, status.started_at]); // eslint-disable-line react-hooks/exhaustive-deps

  // 运行时长每 30 秒刷新一次显示。
  React.useEffect(() => {
    const timer = window.setInterval(() => forceTick((value) => value + 1), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const port = bindConfig.port || Number(status.bind_addr.split(":").pop()) || 18640;
  const proxyPhase = proxyStarting ? "starting" : proxyStartError ? "failed" : status.running ? "running" : "stopped";

  // 启动时间：优先复用后端提供的真实启动时间（跨会话保持），回退本地观察到 running 的时刻。
  const startedAtDate = status.started_at ? new Date(status.started_at) : observedStartedAt;
  const statusMetrics: Array<{ label: string; value: string; hint?: string }> = [
    { label: "监听地址", value: status.running ? bindConfig.host || "127.0.0.1" : "-" },
    { label: "端口", value: String(port) },
    {
      label: "运行时长",
      value: startedAtDate ? formatDuration(Date.now() - startedAtDate.getTime()) : "-",
      hint: startedAtDate ? `启动时间：${formatRfc3339(startedAtDate.toISOString())}` : undefined,
    },
  ];

  const proxyHint = proxyPhase === "failed"
    ? `错误原因：${proxyStartError}`
    : proxyPhase === "starting"
      ? "正在启动本地代理服务…"
      : proxyPhase === "stopped"
        ? autoStartAttempted ? "代理服务已停止，可重新启动。" : "等待启动代理服务。"
        : configurationStatus === "unconfigured"
          ? "代理服务已启动，但尚未配置渠道账号，当前没有可用模型。"
          : configurationStatus === "no_models"
            ? "渠道账号已配置，请开放至少一个模型后开始使用。"
            : "服务正在监听本地请求";

  return (
    <Panel className={styles.card}>
      <div className={styles.layout}>
        <div className={styles.intro}>
          <Group gap="xs">
            <h3>代理服务状态</h3>
            <Badge color={proxyPhase === "running" ? "green" : proxyPhase === "failed" ? "red" : "orange"} variant="light">
              {proxyPhase === "running" ? "运行中" : proxyPhase === "starting" ? "正在启动" : proxyPhase === "failed" ? "启动失败" : "已停止"}
            </Badge>
          </Group>
          <Text size="sm" className={proxyPhase === "running" ? styles.stateText + " " + styles.running : proxyPhase === "failed" ? styles.stateText + " " + styles.failed : styles.stateText}>
            {proxyHint}
          </Text>
        </div>
        <div className={styles.metrics}>
          {statusMetrics.map((item) => (
            <div className={styles.metric} key={item.label}>
              <span>{item.label}</span>
              <div className={styles.metricValue}>
                <strong>{item.value}</strong>
                {item.hint ? (
                  <Tooltip label={item.hint} withArrow position="top">
                    <ActionIcon className={styles.hintIcon} variant="transparent" size="xs" aria-label="启动时间提示">
                      <IconInfoCircle size={13} />
                    </ActionIcon>
                  </Tooltip>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        <StatusSignal running={status.running} />
      </div>
    </Panel>
  );
}
