import { IconChevronRight } from "@douyinfe/semi-icons";
import { useMemo, useState } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { SharedAgentSession } from "../../domains/device-sync/types";
import {
  useMobileSessions,
  useMobileWaitingSessionLanRefresh,
} from "../../features/device-sync/useMobileDeviceSync";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import {
  MobileDeviceTitlePicker,
  useMobileDevicePickerState,
} from "../MobileDevicePicker";
import { MobileRefreshButton } from "../MobileRefreshButton";
import { MobileSessionSheet, agentLabel, runtimeLabel } from "../MobileSessionSheet";
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
  const devicePicker = useMobileDevicePickerState({ allowAll: false });
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const sessions = useMobileSessions(devicePicker.effectiveDeviceId);
  const waitingDeviceIds = useMemo(
    () => [...new Set(
      (sessions.data ?? [])
        .filter((session) => session.runtimeStatus === "waiting_user")
        .map((session) => session.deviceId),
    )],
    [sessions.data],
  );
  useMobileWaitingSessionLanRefresh(waitingDeviceIds);
  const rows = useMemo(
    () => (sessions.data ?? []).filter((session) => matchesStatus(session, statusFilter)),
    [sessions.data, statusFilter],
  );
  const selectedSession = useMemo(
    () => (sessions.data ?? []).find((session) => sessionKeyOf(session) === selectedKey) ?? null,
    [sessions.data, selectedKey],
  );

  return (
    <section className={styles.page}>
      <header className={`${styles.heading} ${styles.headingWithPicker}`}>
        <div className={styles.headingTitleRow}>
          <h2><MobileDeviceTitlePicker state={devicePicker} formatTitle={(name) => `${name ?? "…"} ${t("会话")}`} /></h2>
          <div className={styles.headingActions}>
            <MobileRefreshButton />
          </div>
        </div>
        <p>{t("查看该设备同步的最近会话与实时运行状态")}</p>
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
            <SessionCard
              key={sessionKeyOf(session)}
              session={session}
              language={language}
              onOpen={() => setSelectedKey(sessionKeyOf(session))}
            />
          ))}
        </div>
      ) : null}

      <MobileSessionSheet session={selectedSession} onClose={() => setSelectedKey(null)} />
    </section>
  );
}

function SessionCard({
  session,
  language,
  onOpen,
}: {
  session: SharedAgentSession;
  language: "zh-CN" | "en-US";
  onOpen: () => void;
}) {
  const { t } = useAppPreferences();
  const title = session.title?.trim() || t("未命名会话");
  const teaser = lastUserInputPreview(session);
  return (
    <article
      className={styles.sessionCard}
      role="button"
      tabIndex={0}
      aria-label={`${title}，${t("会话详情")}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={styles.sessionTopline}>
        <span className={styles.agentBadge}>{agentLabel(session.agentType)}</span>
        <span className={styles.sessionState} data-state={session.runtimeStatus}>
          <i />
          {runtimeLabel(session.runtimeStatus, t)}
        </span>
      </div>
      <div className={styles.sessionTitleRow}>
        <strong className={styles.sessionTitle}>{title}</strong>
        <IconChevronRight className={styles.sessionChevron} />
      </div>
      <div className={styles.sessionMeta}>
        <span>{session.deviceDisplayName}</span>
        {session.clientName ? <span>{session.clientName}</span> : null}
      </div>
      {teaser ? <p className={styles.sessionTeaser}>{teaser}</p> : null}
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
  );
}

function sessionKeyOf(session: SharedAgentSession) {
  return `${session.deviceId}:${session.agentType}:${session.sessionId}`;
}

/** 卡片上的最近一次用户输入摘要，扫一眼即可知道这一轮在做什么。 */
function lastUserInputPreview(session: SharedAgentSession) {
  const events = session.lastInteraction?.events ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "user-message" || !event.content) continue;
    const collapsed = event.content.replace(/\s+/g, " ").trim();
    if (!collapsed) continue;
    return collapsed.length > 90 ? `${collapsed.slice(0, 90)}…` : collapsed;
  }
  return null;
}

function isActive(session: SharedAgentSession) {
  return session.runtimeStatus === "running" || session.runtimeStatus === "waiting_user";
}

function matchesStatus(session: SharedAgentSession, filter: SessionStatusFilter) {
  if (filter === "all") return true;
  if (filter === "active") return isActive(session);
  return session.runtimeStatus === filter;
}
