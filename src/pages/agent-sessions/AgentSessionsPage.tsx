import { useEffect, useState } from "react";
import { Button, Input, Pagination, Select, Typography } from "@douyinfe/semi-ui-19";
import { IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import { useNavigate } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { DEFAULT_AGENT_SESSION_FILTER, type AgentSessionFilter, type AgentSessionRow } from "../../domains/agent-session/types";
import { useAgentSessions } from "../../features/agent-sessions/useAgentSessions";
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
          <Paragraph type="tertiary" style={{ margin: 0 }}>{t("统一查看 Agent 本地会话与 Flowlet 请求观测")}</Paragraph>
        </div>
      </header>

      <section className={styles.toolbar} aria-label={t("会话筛选")}>
        <Input prefix={<IconSearch />} value={searchDraft} placeholder={t("搜索会话标题、ID 或项目目录")} showClear onChange={setSearchDraft} />
        <Select
          style={{ width: "100%" }}
          insetLabel={t("客户端")}
          value={filter.agentType || "__all__"}
          optionList={[
            { value: "__all__", label: t("全部客户端") },
            { value: "codex-desktop", label: "ChatGPT (Codex)" },
            { value: "codex-cli", label: "Codex CLI" },
            { value: "claude-code", label: "Claude Code" },
            { value: "opencode", label: "OpenCode" },
          ]}
          onChange={(value) => setFilter((current) => ({ ...current, agentType: value === "__all__" ? "" : String(value) as AgentSessionFilter["agentType"], page: 1 }))}
        />
        <Select
          style={{ width: "100%" }}
          insetLabel={t("Flowlet 状态")}
          value={filter.flowletStatus || "__all__"}
          optionList={[
            { value: "__all__", label: t("全部状态") },
            { value: "observed", label: t("经过 Flowlet") },
            { value: "native", label: t("未经过 Flowlet") },
          ]}
          onChange={(value) => setFilter((current) => ({ ...current, flowletStatus: value === "__all__" ? "" : String(value) as AgentSessionFilter["flowletStatus"], page: 1 }))}
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
          {!sessions.isLoading && !sessions.isError && (page?.rows.length ?? 0) === 0 ? <div className={styles.state}><strong>{t("暂无 Agent 会话")}</strong><span>{t("安装并使用 ChatGPT（Codex）、Claude Code 或 OpenCode 后，本地会话会自动出现在这里。")}</span></div> : null}
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
      <span>{formatDate(row.activityAt, language)}</span>
      <span className={styles.session}><strong title={row.title ?? row.sessionId}>{sessionDisplayTitle(row)}</strong><small title={row.projectPath ?? row.sessionId}>{row.projectPath ? `${agentLabel(row.agentType)} · ${projectName(row.projectPath)}` : agentLabel(row.agentType)}</small></span>
      <span className={styles.client}><strong title={row.flowletObserved ? row.clientName ?? row.clientId ?? t("未知客户端") : t("未经过 Flowlet")}>{row.flowletObserved ? row.clientName ?? row.clientId ?? t("未知客户端") : t("未经过 Flowlet")}</strong>{row.clientId ? <small title={row.clientId}>{row.clientId}</small> : <small>{t("仅本地会话")}</small>}</span>
      <span>{row.flowletObserved ? row.requestCount.toLocaleString(language) : "—"}</span>
      <span>{row.flowletObserved ? row.knownTokens.toLocaleString(language) : "—"}</span>
      <span>{row.flowletObserved ? `¥${row.estimatedCost.toFixed(4)}` : "—"}</span>
      <span className={!row.flowletObserved ? styles.localOnly : row.errorCount > 0 ? styles.warning : styles.success}>{!row.flowletObserved ? t("本地会话") : row.errorCount > 0 ? t("{count} 次失败", { count: row.errorCount }) : t("正常")}</span>
    </button>
  );
}

function agentLabel(agentType: AgentSessionRow["agentType"]) {
  if (agentType === "claude-code") return "Claude Code";
  if (agentType === "codex-desktop") return "ChatGPT (Codex)";
  if (agentType === "codex-cli") return "Codex CLI";
  return "OpenCode";
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
