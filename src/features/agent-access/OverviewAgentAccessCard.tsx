import { useState } from "react";
import { Toast } from "@douyinfe/semi-ui-19";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import styles from "./OverviewAgentAccessCard.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { AgentAccessSideSheet, type AgentKind } from "./AgentAccessSideSheet";
import { ChatGptDesktopSideSheet } from "./ChatGptDesktopSideSheet";
import type { AgentEnvironmentReport, AgentGlobalConfigOptions, AgentSurface } from "../../domains/agent/types";
import {
  useChatGptDesktopEnvironment,
  useClaudeCodeEnvironment,
  useClaudeCodeGlobalConfig,
  useCodexAccountAuthorization,
  useCodexAccounts,
  useOpenCodeEnvironment,
  useOpenCodeGlobalConfig,
  usePiEnvironment,
  usePiGlobalConfig,
} from "./useAgentEnvironment";

type SupportedAgentKind = AgentKind | "chatgpt-desktop";

const AGENTS: Array<{
  name: string;
  icon: React.ReactNode;
  iconClassName: string;
  kind: SupportedAgentKind;
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
    name: "ChatGPT (Codex)",
    icon: <span className={`${styles.brandIcon} ${styles.chatgptMark}`} aria-hidden="true" />,
    iconClassName: styles.chatgptIcon,
    kind: "chatgpt-desktop",
    hasDesktop: true,
  },
];

type Props = {
  baseUrl: string;
  clientToken?: string | null;
};

export function OverviewAgentAccessCard({ baseUrl, clientToken }: Props) {
  const { t } = useAppPreferences();
  const [selectedAgent, setSelectedAgent] = useState<SupportedAgentKind | null>(null);
  const claudeEnvironment = useClaudeCodeEnvironment();
  const openCodeEnvironment = useOpenCodeEnvironment();
  const piEnvironment = usePiEnvironment();
  const chatGptEnvironment = useChatGptDesktopEnvironment();
  const codexAccounts = useCodexAccounts(selectedAgent === "chatgpt-desktop");
  const codexAccountAuthorization = useCodexAccountAuthorization();
  const claudeGlobalConfig = useClaudeCodeGlobalConfig(selectedAgent === "claude-code");
  const openCodeGlobalConfig = useOpenCodeGlobalConfig(selectedAgent === "opencode");
  const piGlobalConfig = usePiGlobalConfig(selectedAgent === "pi");

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
      : claudeGlobalConfig;
  const activeEnvironment = selectedAgent === "opencode"
    ? openCodeEnvironment
    : selectedAgent === "pi"
      ? piEnvironment
      : claudeEnvironment;
  const activeAgentName = selectedAgent === "opencode"
    ? "OpenCode"
    : selectedAgent === "pi"
      ? "Pi"
      : "Claude Code";

  const applyGlobalConfig = async (options?: AgentGlobalConfigOptions) => {
    try {
      // 仅 Claude Code 支持可选参数（1M 长上下文开关）；其他 Agent 忽略。
      if (selectedAgent === "claude-code") {
        await claudeGlobalConfig.apply.mutateAsync(options);
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

  const authorizeCodexAccount = async () => {
    try {
      await codexAccountAuthorization.mutateAsync();
      await codexAccounts.refetch();
      Toast.success(t("Codex 账号授权成功"));
    } catch (error) {
      Toast.error(t("Codex 账号授权失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
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
            return (
              <button
                key={name}
                type="button"
                className={styles.agentCard}
                aria-label={t("配置 {name}", { name })}
                onClick={() => setSelectedAgent(kind)}
              >
                <span className={`${styles.icon} ${iconClassName}`}>{icon}</span>
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
                <span className={`${styles.support} ${styles.supported}`}>{t("查看详情")}</span>
              </button>
            );
          })}
        </div>
      </OverviewModuleCard>

      <AgentAccessSideSheet
        visible={selectedAgent === "claude-code" || selectedAgent === "opencode" || selectedAgent === "pi"}
        agent={selectedAgent === "opencode" ? "opencode" : selectedAgent === "pi" ? "pi" : "claude-code"}
        baseUrl={baseUrl}
        clientToken={clientToken}
        environment={activeEnvironment.data}
        environmentLoading={activeEnvironment.isFetching}
        environmentError={activeEnvironment.error?.message}
        onRefreshEnvironment={() => void activeEnvironment.refetch()}
        globalConfig={activeGlobalConfig.query.data}
        globalConfigLoading={Boolean(selectedAgent && selectedAgent !== "chatgpt-desktop" && activeGlobalConfig.query.isLoading)}
        globalConfigBusy={activeGlobalConfig.apply.isPending || activeGlobalConfig.restore.isPending}
        globalConfigError={activeGlobalConfig.query.error?.message}
        onRefreshGlobalConfig={() => void activeGlobalConfig.query.refetch()}
        onApplyGlobalConfig={applyGlobalConfig}
        onRestoreGlobalConfig={restoreGlobalConfig}
        onClose={() => setSelectedAgent(null)}
        onCopy={copy}
      />
      <ChatGptDesktopSideSheet
        visible={selectedAgent === "chatgpt-desktop"}
        environment={chatGptEnvironment.data}
        loading={chatGptEnvironment.isFetching}
        error={chatGptEnvironment.error?.message}
        onRefresh={() => void chatGptEnvironment.refetch()}
        accounts={codexAccounts.data}
        accountLoading={codexAccounts.isFetching}
        accountError={codexAccounts.error?.message}
        onRefreshAccount={() => void codexAccounts.refetch()}
        accountAuthorizationBusy={codexAccountAuthorization.isPending}
        onAuthorizeAccount={() => void authorizeCodexAccount()}
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
