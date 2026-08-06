import { IconChevronDown, IconChevronRight, IconChevronUp, IconComment, IconDesktop } from "@douyinfe/semi-icons";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { LanPeerProbe } from "../../domains/device-sync/types";
import { useMobileDeviceAgents, useMobileDevices, useMobileLanProbes, useMobileSessions } from "../../features/device-sync/useMobileDeviceSync";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import { MobileLastRefreshTime } from "../MobileLastRefreshTime";
import { useMobileRefreshController } from "../useMobileRefreshController";
import { MobilePullToRefresh } from "../MobilePullToRefresh";
import styles from "./MobilePage.module.css";

export function MobileDevicesPage() {
  const { language, t } = useAppPreferences();
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const devices = useMobileDevices();
  const lanProbes = useMobileLanProbes();
  const refreshController = useMobileRefreshController();
  const probeByDevice = new Map((lanProbes.data ?? []).map((probe) => [probe.deviceId, probe]));

  return (
    <MobilePullToRefresh
      disabled={refreshController.disabled}
      refreshing={refreshController.loading}
      onRefresh={refreshController.refresh}
    >
    <section className={styles.page}>
      <header className={`${styles.heading} ${styles.headingWithPicker}`}>
        <div className={styles.headingTitleRow}>
          <h2>{t("设备")}</h2>
          <MobileLastRefreshTime value={refreshController.lastSuccessAt} />
        </div>
        <p>{t("查看同步设备、已安装 Agent 及其 Flowlet 接入状态")}</p>
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
          const probe = probeByDevice.get(device.deviceId);
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
                <LanStateBadge probe={probe} loading={lanProbes.isLoading} t={t} />
                <span className={styles.deviceChevron} aria-hidden="true">
                  {expanded ? <IconChevronUp /> : <IconChevronDown />}
                </span>
                <span className={styles.deviceMetrics}>
                  <span>{formatCompactNumber(device.knownTokens, language)} Tokens</span>
                  <span>{t("{count} 次请求", { count: formatInteger(device.requestCount, language) })}</span>
                </span>
                <time>{t("最近快照：{time}", { time: formatFullTimestamp(device.lastSeenAt, language) })}</time>
              </button>
              {expanded ? <DeviceEntryCards deviceId={device.deviceId} /> : null}
            </article>
          );
        })}
      </div>
    </section>
    </MobilePullToRefresh>
  );
}

type Translate = (source: string, variables?: Record<string, string | number>) => string;

function LanStateBadge({ probe, loading, t }: { probe: LanPeerProbe | undefined; loading: boolean; t: Translate }) {
  if (loading && !probe) {
    return <span className={styles.lanState} data-state="muted"><i />{t("探测中…")}</span>;
  }
  if (!probe || !probe.lanPublished) {
    return <span className={styles.lanState} data-state="muted"><i />{t("仅云端")}</span>;
  }
  if (probe.reachable) {
    return (
      <span className={styles.lanState} data-state="ok">
        <i />{probe.latencyMs != null ? t("直连 {ms}ms", { ms: probe.latencyMs }) : t("可直连")}
      </span>
    );
  }
  return (
    <span className={styles.lanState} data-state="fail" title={probe.error ?? undefined}>
      <i />{t("不可直连")}
    </span>
  );
}

/**
 * 展开设备后的两个聚合入口卡片：会话 / Agent。
 * 各自展示该设备的会话与 Agent 核心信息，点击进入对应设备二级页。
 */
function DeviceEntryCards({ deviceId }: { deviceId: string }) {
  const { language, t } = useAppPreferences();
  const navigate = useNavigate();
  const sessions = useMobileSessions(deviceId);
  const agents = useMobileDeviceAgents(deviceId);

  const sessionRows = sessions.data ?? [];
  const sessionLoading = sessions.isLoading;
  const runningCount = sessionRows.filter((s) => s.runtimeStatus === "running").length;
  const waitingCount = sessionRows.filter((s) => s.runtimeStatus === "waiting_user").length;
  const sessionTokens = sessionRows.reduce((sum, s) => sum + (s.knownTokens || 0), 0);

  const installedAgents = (agents.data ?? []).filter((agent) => agent.installed);
  const agentLoading = agents.isLoading;
  const flowletCount = installedAgents.filter((agent) => agent.flowletConfigState === "flowlet").length;

  return (
    <div className={styles.deviceDetails} id={`device-entries-${deviceId}`}>
      <div className={styles.deviceDetailsHeader}>
        <strong>{t("设备入口")}</strong>
      </div>
      <button
        type="button"
        className={styles.entryCard}
        onClick={() => navigate(`/devices/${encodeURIComponent(deviceId)}/sessions`)}
      >
        <span className={styles.entryIcon}><IconComment /></span>
        <span className={styles.entryMain}>
          <strong>{t("会话")}</strong>
          <span>{sessionLoading ? t("正在读取…") : t("{count} 个会话，{tokens} Tokens", {
            count: formatInteger(sessionRows.length, language),
            tokens: formatCompactNumber(sessionTokens, language),
          })}</span>
          <small>{sessionLoading || sessionRows.length === 0
            ? t("查看该设备同步的最近会话")
            : t("{running} 个运行中 · {waiting} 个等待确认", {
                running: formatInteger(runningCount, language),
                waiting: formatInteger(waitingCount, language),
              })}</small>
        </span>
        <IconChevronRight className={styles.entryChevron} />
      </button>
      <button
        type="button"
        className={styles.entryCard}
        onClick={() => navigate(`/devices/${encodeURIComponent(deviceId)}/agents`)}
      >
        <span className={styles.entryIcon}><IconDesktop /></span>
        <span className={styles.entryMain}>
          <strong>{t("Agent")}</strong>
          <span>{agentLoading ? t("正在读取…") : t("{count} 个已安装 Agent", {
            count: formatInteger(installedAgents.length, language),
          })}</span>
          <small>{agentLoading || installedAgents.length === 0
            ? t("查看该设备已安装的 Agent 及接入状态")
            : t("{count} 个已接入 Flowlet", { count: formatInteger(flowletCount, language) })}</small>
        </span>
        <IconChevronRight className={styles.entryChevron} />
      </button>
    </div>
  );
}

function platformLabel(platform: string) {
  if (/windows/i.test(platform)) return "Windows";
  if (/darwin|macos/i.test(platform)) return "macOS";
  if (/linux/i.test(platform)) return "Linux";
  return platform || "Desktop";
}
