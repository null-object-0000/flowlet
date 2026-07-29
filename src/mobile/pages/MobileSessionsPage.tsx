import { Select } from "@douyinfe/semi-ui-19";
import { useMemo, useState } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { SharedAgentSession } from "../../domains/device-sync/types";
import { useMobileDevices, useMobileSessions } from "../../features/device-sync/useMobileDeviceSync";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import styles from "./MobilePage.module.css";

type SessionStatusFilter = "all" | "active" | "waiting_user" | "idle";

export function MobileSessionsPage() {
  const { language, t } = useAppPreferences();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>("all");
  const devices = useMobileDevices();
  const sessions = useMobileSessions(deviceId);
  const rows = useMemo(
    () => (sessions.data ?? []).filter((session) => matchesStatus(session, statusFilter)),
    [sessions.data, statusFilter],
  );
  const activeCount = (sessions.data ?? []).filter(isActive).length;

  return (
    <section className={styles.page}>
      <header className={styles.heading}>
        <div>
          <h2>{t("会话")}</h2>
          <p>{t("查看各设备同步的最近会话与实时运行状态")}</p>
        </div>
      </header>

      <div className={styles.controls}>
        <Select
          value={deviceId ?? "__all__"}
          aria-label={t("设备")}
          optionList={[
            { value: "__all__", label: t("全部设备") },
            ...(devices.data ?? []).map((device) => ({
              value: device.deviceId,
              label: device.displayName,
            })),
          ]}
          onChange={(value) => setDeviceId(value === "__all__" ? null : String(value))}
        />
        <Select
          value={statusFilter}
          aria-label={t("会话状态")}
          optionList={[
            { value: "all", label: t("全部状态") },
            { value: "active", label: t("运行态") },
            { value: "waiting_user", label: t("等待确认") },
            { value: "idle", label: t("已空闲") },
          ]}
          onChange={(value) => setStatusFilter(value as SessionStatusFilter)}
        />
      </div>

      <div className={styles.sessionSummary}>
        <div><span>{t("已同步会话")}</span><strong>{formatInteger(sessions.data?.length ?? 0, language)}</strong></div>
        <div><span>{t("运行态")}</span><strong>{formatInteger(activeCount, language)}</strong></div>
        <p>{t("每台设备保留全部运行态会话，并用最近活跃会话补足 10 条。")}</p>
      </div>

      {sessions.isLoading ? (
        <div className={`${styles.card} ${styles.state}`}><span>{t("正在读取会话…")}</span></div>
      ) : null}
      {sessions.isError ? (
        <div className={`${styles.card} ${styles.state}`}>
          <strong>{t("会话加载失败")}</strong>
          <span>{sessions.error.message}</span>
        </div>
      ) : null}
      {!sessions.isLoading && !sessions.isError && rows.length === 0 ? (
        <div className={`${styles.card} ${styles.state}`}>
          <strong>{t("暂无同步会话")}</strong>
          <span>{t("请先在桌面端执行同步，再在手机端刷新远端数据。")}</span>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className={styles.sessionList}>
          {rows.map((session) => (
            <article
              className={styles.sessionCard}
              key={`${session.deviceId}:${session.agentType}:${session.sessionId}`}
            >
              <div className={styles.sessionTopline}>
                <span className={styles.agentBadge}>{agentLabel(session.agentType)}</span>
                <span className={styles.sessionState} data-state={session.runtimeStatus}>
                  <i />
                  {runtimeLabel(session.runtimeStatus, t)}
                </span>
              </div>
              <strong className={styles.sessionTitle}>
                {session.title?.trim() || t("未命名会话")}
              </strong>
              <div className={styles.sessionMeta}>
                <span>{session.deviceDisplayName}</span>
                {session.clientName ? <span>{session.clientName}</span> : null}
              </div>
              <div className={styles.sessionMetrics}>
                <span>{formatCompactNumber(session.knownTokens, language)} Tokens</span>
                <span>{t("{count} 次请求", { count: formatInteger(session.requestCount, language) })}</span>
                {session.errorCount > 0 ? (
                  <span data-error="true">
                    {t("{count} 次失败", { count: formatInteger(session.errorCount, language) })}
                  </span>
                ) : null}
              </div>
              <time>{t("最近活跃：{time}", { time: formatFullTimestamp(session.activityAt, language) })}</time>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function isActive(session: SharedAgentSession) {
  return session.runtimeStatus === "running" || session.runtimeStatus === "waiting_user";
}

function matchesStatus(session: SharedAgentSession, filter: SessionStatusFilter) {
  if (filter === "all") return true;
  if (filter === "active") return isActive(session);
  return session.runtimeStatus === filter;
}

function agentLabel(agentType: string) {
  switch (agentType) {
    case "claude-code": return "Claude Code";
    case "codex-desktop": return "Codex";
    case "codex-cli": return "Codex CLI";
    case "opencode": return "OpenCode";
    case "pi": return "Pi";
    default: return agentType;
  }
}

function runtimeLabel(status: SharedAgentSession["runtimeStatus"], t: (key: string) => string) {
  switch (status) {
    case "running": return t("自动运行中");
    case "waiting_user": return t("等待用户确认");
    case "idle": return t("空闲");
    default: return t("状态未知");
  }
}
