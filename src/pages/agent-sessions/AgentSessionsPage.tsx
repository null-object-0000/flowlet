import { useEffect, useState } from "react";
import { Button, Input, Pagination, Typography } from "@douyinfe/semi-ui-19";
import { IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import { useNavigate } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { DEFAULT_AGENT_SESSION_FILTER, type AgentSessionFilter, type AgentSessionRow } from "../../domains/agent-session/types";
import { useAgentSessions } from "../../features/agent-sessions/useAgentSessions";
import secondaryButtonStyles from "../../shared/ui/SecondaryButton.module.css";
import styles from "./AgentSessionsPage.module.css";

const { Paragraph, Text, Title } = Typography;

export function AgentSessionsPage() {
  const { language, t } = useAppPreferences();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<AgentSessionFilter>(DEFAULT_AGENT_SESSION_FILTER);
  const [searchDraft, setSearchDraft] = useState("");
  const sessions = useAgentSessions(filter);
  const page = sessions.data;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const search = searchDraft.trim();
      setFilter((current) => current.search === search ? current : { ...current, search, page: 1 });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  const openSession = (sessionId: string) => {
    navigate(`/logs?search=${encodeURIComponent(sessionId)}`);
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Title heading={3} style={{ margin: 0 }}>{t("会话管理")}</Title>
          <Paragraph type="tertiary" style={{ margin: 0 }}>{t("按 OpenCode 会话查看请求、Token、费用和失败情况")}</Paragraph>
        </div>
      </header>

      <section className={styles.toolbar} aria-label={t("会话筛选")}>
        <Input prefix={<IconSearch />} value={searchDraft} placeholder={t("搜索会话 ID、父会话或模型")} showClear onChange={setSearchDraft} />
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
          <span>{t("最近活动")}</span><span>{t("会话")}</span><span>{t("模型")}</span><span>{t("请求")}</span><span>Token</span><span>{t("费用")}</span><span>{t("状态")}</span>
        </div>
        <div className={styles.body}>
          {sessions.isLoading ? Array.from({ length: 7 }, (_, index) => <SkeletonRow key={index} />) : null}
          {sessions.isError ? <div className={styles.state}><strong>{t("会话加载失败")}</strong><span>{sessions.error.message}</span><Button onClick={() => void sessions.refetch()}>{t("重试")}</Button></div> : null}
          {!sessions.isLoading && !sessions.isError && (page?.rows.length ?? 0) === 0 ? <div className={styles.state}><strong>{t("暂无 OpenCode 会话")}</strong><span>{t("通过 Flowlet 发起 OpenCode 模型请求后，会话会自动出现在这里。")}</span></div> : null}
          {!sessions.isLoading && !sessions.isError ? page?.rows.map((row) => <SessionRow key={`${row.agentType}:${row.sessionId}`} row={row} language={language} onOpen={() => openSession(row.sessionId)} />) : null}
        </div>
        <footer className={styles.footer}>
          <Text type="tertiary" size="small">{t("共 {total} 个会话", { total: page?.total ?? 0 })}</Text>
          <Pagination total={page?.total ?? 0} currentPage={filter.page} pageSize={filter.pageSize} onPageChange={(pageNumber) => setFilter((current) => ({ ...current, page: pageNumber }))} />
        </footer>
      </section>
    </main>
  );
}

function SessionRow({ row, language, onOpen }: { row: AgentSessionRow; language: "zh-CN" | "en-US"; onOpen: () => void }) {
  const { t } = useAppPreferences();
  return (
    <button type="button" className={`${styles.grid} ${styles.row}`} onClick={onOpen}>
      <span>{formatDate(row.updatedAt, language)}</span>
      <span className={styles.session}><strong title={row.sessionId}>{row.sessionId}</strong>{row.parentSessionId ? <small title={row.parentSessionId}>{t("父会话：{id}", { id: row.parentSessionId })}</small> : <small>OpenCode</small>}</span>
      <span title={row.latestModel ?? ""}>{row.latestModel ?? "—"}</span>
      <span>{row.requestCount.toLocaleString(language)}</span>
      <span>{row.knownTokens.toLocaleString(language)}</span>
      <span>¥{row.estimatedCost.toFixed(4)}</span>
      <span className={row.errorCount > 0 ? styles.warning : styles.success}>{row.errorCount > 0 ? t("{count} 次失败", { count: row.errorCount }) : t("正常")}</span>
    </button>
  );
}

function SkeletonRow() {
  return <div className={`${styles.grid} ${styles.row} ${styles.skeleton}`} aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <span key={index} />)}</div>;
}

function formatDate(value: string, language: "zh-CN" | "en-US") {
  const iso = value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
