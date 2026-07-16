import { useState } from "react";
import { Toast } from "@douyinfe/semi-ui-19";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import styles from "./OverviewAgentAccessCard.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { AgentAccessSideSheet, type AgentKind } from "./AgentAccessSideSheet";
import type { AgentEnvironmentReport, AgentSurface } from "../../domains/agent/types";
import {
  useClaudeCodeEnvironment,
  useClaudeCodeGlobalConfig,
  useOpenCodeEnvironment,
  useOpenCodeGlobalConfig,
} from "./useAgentEnvironment";

const AGENTS: Array<{
  name: string;
  description: string;
  icon: React.ReactNode;
  iconClassName: string;
  kind?: AgentKind;
}> = [
  {
    name: "Claude Code",
    description: "CLI 接入",
    icon: <span className={`${styles.brandIcon} ${styles.claudeCodeMark}`} aria-hidden="true" />,
    iconClassName: styles.claudeIcon,
    kind: "claude-code",
  },
  {
    name: "OpenCode",
    description: "CLI / Desktop 接入",
    icon: <span className={`${styles.brandIcon} ${styles.openCodeMark}`} aria-hidden="true" />,
    iconClassName: styles.openCodeIcon,
    kind: "opencode",
  },
  {
    name: "ChatGPT Desktop",
    description: "客户端接入",
    icon: <span className={`${styles.brandIcon} ${styles.chatgptMark}`} aria-hidden="true" />,
    iconClassName: styles.chatgptIcon,
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
  const openCodeEnvironment = useOpenCodeEnvironment();
  const claudeGlobalConfig = useClaudeCodeGlobalConfig(selectedAgent === "claude-code");
  const openCodeGlobalConfig = useOpenCodeGlobalConfig(selectedAgent === "opencode");

  const copy = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(message);
    } catch (error) {
      Toast.error(t("复制失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };


  const activeGlobalConfig = selectedAgent === "opencode" ? openCodeGlobalConfig : claudeGlobalConfig;
  const activeEnvironment = selectedAgent === "opencode" ? openCodeEnvironment : claudeEnvironment;
  const activeAgentName = selectedAgent === "opencode" ? "OpenCode" : "Claude Code";

  const applyGlobalConfig = async () => {
    try {
      await activeGlobalConfig.apply.mutateAsync();
      Toast.success(t("{name} 已全局接入 Flowlet", { name: activeAgentName }));
    } catch (error) {
      Toast.error(t("写入 {name} 全局配置失败：{message}", { name: activeAgentName, message: error instanceof Error ? error.message : String(error) }));
    }
  };

  const restoreGlobalConfig = async () => {
    try {
      await activeGlobalConfig.restore.mutateAsync();
      Toast.success(t("{name} 全局配置已恢复", { name: activeAgentName }));
    } catch (error) {
      Toast.error(t("恢复 {name} 全局配置失败：{message}", { name: activeAgentName, message: error instanceof Error ? error.message : String(error) }));
    }
  };

  return (
    <>
      <OverviewModuleCard
        title={t("AI Agent 接入")}
        description={t("选择适合的 Agent 并查看接入方案")}
      >
        <div className={styles.grid}>
          {AGENTS.map(({ name, description, icon, iconClassName, kind }) => {
            const supported = kind === "claude-code" || kind === "opencode";
            const environmentQuery = kind === "claude-code" ? claudeEnvironment : openCodeEnvironment;
            return (
              <button
                key={name}
                type="button"
                className={styles.agentCard}
                aria-label={supported ? t("配置 {name}", { name }) : t("{name} 即将支持", { name })}
                disabled={!supported}
                onClick={() => {
                  if (kind) setSelectedAgent(kind);
                }}
              >
                <span className={`${styles.icon} ${iconClassName}`}>{icon}</span>
                <span className={styles.agentText}>
                  <strong>{name}</strong>
                  {supported ? (
                    <span className={styles.surfaceStatuses}>
                      <SurfaceStatus label="CLI" surface="cli" environment={environmentQuery.data} loading={environmentQuery.isLoading} error={environmentQuery.isError} />
                      <SurfaceStatus
                        label="Desktop"
                        surface="desktop"
                        environment={environmentQuery.data}
                        loading={environmentQuery.isLoading}
                        error={environmentQuery.isError}
                        unsupported={kind === "claude-code"}
                      />
                    </span>
                  ) : <small>{t(description)}</small>}
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
        visible={selectedAgent !== null}
        agent={selectedAgent || "claude-code"}
        baseUrl={baseUrl}
        clientToken={clientToken}
        environment={activeEnvironment.data}
        environmentLoading={activeEnvironment.isFetching}
        environmentError={activeEnvironment.error?.message}
        onRefreshEnvironment={() => void activeEnvironment.refetch()}
        globalConfig={activeGlobalConfig.query.data}
        globalConfigLoading={selectedAgent !== null && activeGlobalConfig.query.isLoading}
        globalConfigBusy={activeGlobalConfig.apply.isPending || activeGlobalConfig.restore.isPending}
        globalConfigError={activeGlobalConfig.query.error?.message}
        onRefreshGlobalConfig={() => void activeGlobalConfig.query.refetch()}
        onApplyGlobalConfig={applyGlobalConfig}
        onRestoreGlobalConfig={restoreGlobalConfig}
        onClose={() => setSelectedAgent(null)}
        onCopy={copy}
      />
    </>
  );
}
function SurfaceStatus({
  label,
  surface,
  environment,
  loading,
  error,
  unsupported = false,
}: {
  label: string;
  surface: AgentSurface;
  environment?: AgentEnvironmentReport;
  loading: boolean;
  error: boolean;
  unsupported?: boolean;
}) {
  const { t } = useAppPreferences();
  const installation = environment?.installations.find((candidate) => (candidate.surface || "cli") === surface);
  const status = unsupported
    ? t("暂不支持")
    : loading
      ? t("正在检测…")
      : error
        ? t("检测失败")
        : installation
          ? installation.version
            ? t("已安装 · {version}", { version: installation.version })
            : t("已安装")
          : t("未安装");

  return <small><span>{t(label)}</span><span>{status}</span></small>;
}
