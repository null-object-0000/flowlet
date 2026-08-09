import { useState } from "react";
import { IconChevronRight } from "@douyinfe/semi-icons";
import { Badge, Toast } from "@douyinfe/semi-ui-19";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import styles from "./OverviewAgentAccessCard.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { AgentAccessSideSheet, type AgentKind } from "./AgentAccessSideSheet";
import { cliInstalledVersion, isNewerVersion } from "../../domains/agent/versions";
import type { AgentEnvironmentReport, AgentGlobalConfigOptions, AgentLatestVersionReport, AgentSurface } from "../../domains/agent/types";
import {
  useChatGptDesktopEnvironment,
  useClaudeCodeEnvironment,
  useClaudeCodeGlobalConfig,
  useCodexGlobalConfig,
  useAgentLatestVersions,
  useOpenCodeEnvironment,
  useOpenCodeGlobalConfig,
  usePiEnvironment,
  usePiGlobalConfig,
} from "./useAgentEnvironment";

const AGENTS: Array<{
  name: string;
  icon: React.ReactNode;
  iconClassName: string;
  kind: AgentKind;
  hasDesktop: boolean;
}> = [
  {
    name: "Claude Code",
    icon: <span className={`${styles.brandIcon} ${styles.claudeCodeMark}`} aria-hidden="true" />,
    iconClassName: styles.claudeIcon,
    kind: "claude-code",
    hasDesktop: false,
  },
  {
    name: "OpenCode",
    icon: <span className={`${styles.brandIcon} ${styles.openCodeMark}`} aria-hidden="true" />,
    iconClassName: styles.openCodeIcon,
    kind: "opencode",
    hasDesktop: true,
  },
  {
    name: "Pi",
    icon: <span className={`${styles.brandIcon} ${styles.piMark}`} aria-hidden="true" />,
    iconClassName: styles.piIcon,
    kind: "pi",
    hasDesktop: false,
  },
  {
    name: "Codex",
    icon: <span className={`${styles.brandIcon} ${styles.chatgptMark}`} aria-hidden="true" />,
    iconClassName: styles.chatgptIcon,
    kind: "codex",
    hasDesktop: true,
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
  const piEnvironment = usePiEnvironment();
  const chatGptEnvironment = useChatGptDesktopEnvironment();
  const latestVersions = useAgentLatestVersions();
  const claudeGlobalConfig = useClaudeCodeGlobalConfig(selectedAgent === "claude-code");
  const openCodeGlobalConfig = useOpenCodeGlobalConfig(selectedAgent === "opencode");
  const piGlobalConfig = usePiGlobalConfig(selectedAgent === "pi");
  const codexGlobalConfig = useCodexGlobalConfig(selectedAgent === "codex");

  const latestByAgent = new Map<string, AgentLatestVersionReport>();
  for (const report of latestVersions.data?.agents ?? []) {
    latestByAgent.set(report.agent_id, report);
  }

  const copy = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(message);
    } catch (error) {
      Toast.error(t("复制失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };

  const activeGlobalConfig = selectedAgent === "opencode"
    ? openCodeGlobalConfig
    : selectedAgent === "pi"
      ? piGlobalConfig
      : selectedAgent === "codex"
        ? codexGlobalConfig
        : claudeGlobalConfig;
  const activeEnvironment = selectedAgent === "opencode"
    ? openCodeEnvironment
    : selectedAgent === "pi"
      ? piEnvironment
      : selectedAgent === "codex"
        ? chatGptEnvironment
        : claudeEnvironment;
  const activeAgentName = selectedAgent === "opencode"
    ? "OpenCode"
    : selectedAgent === "pi"
      ? "Pi"
      : selectedAgent === "codex"
        ? "Codex"
        : "Claude Code";

  const applyGlobalConfig = async (options?: AgentGlobalConfigOptions) => {
    try {
      if (selectedAgent === "claude-code") {
        await claudeGlobalConfig.apply.mutateAsync(options);
      } else if (selectedAgent === "opencode") {
        await openCodeGlobalConfig.apply.mutateAsync();
      } else if (selectedAgent === "pi") {
        await piGlobalConfig.apply.mutateAsync(options);
      } else if (selectedAgent === "codex") {
        await codexGlobalConfig.apply.mutateAsync();
      } else {
        await activeGlobalConfig.apply.mutateAsync(undefined);
      }
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
      <OverviewModuleCard title={t("AI Agent 接入")}>
        <div className={styles.grid}>
          {AGENTS.map(({ name, icon, iconClassName, kind, hasDesktop }) => {
            const environmentQuery = kind === "claude-code"
              ? claudeEnvironment
              : kind === "opencode"
                ? openCodeEnvironment
                : kind === "pi"
                  ? piEnvironment
                  : chatGptEnvironment;
            // 版本更新提示只针对 CLI 包：桌面应用（ChatGPT Desktop / OpenCode Desktop）
            // 是独立版本体系，不参与 npm latest 比较。
            const installedVersion = cliInstalledVersion(environmentQuery.data);
            const hasNewer = isNewerVersion(latestByAgent.get(kind)?.latest_version, installedVersion);
            return (
              <button
                key={name}
                type="button"
                className={styles.agentCard}
                aria-label={t("配置 {name}", { name })}
                title={hasNewer ? t("检测到新版本，点击查看详情") : undefined}
                onClick={() => setSelectedAgent(kind)}
              >
                <Badge dot={hasNewer} type="danger">
                  <span className={`${styles.icon} ${iconClassName}`}>{icon}</span>
                </Badge>
                <span className={styles.agentText}>
                  <strong>{name}</strong>
                  <span className={styles.surfaceStatuses}>
                    <SurfaceStatus
                      label="CLI"
                      surface="cli"
                      environment={environmentQuery.data}
                      loading={environmentQuery.isLoading}
                      error={environmentQuery.isError}
                    />
                    {hasDesktop ? (
                      <SurfaceStatus
                        label="Desktop"
                        surface="desktop"
                        environment={environmentQuery.data}
                        loading={environmentQuery.isLoading}
                        error={environmentQuery.isError}
                      />
                    ) : null}
                  </span>
                </span>
                <IconChevronRight size="small" className={styles.agentChevron} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </OverviewModuleCard>

      <AgentAccessSideSheet
        visible={selectedAgent === "claude-code" || selectedAgent === "opencode" || selectedAgent === "pi" || selectedAgent === "codex"}
        agent={selectedAgent === "opencode" ? "opencode" : selectedAgent === "pi" ? "pi" : selectedAgent === "codex" ? "codex" : "claude-code"}
        baseUrl={baseUrl}
        clientToken={clientToken}
        environment={activeEnvironment.data}
        environmentLoading={activeEnvironment.isFetching}
        environmentError={activeEnvironment.error?.message}
        onRefreshEnvironment={() => {
          void activeEnvironment.refetch();
          void latestVersions.refetch();
        }}
        latestVersion={selectedAgent ? latestByAgent.get(selectedAgent)?.latest_version ?? null : null}
        latestVersionLoading={latestVersions.isFetching}
        latestVersionError={selectedAgent
          ? latestByAgent.get(selectedAgent)?.error ?? (latestVersions.isError ? latestVersions.error?.message : undefined)
          : undefined}
        onRefreshLatestVersion={() => void latestVersions.refetch()}
        globalConfig={activeGlobalConfig.query.data}
        globalConfigLoading={Boolean(selectedAgent && activeGlobalConfig.query.isLoading)}
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
}: {
  label: string;
  surface: AgentSurface;
  environment?: AgentEnvironmentReport;
  loading: boolean;
  error: boolean;
}) {
  const { t } = useAppPreferences();
  const installation = environment?.installations.find((candidate) => (candidate.surface || "cli") === surface);
  const status = loading
    ? t("正在检测…")
    : error
      ? t("检测失败")
      : installation
        ? installation.version
          ? installation.version
          : t("已安装")
        : t("未安装");

  return <small><span>{t(label)}</span><span>{status}</span></small>;
}
