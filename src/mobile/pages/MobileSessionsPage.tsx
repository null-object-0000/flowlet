import { Button, Toast } from "@douyinfe/semi-ui-19";
import { useMemo, useState } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { SharedAgentSession } from "../../domains/device-sync/types";
import {
  useMobileRemotePermissions,
  useMobileSessions,
  useReplyMobileRemotePermission,
} from "../../features/device-sync/useMobileDeviceSync";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import { MobileDevicePicker } from "../MobileDevicePicker";
import { useMobileDeviceSelection } from "../MobileDeviceSelection";
import styles from "./MobilePage.module.css";

type SessionStatusFilter = "all" | "active" | "waiting_user" | "idle";

const STATUS_FILTERS: Array<{ value: SessionStatusFilter; labelKey: string }> = [
  { value: "all", labelKey: "全部状态" },
  { value: "active", labelKey: "运行态" },
  { value: "waiting_user", labelKey: "等待确认" },
  { value: "idle", labelKey: "已空闲" },
];

export function MobileSessionsPage() {
  const { language, t } = useAppPreferences();
  const { deviceId } = useMobileDeviceSelection();
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>("all");
  const sessions = useMobileSessions(deviceId);
  const rows = useMemo(
    () => (sessions.data ?? []).filter((session) => matchesStatus(session, statusFilter)),
    [sessions.data, statusFilter],
  );

  return (
    <section className={styles.page}>
      <header className={`${styles.heading} ${styles.headingWithPicker}`}>
        <div className={styles.headingTitleRow}>
          <h2>{t("会话")}</h2>
          <MobileDevicePicker />
        </div>
        <p>{t("查看各设备同步的最近会话与实时运行状态")}</p>
      </header>

      <div className={styles.statusTabs} role="group" aria-label={t("会话状态")}>
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            aria-pressed={statusFilter === filter.value}
            onClick={() => setStatusFilter(filter.value)}
          >
            {t(filter.labelKey)}
          </button>
        ))}
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
              {session.agentType === "opencode" ? (
                <RemoteApprovalActions session={session} />
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RemoteApprovalActions({ session }: { session: SharedAgentSession }) {
  const { t } = useAppPreferences();
  const permissions = useMobileRemotePermissions(session.deviceId, session.sessionId, true);
  const reply = useReplyMobileRemotePermission(session.deviceId, session.sessionId);

  if (permissions.isLoading) {
    return session.runtimeStatus === "waiting_user"
      ? <div className={styles.remoteApprovalState}>{t("正在连接 Agent 所在设备…")}</div>
      : null;
  }
  if (permissions.isError || !permissions.data?.available) {
    return session.runtimeStatus === "waiting_user" ? (
      <div className={styles.remoteApprovalState} data-error="true">
        {t("目标设备当前无法直连，请确认两台设备位于同一局域网。")}
      </div>
    ) : null;
  }
  if (permissions.data.permissions.length === 0) {
    return session.runtimeStatus === "waiting_user"
      ? <div className={styles.remoteApprovalState}>{t("该确认请求已处理或已过期。")}</div>
      : null;
  }

  const decide = async (permissionId: string, decision: "allow_once" | "reject") => {
    try {
      await reply.mutateAsync({ permissionId, decision });
      Toast.success(decision === "allow_once" ? t("已同意 OpenCode 本次操作") : t("已否决 OpenCode 操作"));
    } catch (error) {
      Toast.error(t("OpenCode 操作提交失败：{message}", {
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  return (
    <div className={styles.remoteApprovalList}>
      {permissions.data.permissions.map((permission) => {
        const submitting = reply.isPending && reply.variables?.permissionId === permission.id;
        return (
          <div className={styles.remoteApproval} key={permission.id}>
            <div>
              <strong>{permission.permission}</strong>
              {permission.patterns.length > 0 ? <span>{permission.patterns.join(" · ")}</span> : null}
            </div>
            <div className={styles.remoteApprovalActions}>
              <Button
                size="small"
                type="danger"
                theme="borderless"
                loading={submitting && reply.variables?.decision === "reject"}
                disabled={reply.isPending && !submitting}
                onClick={() => void decide(permission.id, "reject")}
              >
                {t("否决")}
              </Button>
              <Button
                size="small"
                type="primary"
                theme="solid"
                loading={submitting && reply.variables?.decision === "allow_once"}
                disabled={reply.isPending && !submitting}
                onClick={() => void decide(permission.id, "allow_once")}
              >
                {t("同意本次")}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
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
