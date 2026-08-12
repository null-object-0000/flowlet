import { useState } from "react";
import { Toast } from "@douyinfe/semi-ui-19";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import { OverviewAgentListView, OverviewAgentRowView } from "@flowlet/product-ui";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { AgentAccessSideSheet, type AgentKind } from "./AgentAccessSideSheet";
import { cliInstalledVersion, isNewerVersion } from "../../domains/agent/versions";
import type { AgentEnvironmentReport, AgentGlobalConfigOptions, AgentLatestVersionReport, AgentSurface } from "../../domains/agent/types";
import { AGENT_PLUGINS } from "../../domains/pluginRegistry";
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
        <OverviewAgentListView>
          {AGENT_PLUGINS.map(({ name, iconSrc, tone, id: kind, surfaces }) => {
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
              <OverviewAgentRowView
                key={name}
                name={name}
                iconSrc={iconSrc}
                tone={tone}
                updateAvailable={hasNewer}
                surfaces={[
                  { label: t("CLI"), value: surfaceStatusValue("cli", environmentQuery.data, environmentQuery.isLoading, environmentQuery.isError, t) },
                  ...(surfaces.includes("desktop") ? [{ label: t("Desktop"), value: surfaceStatusValue("desktop", environmentQuery.data, environmentQuery.isLoading, environmentQuery.isError, t) }] : []),
                ]}
                ariaLabel={t("配置 {name}", { name })}
                title={hasNewer ? t("检测到新版本，点击查看详情") : undefined}
                onClick={() => setSelectedAgent(kind)}
              />
            );
          })}
        </OverviewAgentListView>
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

function surfaceStatusValue(
  surface: AgentSurface,
  environment: AgentEnvironmentReport | undefined,
  loading: boolean,
  error: boolean,
  t: (source: string) => string,
) {
  const installation = environment?.installations.find((candidate) => (candidate.surface || "cli") === surface);
  return loading
    ? t("正在检测…")
    : error
      ? t("检测失败")
      : installation
        ? installation.version
          ? installation.version
          : t("已安装")
        : t("未安装");
}
