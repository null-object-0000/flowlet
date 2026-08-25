import { IconChevronRight, IconComment, IconDesktop } from "@douyinfe/semi-icons";
import { Button } from "@douyinfe/semi-ui-19";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { LanPeerProbe } from "../../domains/device-sync/types";
import { useMobileAccountResources, useMobileDeviceAgents, useMobileDevices, useMobileLanProbes, useMobileSessions } from "../../features/device-sync/useMobileDeviceSync";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import { platformLabel } from "../../shared/formatters/platform";
import { MobileLastRefreshTime } from "../MobileLastRefreshTime";
import { useMobileRefreshController } from "../useMobileRefreshController";
import { MobilePullToRefresh } from "../MobilePullToRefresh";
import { MobileCardView, MobileDeviceListView, MobilePageHeaderView, MobilePageView, mobilePageStyles as styles, type MobileDeviceRowModel } from "@flowlet/product-ui";
import { MobileAccountResourceList } from "../MobileAccountResourceList";
import accountStyles from "../MobileAccountResources.module.css";

export function MobileDevicesPage() {
  const { language, t } = useAppPreferences();
  const navigate = useNavigate();
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const accountResources = useMobileAccountResources();
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
    <MobilePageView>
      <MobilePageHeaderView picker title={t("资源")} meta={<MobileLastRefreshTime value={refreshController.lastSuccessAt} />} subtitle={t("查看账号资源与同步设备")} />

      <MobileCardView>
        <div className={accountStyles.previewHeader}>
          <div><strong>{t("账号资源")}</strong><span>{t("跨设备共享的自动同步用量与余额")}</span></div>
          <Button theme="borderless" size="small" onClick={() => navigate("/account-resources")}>{t("查看全部")}</Button>
        </div>
        {accountResources.isLoading ? <div className={accountStyles.empty}>{t("正在读取账号资源…")}</div> : null}
        {accountResources.isError ? <div className={accountStyles.empty}>{t("账号资源加载失败")}</div> : null}
        {!accountResources.isLoading && !accountResources.isError && (accountResources.data?.length ?? 0) === 0 ? <div className={accountStyles.empty}>{t("仅展示已加入账号工作区且支持自动同步的账号。")}</div> : null}
        <MobileAccountResourceList resources={accountResources.data ?? []} compact />
      </MobileCardView>

      <div className={accountStyles.sectionHeader}>
        <strong>{t("同步设备")}</strong>
        <span>{t("查看已安装 Agent 及其 Flowlet 接入状态")}</span>
      </div>

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

      <MobileDeviceListView
        rows={(devices.data ?? []).map((device): MobileDeviceRowModel => {
          const status = lanState(probeByDevice.get(device.deviceId), lanProbes.isLoading, t);
          return { id: device.deviceId, name: device.displayName, platform: platformLabel(device.platform) || "Desktop", appVersion: device.appVersion, status: status.label, statusTone: status.tone, statusTitle: status.title, metrics: [`${formatCompactNumber(device.knownTokens, language)} Tokens`, t("{count} 次请求", { count: formatInteger(device.requestCount, language) })], lastSeen: t("最近快照：{time}", { time: formatFullTimestamp(device.lastSeenAt, language) }), details: <DeviceEntryCards deviceId={device.deviceId} /> };
        })}
        expandedId={expandedDeviceId}
        onToggle={(id) => setExpandedDeviceId((current) => current === id ? null : id)}
      />
    </MobilePageView>
    </MobilePullToRefresh>
  );
}

type Translate = (source: string, variables?: Record<string, string | number>) => string;

function lanState(probe: LanPeerProbe | undefined, loading: boolean, t: Translate): { label: string; tone: MobileDeviceRowModel["statusTone"]; title?: string } {
  if (loading && !probe) {
    return { label: t("探测中…"), tone: "muted" };
  }
  if (!probe || !probe.lanPublished) {
    return { label: t("仅云端"), tone: "muted" };
  }
  if (probe.reachable) {
    return { label: probe.latencyMs != null ? t("直连 {ms}ms", { ms: probe.latencyMs }) : t("可直连"), tone: "ok" };
  }
  return { label: t("不可直连"), tone: "fail", title: probe.error ?? undefined };
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
