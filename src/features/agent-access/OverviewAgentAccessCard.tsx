import { useState } from "react";
import { Toast } from "@douyinfe/semi-ui-19";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import { OverviewAgentListView, OverviewAgentRowView } from "@flowlet/product-ui";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { AgentAccessSideSheet, type AgentKind } from "./AgentAccessSideSheet";
import { cliInstalledVersion, isNewerVersion } from "../../domains/agent/versions";
import type { AgentEnvironmentReport, AgentGlobalConfigOptions, AgentLatestVersionReport, AgentSurface } from "../../domains/agent/types";
import { AGENT_PLUGINS, agentPlugin } from "../../domains/pluginRegistry";
import { errorMessage } from "../../shared/errors/AppError";
import {
  useAgentEnvironments,
  useAgentGlobalConfig,
  useAgentLatestVersions,
  useAgentRuntimeActions,
} from "./useAgentEnvironment";

type Props = {
  baseUrl: string;
  clientToken?: string | null;
};

export function OverviewAgentAccessCard({ baseUrl, clientToken }: Props) {
  const { t } = useAppPreferences();
  const [selectedAgent, setSelectedAgent] = useState<AgentKind | null>(null);
  const environments = useAgentEnvironments();
  const latestVersions = useAgentLatestVersions();
  const activeGlobalConfig = useAgentGlobalConfig(selectedAgent);
  const activeRuntime = useAgentRuntimeActions(selectedAgent);

  const latestByAgent = new Map<string, AgentLatestVersionReport>();
  for (const report of latestVersions.data?.agents ?? []) {
    latestByAgent.set(report.agent_id, report);
  }

  const copy = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(message);
    } catch (error) {
      Toast.error(t("复制失败：{message}", { message: errorMessage(error) }));
    }
  };

  const activeEnvironment = selectedAgent ? environments.get(selectedAgent) : undefined;
  const activeAgentName = selectedAgent ? agentPlugin(selectedAgent).name : "Agent";

  const applyGlobalConfig = async (options?: AgentGlobalConfigOptions) => {
    try {
      await activeGlobalConfig.apply.mutateAsync(options);
      Toast.success(t("{name} 已全局接入 Flowlet", { name: activeAgentName }));
    } catch (error) {
      Toast.error(t("写入 {name} 全局配置失败：{message}", { name: activeAgentName, message: errorMessage(error) }));
    }
  };

  const restoreGlobalConfig = async () => {
    try {
      await activeGlobalConfig.restore.mutateAsync();
      Toast.success(t("{name} 全局配置已恢复", { name: activeAgentName }));
    } catch (error) {
      Toast.error(t("恢复 {name} 全局配置失败：{message}", { name: activeAgentName, message: errorMessage(error) }));
    }
  };

  const startRuntime = async () => {
    try {
      await activeRuntime.start.mutateAsync();
      Toast.success(t("{name} 已启动", { name: activeAgentName }));
    } catch (error) {
      Toast.error(t("启动 {name} 失败：{message}", { name: activeAgentName, message: errorMessage(error) }));
    }
  };

  const stopRuntime = async () => {
    try {
      await activeRuntime.stop.mutateAsync();
      Toast.success(t("{name} 已停止", { name: activeAgentName }));
    } catch (error) {
      Toast.error(t("停止 {name} 失败：{message}", { name: activeAgentName, message: errorMessage(error) }));
    }
  };

  return (
    <>
      <OverviewModuleCard title={t("AI Agent 接入")}>
        <OverviewAgentListView>
          {AGENT_PLUGINS.map(({ name, iconSrc, tone, id: kind, surfaces }) => {
            const environmentQuery = environments.get(kind);
            // npm 包版本对应 CLI；DSH 没有 CLI Surface，包版本对应其 Web。
            // Desktop 是独立版本体系，不参与 npm latest 比较。
            const installedVersion = surfaces.includes("cli")
              ? cliInstalledVersion(environmentQuery?.data)
              : environmentQuery?.data?.installations.find((item) => item.surface === "web")?.version ?? null;
            const hasNewer = isNewerVersion(latestByAgent.get(kind)?.latest_version, installedVersion);
            return (
              <OverviewAgentRowView
                key={name}
                name={name}
                iconSrc={iconSrc}
                tone={tone}
                updateAvailable={hasNewer}
                surfaces={[
                  ...(surfaces.includes("cli") ? [{ label: t("CLI"), value: surfaceStatusValue("cli", environmentQuery?.data, environmentQuery?.isLoading ?? false, environmentQuery?.isError ?? false, t) }] : []),
                  ...(surfaces.includes("desktop") ? [{ label: t("Desktop"), value: surfaceStatusValue("desktop", environmentQuery?.data, environmentQuery?.isLoading ?? false, environmentQuery?.isError ?? false, t) }] : []),
                  ...(surfaces.includes("web") ? [{ label: t("Web"), value: surfaceStatusValue("web", environmentQuery?.data, environmentQuery?.isLoading ?? false, environmentQuery?.isError ?? false, t) }] : []),
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
        visible={selectedAgent != null}
        agent={selectedAgent ?? AGENT_PLUGINS[0].id}
        baseUrl={baseUrl}
        clientToken={clientToken}
        environment={activeEnvironment?.data}
        environmentLoading={activeEnvironment?.isFetching ?? false}
        environmentError={activeEnvironment?.error?.message}
        onRefreshEnvironment={() => {
          void activeEnvironment?.refetch();
          void latestVersions.refetch();
        }}
        runtimeBusy={activeRuntime.start.isPending || activeRuntime.stop.isPending}
        runtimeError={activeRuntime.start.error?.message || activeRuntime.stop.error?.message}
        onStartRuntime={startRuntime}
        onStopRuntime={stopRuntime}
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
