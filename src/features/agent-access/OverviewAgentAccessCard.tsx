import { useState } from "react";
import { Toast } from "@douyinfe/semi-ui-19";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import styles from "./OverviewAgentAccessCard.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { AgentAccessSideSheet, type AgentKind } from "./AgentAccessSideSheet";
import { useClaudeCodeEnvironment } from "./useAgentEnvironment";

const AGENTS: Array<{
  name: string;
  description: string;
  icon: React.ReactNode;
  iconClassName: string;
  kind?: AgentKind;
}> = [
  {
    name: "Claude Code CLI",
    description: "命令行接入",
    icon: <span className={`${styles.brandIcon} ${styles.claudeCodeMark}`} aria-hidden="true" />,
    iconClassName: styles.claudeIcon,
    kind: "claude-code",
  },
  {
    name: "OpenCode CLI",
    description: "命令行接入",
    icon: <span className={`${styles.brandIcon} ${styles.openCodeMark}`} aria-hidden="true" />,
    iconClassName: styles.openCodeIcon,
  },
  {
    name: "Codex Desktop",
    description: "客户端接入",
    icon: <span className={`${styles.brandIcon} ${styles.codexMark}`} aria-hidden="true" />,
    iconClassName: styles.codexIcon,
  },
];

type Props = {
  baseUrl: string;
  clientToken?: string | null;
};

export function OverviewAgentAccessCard({ baseUrl, clientToken }: Props) {
  const { t } = useAppPreferences();
  const [selectedAgent, setSelectedAgent] = useState<AgentKind | null>(null);
  const claudeEnvironment = useClaudeCodeEnvironment();

  const copy = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(message);
    } catch (error) {
      Toast.error(t("复制失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };

  const claudeStatus = claudeEnvironment.isLoading
    ? t("正在检测…")
    : claudeEnvironment.isError
      ? t("检测失败")
      : claudeEnvironment.data?.installed
        ? claudeEnvironment.data.primary?.version
          ? t("已安装 · {version}", { version: claudeEnvironment.data.primary.version })
          : t("已安装")
        : t("未安装");

  return (
    <>
      <OverviewModuleCard
        title={t("AI Agent 接入")}
        description={t("选择适合的 Agent 并查看接入方案")}
      >
        <div className={styles.grid}>
          {AGENTS.map(({ name, description, icon, iconClassName, kind }) => {
            const supported = kind === "claude-code";
            return (
              <button
                key={name}
                type="button"
                className={styles.agentCard}
                aria-label={supported ? t("配置 {name}", { name }) : t("{name} 即将支持", { name })}
                disabled={!supported}
                onClick={() => kind && setSelectedAgent(kind)}
              >
                <span className={`${styles.icon} ${iconClassName}`}>{icon}</span>
                <span className={styles.agentText}>
                  <strong>{name}</strong>
                  <small>{supported ? claudeStatus : t(description)}</small>
                </span>
                <span className={`${styles.support} ${supported ? styles.supported : ""}`}>
                  {supported ? t("查看详情") : t("即将支持")}
                </span>
              </button>
            );
          })}
        </div>
      </OverviewModuleCard>

      <AgentAccessSideSheet
        agent={selectedAgent}
        baseUrl={baseUrl}
        clientToken={clientToken}
        environment={claudeEnvironment.data}
        environmentLoading={claudeEnvironment.isFetching}
        environmentError={claudeEnvironment.error?.message}
        onRefreshEnvironment={() => void claudeEnvironment.refetch()}
        onClose={() => setSelectedAgent(null)}
        onCopy={copy}
      />
    </>
  );
}
