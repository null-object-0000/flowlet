import { IconChevronDown, IconChevronUp, IconDesktop } from "@douyinfe/semi-icons";
import { useState } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { SyncedAgentProfile } from "../../domains/device-sync/types";
import { useMobileDeviceAgents, useMobileDevices } from "../../features/device-sync/useMobileDeviceSync";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import { AgentBrandMark } from "../../shared/ui/AgentBrandMark";
import styles from "./MobilePage.module.css";

export function MobileDevicesPage() {
  const { language, t } = useAppPreferences();
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const devices = useMobileDevices();

  return (
    <section className={styles.page}>
      <header className={styles.heading}>
        <div>
          <h2>{t("设备")}</h2>
          <p>{t("查看同步设备、已安装 Agent 及其 Flowlet 接入状态")}</p>
        </div>
      </header>

      {devices.isLoading ? (
        <div className={`${styles.card} ${styles.state}`}><span>{t("正在加载设备…")}</span></div>
      ) : null}
      {devices.isError ? (
        <div className={`${styles.card} ${styles.state}`}>
          <strong>{t("设备加载失败")}</strong>
          <span>{devices.error.message}</span>
        </div>
      ) : null}
      {!devices.isLoading && !devices.isError && (devices.data?.length ?? 0) === 0 ? (
        <div className={`${styles.card} ${styles.state}`}>
          <strong>{t("暂无设备")}</strong>
          <span>{t("请先配置 S3 并执行刷新。")}</span>
        </div>
      ) : null}

      <div className={styles.deviceList}>
        {(devices.data ?? []).map((device) => {
          const expanded = expandedDeviceId === device.deviceId;
          return (
            <article className={styles.deviceCard} key={device.deviceId}>
              <button
                type="button"
                className={styles.deviceToggle}
                aria-expanded={expanded}
                aria-controls={`device-agents-${device.deviceId}`}
                onClick={() => setExpandedDeviceId(expanded ? null : device.deviceId)}
              >
                <span className={styles.deviceIcon} aria-hidden="true"><IconDesktop /></span>
                <span className={styles.deviceIdentity}>
                  <strong>{device.displayName}</strong>
                  <small>{platformLabel(device.platform)} · Flowlet {device.appVersion}</small>
                </span>
                <span className={styles.deviceChevron} aria-hidden="true">
                  {expanded ? <IconChevronUp /> : <IconChevronDown />}
                </span>
                <span className={styles.deviceMetrics}>
                  <span>{formatCompactNumber(device.knownTokens, language)} Tokens</span>
                  <span>{t("{count} 次请求", { count: formatInteger(device.requestCount, language) })}</span>
                </span>
                <time>{t("最近快照：{time}", { time: formatFullTimestamp(device.lastSeenAt, language) })}</time>
              </button>
              {expanded ? <DeviceAgents deviceId={device.deviceId} /> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function DeviceAgents({ deviceId }: { deviceId: string }) {
  const { t } = useAppPreferences();
  const agents = useMobileDeviceAgents(deviceId);
  const installedAgents = (agents.data ?? []).filter((agent) => agent.installed);

  return (
    <div className={styles.deviceDetails} id={`device-agents-${deviceId}`}>
      <div className={styles.deviceDetailsHeader}>
        <strong>{t("已安装 Agent")}</strong>
        {!agents.isLoading && !agents.isError ? <span>{installedAgents.length}</span> : null}
      </div>
      {agents.isLoading ? <div className={styles.deviceDetailsState}>{t("正在读取 Agent 状态…")}</div> : null}
      {agents.isError ? <div className={styles.deviceDetailsState} data-error="true">{agents.error.message}</div> : null}
      {!agents.isLoading && !agents.isError && installedAgents.length === 0 ? (
        <div className={styles.deviceDetailsState}>{t("未检测到已安装的 Agent")}</div>
      ) : null}
      {installedAgents.map((agent) => <AgentRow key={agent.agentId} agent={agent} />)}
    </div>
  );
}

function AgentRow({ agent }: { agent: SyncedAgentProfile }) {
  const { t } = useAppPreferences();
  const status = agentConnectionStatus(agent, t);
  return (
    <div className={styles.installedAgent}>
      <AgentBrandMark agentId={agent.agentId} />
      <div className={styles.installedAgentMain}>
        <strong>{agent.agentName}</strong>
        <span>{agent.installations.map((installation) => installationLabel(installation, t)).join(" · ")}</span>
      </div>
      <span className={styles.agentConnection} data-state={status.state}>
        <i />{status.label}
      </span>
    </div>
  );
}

type Translate = (source: string, variables?: Record<string, string | number>) => string;

function agentConnectionStatus(agent: SyncedAgentProfile, t: Translate) {
  switch (agent.flowletConfigState) {
    case "flowlet": return { label: t("已接入 Flowlet"), state: "success" };
    case "partial": return { label: t("部分接入 Flowlet"), state: "partial" };
    case "other_gateway": return { label: t("已接入其它网关"), state: "neutral" };
    case "invalid": return { label: t("配置异常"), state: "failed" };
    case "not_configured":
      return agent.flowletObserved
        ? { label: t("近期通过 Flowlet"), state: "observed" }
        : { label: t("未接入 Flowlet"), state: "neutral" };
    default:
      return agent.flowletObserved
        ? { label: t("近期通过 Flowlet"), state: "observed" }
        : { label: t("暂未观测到 Flowlet 请求"), state: "neutral" };
  }
}

function installationLabel(installation: SyncedAgentProfile["installations"][number], t: Translate) {
  const surface = installation.surface === "desktop" ? t("桌面端") : "CLI";
  return installation.version ? `${surface} ${installation.version}` : surface;
}

function platformLabel(platform: string) {
  if (/windows/i.test(platform)) return "Windows";
  if (/darwin|macos/i.test(platform)) return "macOS";
  if (/linux/i.test(platform)) return "Linux";
  return platform || "Desktop";
}
