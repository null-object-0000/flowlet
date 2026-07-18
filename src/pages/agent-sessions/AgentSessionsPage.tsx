import { useEffect, useState } from "react";
import { Button, Input, Pagination, Select, Typography } from "@douyinfe/semi-ui-19";
import { IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import { useNavigate } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { DEFAULT_AGENT_SESSION_FILTER, type AgentSessionFilter, type AgentSessionRow } from "../../domains/agent-session/types";
import { useAgentSessionClients, useAgentSessions } from "../../features/agent-sessions/useAgentSessions";
import secondaryButtonStyles from "../../shared/ui/SecondaryButton.module.css";
import { AgentSessionDetailSideSheet, sessionDisplayTitle } from "./AgentSessionDetailSideSheet";
import styles from "./AgentSessionsPage.module.css";

const { Paragraph, Text, Title } = Typography;

export function AgentSessionsPage() {
  const { language, t } = useAppPreferences();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<AgentSessionFilter>(DEFAULT_AGENT_SESSION_FILTER);
  const [searchDraft, setSearchDraft] = useState("");
  const [selectedSession, setSelectedSession] = useState<AgentSessionRow | null>(null);
  const sessions = useAgentSessions(filter);
  const clients = useAgentSessionClients();
  const page = sessions.data;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const search = searchDraft.trim();
      setFilter((current) => current.search === search ? current : { ...current, search, page: 1 });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Title heading={3} style={{ margin: 0 }}>{t("会话管理")}</Title>
          <Paragraph type="tertiary" style={{ margin: 0 }}>{t("按 Agent 会话和客户端查看请求、Token、费用和失败情况")}</Paragraph>
        </div>
      </header>

      <section className={styles.toolbar} aria-label={t("会话筛选")}>
        <Input prefix={<IconSearch />} value={searchDraft} placeholder={t("搜索主会话或子会话 ID")} showClear onChange={setSearchDraft} />
        <Select
          insetLabel={t("客户端")}
          value={filter.clientId || "__all__"}
          loading={clients.isLoading}
          optionList={[
            { value: "__all__", label: t("全部客户端") },
            ...(clients.data ?? []).map((client) => ({ value: client.id || "__unknown__", label: client.name })),
          ]}
          onChange={(value) => setFilter((current) => ({ ...current, clientId: value === "__all__" ? "" : String(value), page: 1 }))}
        />
        <span />
        <Button
          className={`${secondaryButtonStyles.button} ${secondaryButtonStyles.compact}`}
          icon={<IconRefresh />}
          type="tertiary"
          theme="outline"
          loading={sessions.isFetching}
          onClick={() => void sessions.refetch()}
        >
          {t("刷新")}
        </Button>
      </section>

      <section className={styles.tableCard}>
        <div className={`${styles.grid} ${styles.head}`} role="row">
          <span>{t("最近活动")}</span><span>{t("主会话")}</span><span>{t("客户端")}</span><span>{t("请求")}</span><span>Token</span><span>{t("费用")}</span><span>{t("状态")}</span>
        </div>
        <div className={styles.body}>
          {sessions.isLoading ? Array.from({ length: 7 }, (_, index) => <SkeletonRow key={index} />) : null}
          {sessions.isError ? <div className={styles.state}><strong>{t("会话加载失败")}</strong><span>{sessions.error.message}</span><Button onClick={() => void sessions.refetch()}>{t("重试")}</Button></div> : null}
          {!sessions.isLoading && !sessions.isError && (page?.rows.length ?? 0) === 0 ? <div className={styles.state}><strong>{t("暂无 Agent 会话")}</strong><span>{t("通过 Flowlet 发起 Claude Code 或 OpenCode 模型请求后，会话会自动出现在这里。")}</span></div> : null}
          {!sessions.isLoading && !sessions.isError ? page?.rows.map((row) => <SessionRow key={`${row.agentType}:${row.sessionId}`} row={row} language={language} onOpen={() => setSelectedSession(row)} />) : null}
        </div>
        <footer className={styles.footer}>
          <Text type="tertiary" size="small">{t("共 {total} 个主会话", { total: page?.total ?? 0 })}</Text>
          <Pagination total={page?.total ?? 0} currentPage={filter.page} pageSize={filter.pageSize} onPageChange={(pageNumber) => setFilter((current) => ({ ...current, page: pageNumber }))} />
        </footer>
      </section>
      {selectedSession ? (
        <AgentSessionDetailSideSheet
          session={selectedSession}
          onClose={() => setSelectedSession(null)}
          onViewRequestLogs={(sessionId) => navigate(`/logs?search=${encodeURIComponent(sessionId)}`)}
        />
      ) : null}
    </main>
  );
}

function SessionRow({ row, language, onOpen }: { row: AgentSessionRow; language: "zh-CN" | "en-US"; onOpen: () => void }) {
  const { t } = useAppPreferences();
  return (
    <button type="button" className={`${styles.grid} ${styles.row}`} onClick={onOpen}>
      <span>{formatDate(row.updatedAt, language)}</span>
      <span className={styles.session}><strong title={row.title ?? row.sessionId}>{sessionDisplayTitle(row)}</strong><small title={row.projectPath ?? row.sessionId}>{row.projectPath ? `${agentLabel(row.agentType)} · ${projectName(row.projectPath)}` : agentLabel(row.agentType)}</small></span>
      <span className={styles.client}><strong title={row.clientName ?? row.clientId ?? t("未知客户端")}>{row.clientName ?? row.clientId ?? t("未知客户端")}</strong>{row.clientId ? <small title={row.clientId}>{row.clientId}</small> : null}</span>
      <span>{row.requestCount.toLocaleString(language)}</span>
      <span>{row.knownTokens.toLocaleString(language)}</span>
      <span>¥{row.estimatedCost.toFixed(4)}</span>
      <span className={row.errorCount > 0 ? styles.warning : styles.success}>{row.errorCount > 0 ? t("{count} 次失败", { count: row.errorCount }) : t("正常")}</span>
    </button>
  );
}

function agentLabel(agentType: AgentSessionRow["agentType"]) {
  return agentType === "claude-code" ? "Claude Code" : "OpenCode";
}

function projectName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function SkeletonRow() {
  return <div className={`${styles.grid} ${styles.row} ${styles.skeleton}`} aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <span key={index} />)}</div>;
}

function formatDate(value: string, language: "zh-CN" | "en-US") {
  const iso = value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
