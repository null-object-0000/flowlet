import { Button, SideSheet, Tag, Toast, Tooltip } from "@douyinfe/semi-ui-19";
import { IconCopy, IconExternalOpen } from "@douyinfe/semi-icons";
import type { ReactNode } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { AgentSessionRow } from "../../domains/agent-session/types";
import { useAgentSessionChildren } from "../../features/agent-sessions/useAgentSessions";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import styles from "./AgentSessionDetailSideSheet.module.css";

export function AgentSessionDetailSideSheet({
  session,
  onClose,
  onViewRequestLogs,
}: {
  session: AgentSessionRow;
  onClose: () => void;
  onViewRequestLogs: (sessionId: string) => void;
}) {
  const { language, t } = useAppPreferences();
  const title = sessionDisplayTitle(session);
  const children = useAgentSessionChildren(session);

  return (
    <SideSheet
      visible
      motion={false}
      width="min(760px, 96vw)"
      title={<div className={styles.title}><strong>{title}</strong><span>{agentLabel(session.agentType)} · {t("会话详情")}</span></div>}
      onCancel={onClose}
      footer={null}
      bodyStyle={{ padding: 0 }}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
    >
      <div className={styles.body}>
        <section className={styles.summary}>
          <div>
            <Tag color={session.agentType === "claude-code" ? "orange" : "blue"}>{agentLabel(session.agentType)}</Tag>
            {session.flowletObserved ? (
              <Tag color={session.errorCount > 0 ? "red" : "green"}>
                {session.errorCount > 0 ? t("{count} 次失败", { count: session.errorCount }) : t("正常")}
              </Tag>
            ) : <Tag>{t("未经过 Flowlet")}</Tag>}
          </div>
          <p>{session.projectPath ?? t("未读取到原生项目路径")}</p>
        </section>

        <DetailSection title={t("会话信息")}>
          <div className={styles.detailGrid}>
            <DetailItem label={t("会话标题")} value={title} wide />
            <DetailItem label={t("会话 ID")} value={session.sessionId} copyable wide onOpen={session.flowletObserved ? () => onViewRequestLogs(session.sessionId) : undefined} />
            {session.parentSessionId ? <DetailItem label={t("父会话 ID")} value={session.parentSessionId} copyable wide /> : null}
            <DetailItem
              label={session.flowletObserved ? t("客户端") : t("Agent 来源")}
              value={session.flowletObserved
                ? session.clientName ?? session.clientId ?? t("未知客户端")
                : agentLabel(session.agentType)}
            />
            <DetailItem label={t("项目目录")} value={session.projectPath ?? "—"} />
          </div>
        </DetailSection>

        <DetailSection title={t("活动时间")}>
          <div className={styles.detailGrid}>
            {session.flowletObserved ? <DetailItem label={t("Flowlet 首次观测")} value={formatDate(session.startedAt, language)} /> : null}
            {session.flowletObserved ? <DetailItem label={t("Flowlet 最近观测")} value={formatDate(session.updatedAt, language)} /> : null}
            {session.nativeStartedAt ? <DetailItem label={t("Agent 创建时间")} value={formatDate(session.nativeStartedAt, language)} /> : null}
            {session.nativeUpdatedAt ? <DetailItem label={t("Agent 更新时间")} value={formatDate(session.nativeUpdatedAt, language)} /> : null}
          </div>
        </DetailSection>

        <DetailSection title={t("Flowlet 请求统计")}>
          <div className={styles.metrics}>
            <Metric label={t("请求数")} value={session.flowletObserved ? session.requestCount.toLocaleString(language) : "—"} />
            <Metric label={t("成功")} value={session.flowletObserved ? session.successCount.toLocaleString(language) : "—"} />
            <Metric label={t("失败")} value={session.flowletObserved ? session.errorCount.toLocaleString(language) : "—"} warning={session.flowletObserved && session.errorCount > 0} />
            <Metric label="Token" value={session.flowletObserved ? session.knownTokens.toLocaleString(language) : "—"} />
            <Metric label={t("费用")} value={session.flowletObserved ? `¥${session.estimatedCost.toFixed(4)}` : "—"} />
          </div>
        </DetailSection>

        <ChildSessionsSection
          rows={children.data ?? []}
          loading={children.isLoading}
          error={children.isError ? children.error.message : null}
          language={language}
          onRetry={() => void children.refetch()}
          onViewRequestLogs={onViewRequestLogs}
        />
      </div>
    </SideSheet>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.section}><strong className={styles.sectionTitle}>{title}</strong>{children}</section>;
}

function DetailItem({
  label,
  value,
  wide = false,
  copyable = false,
  onOpen,
}: {
  label: string;
  value: string;
  wide?: boolean;
  copyable?: boolean;
  onOpen?: () => void;
}) {
  const { t } = useAppPreferences();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(t("{label} 已复制", { label }));
    } catch {
      Toast.error(t("复制失败，请手动选择内容"));
    }
  };
  return (
    <div className={`${styles.detailItem} ${wide ? styles.wide : ""}`}>
      <span>{label}</span>
      <div>
        {onOpen ? (
          <Tooltip content={t("查看请求日志明细")}>
            <Button
              className={styles.valueLink}
              aria-label={t("查看会话 {id} 的请求日志明细", { id: value })}
              type="primary"
              theme="borderless"
              size="small"
              onClick={onOpen}
            >
              <span className={styles.linkText} title={value}>{value}</span>
              <IconExternalOpen />
            </Button>
          </Tooltip>
        ) : <strong title={value}>{value}</strong>}
        {copyable ? <Button aria-label={t("复制{label}", { label })} icon={<IconCopy />} theme="borderless" size="small" onClick={() => void copy()} /> : null}
      </div>
    </div>
  );
}

function Metric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return <div className={warning ? styles.metricWarning : ""}><span>{label}</span><strong>{value}</strong></div>;
}

function ChildSessionsSection({
  rows,
  loading,
  error,
  language,
  onRetry,
  onViewRequestLogs,
}: {
  rows: AgentSessionRow[];
  loading: boolean;
  error: string | null;
  language: "zh-CN" | "en-US";
  onRetry: () => void;
  onViewRequestLogs: (sessionId: string) => void;
}) {
  const { t } = useAppPreferences();
  if (!loading && !error && rows.length === 0) return null;

  return (
    <DetailSection title={t("子会话（{count}）", { count: rows.length })}>
      {loading ? (
        <div className={styles.childLoading} aria-label={t("正在读取子会话")}>
          <span /><span />
        </div>
      ) : null}
      {error ? (
        <div className={styles.childError}>
          <span>{t("子会话加载失败：{message}", { message: error })}</span>
          <Button size="small" onClick={onRetry}>{t("重试")}</Button>
        </div>
      ) : null}
      {!loading && !error ? (
        <div className={styles.childList}>
          {rows.map((row) => (
            <article className={styles.childRow} key={`${row.agentType}:${row.sessionId}`}>
              <div className={styles.childIdentity}>
                <strong title={row.title ?? row.sessionId}>{sessionDisplayTitle(row)}</strong>
                <small title={row.sessionId}>{row.sessionId}</small>
              </div>
              <div className={styles.childMeta}>
                <span>{formatShortDate(row.activityAt, language)}</span>
                <small>{row.flowletObserved ? t("{requests} 次请求 · {tokens} Token · ¥{cost}", {
                  requests: row.requestCount.toLocaleString(language),
                  tokens: row.knownTokens.toLocaleString(language),
                  cost: row.estimatedCost.toFixed(4),
                }) : t("未经过 Flowlet，暂无请求指标")}</small>
              </div>
              <div className={styles.childActions}>
                {row.flowletObserved ? (
                  <>
                    <Tag size="small" color={row.errorCount > 0 ? "red" : "green"}>
                      {row.errorCount > 0 ? t("{count} 次失败", { count: row.errorCount }) : t("正常")}
                    </Tag>
                    <Tooltip content={t("查看请求日志明细")}>
                      <Button
                        aria-label={t("查看会话 {id} 的请求日志明细", { id: row.sessionId })}
                        icon={<IconExternalOpen />}
                        theme="borderless"
                        size="small"
                        onClick={() => onViewRequestLogs(row.sessionId)}
                      />
                    </Tooltip>
                  </>
                ) : <Tag size="small">{t("本地会话")}</Tag>}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </DetailSection>
  );
}

export function sessionDisplayTitle(session: AgentSessionRow) {
  return session.title?.trim() || projectName(session.projectPath) || session.sessionId;
}

function projectName(path: string | null) {
  if (!path) return null;
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || null;
}

function agentLabel(agentType: AgentSessionRow["agentType"]) {
  if (agentType === "claude-code") return "Claude Code";
  if (agentType === "codex-desktop") return "ChatGPT (Codex)";
  if (agentType === "codex-cli") return "Codex CLI";
  return "OpenCode";
}

function formatDate(value: string, language: "zh-CN" | "en-US") {
  const iso = value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(language, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function formatShortDate(value: string, language: "zh-CN" | "en-US") {
  const iso = value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(language, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}
