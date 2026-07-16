import React from "react";
import {
  Button,
  SimpleGrid,
  UnstyledButton,
} from "@mantine/core";
import {
  IconChevronRight,
  IconPlayerPlay,
  IconRefresh,
} from "@tabler/icons-react";
import { Actions } from "../components/ui";
import {
  AccountBalanceSnapshot,
  ChannelAccount,
  ChannelPreset,
  ClientConfig,
  ProxyBindConfig,
  ProxyStatus,
  RouteCandidate,
} from "../domain";
import { AccountEditorDrawer, ChannelAccountOnboarding, ChannelAccountSection } from "../features/channels";
import { AgentAccessCard } from "../features/agents";
import { ProxyStatusCard } from "../features/proxy";
import { ApiAccessDrawer, ClientAccessCard } from "../features/clients";
import { ExposedModelsCard } from "../features/routes";
import { buildExposedModels, ExposedModel } from "../features/routes/exposedModels";

type AccountEditorRequest =
  | { mode: "create"; channelId: string }
  | { mode: "edit"; index: number };

type OverviewPageProps = {
  status: ProxyStatus;
  bindConfig: ProxyBindConfig;
  channels: ChannelPreset[];
  accounts: ChannelAccount[];
  clients: ClientConfig[];
  routes: RouteCandidate[];
  onCopy: (text: string, done: string) => Promise<void>;
  proxyStarting: boolean;
  proxyStartError: string | null;
  autoStartAttempted: boolean;
  onStartProxy: () => void;
  onRestartProxy: () => void;
  onSaveAccounts: (nextAccounts?: ChannelAccount[]) => Promise<void>;
  onTestConnection: (channelId: string, apiKey: string, baseUrlOverride?: string | null) => void;
  onSyncBalance: (accountId: string) => void;
  getBalanceForAccount: (accountId: string) => AccountBalanceSnapshot | undefined;
  onAddBalanceSnapshot: (snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">) => void;
  onUpdateRoute: (index: number, patch: Partial<RouteCandidate>) => void;
  onSaveRoutes: () => void;
  onSyncModels: () => void;
  onOpenModelServices: () => void;
  getChannelName: (channelId: string) => string;
  setDefaultClientToken: (token: string) => void;
};

export function OverviewPage({
  status,
  bindConfig,
  channels,
  accounts,
  clients,
  routes,
  onCopy,
  proxyStarting,
  proxyStartError,
  autoStartAttempted,
  onStartProxy,
  onRestartProxy,
  onSaveAccounts,
  onTestConnection,
  onSyncBalance,
  getBalanceForAccount,
  onAddBalanceSnapshot,
  onUpdateRoute,
  onSaveRoutes,
  onSyncModels,
  onOpenModelServices,
  getChannelName,
  setDefaultClientToken,
}: OverviewPageProps) {
  const [accountEditor, setAccountEditor] = React.useState<AccountEditorRequest | null>(null);
  const [drawerOpened, setDrawerOpened] = React.useState(false);

  const port = bindConfig.port || Number(status.bind_addr.split(":").pop()) || 18640;
  const baseUrl = `http://127.0.0.1:${port}`;
  const exposedModels = React.useMemo(() => {
    return buildExposedModels(routes, accounts, channels)
      .filter((model) => model.kind === "direct")
      .sort((a, b) => rankExposedModel(a) - rankExposedModel(b) || a.publicModel.localeCompare(b.publicModel));
  }, [routes, accounts, channels]);
  const hasAccounts = accounts.length > 0;
  const availableAccounts = accounts.filter((account) => account.enabled && !!account.api_key.trim());
  const hasAvailableAccount = availableAccounts.length > 0;
  const hasAvailableModel = exposedModels.some((model) => model.enabled && model.hasAvailableAccount);
  const configurationStatus = !hasAvailableAccount ? "unconfigured" : hasAvailableModel ? "ready" : "no_models";

  function openCreateAccount(channelId = channels[0]?.id ?? "longcat") {
    setAccountEditor({ mode: "create", channelId });
  }

  function openEditAccount(index: number) {
    if (!accounts[index]) return;
    setAccountEditor({ mode: "edit", index });
  }

  const proxyPhase = proxyStarting ? "starting" : proxyStartError ? "failed" : status.running ? "running" : "stopped";

  return (
    <div className="overview-page overview-guide">
      <header className="page-header overview-guide-header">
        <div>
          <h2>概览</h2>
          <p>系统状态总览与接入引导</p>
        </div>
        <Actions>
          {proxyPhase === "running" ? (
            <Button className="overview-action-button restart" leftSection={<IconRefresh size={16} />} variant="outline" onClick={onRestartProxy}>重启服务</Button>
          ) : proxyPhase === "starting" ? (
            <Button className="overview-action-button" leftSection={<IconRefresh size={16} />} disabled>正在启动…</Button>
          ) : (
            <Button className="overview-action-button primary" leftSection={<IconPlayerPlay size={16} />} onClick={onStartProxy}>
              {proxyPhase === "failed" ? "重新启动" : "启动服务"}
            </Button>
          )}
        </Actions>
      </header>

      <ProxyStatusCard
        status={status}
        bindConfig={bindConfig}
        proxyStarting={proxyStarting}
        proxyStartError={proxyStartError}
        autoStartAttempted={autoStartAttempted}
        configurationStatus={configurationStatus}
      />

      {!hasAccounts ? (
        <ChannelAccountOnboarding onCreateAccount={openCreateAccount} />
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, lg: 2 }} spacing={16}>
            <ChannelAccountSection
              accounts={accounts}
              channels={channels}
              getBalanceForAccount={getBalanceForAccount}
              getChannelName={getChannelName}
              onCreateAccount={openCreateAccount}
              onEditAccount={openEditAccount}
              onSaveAccounts={onSaveAccounts}
              onTestConnection={onTestConnection}
              onSyncBalance={onSyncBalance}
              onAddBalanceSnapshot={onAddBalanceSnapshot}
              onOpenEditor={(request) => setAccountEditor(request)}
            />

            <ExposedModelsCard
              exposedModels={exposedModels}
              onOpenModelServices={onOpenModelServices}
              onUpdateRoute={onUpdateRoute}
              onSaveRoutes={onSaveRoutes}
            />
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, lg: 2 }} spacing={16}>
            <ClientAccessCard
              baseUrl={baseUrl}
              defaultClientToken={bindConfig.default_client_token}
              onCopy={onCopy}
              onViewDetails={() => setDrawerOpened(true)}
            />

            <AgentAccessCard baseUrl={baseUrl} onCopy={onCopy} />
          </SimpleGrid>
        </>
      )}

      {accountEditor ? (
        <AccountEditorDrawer
          request={accountEditor}
          accounts={accounts}
          channels={channels}
          onClose={() => setAccountEditor(null)}
          onSaveAccounts={onSaveAccounts}
          onTestConnection={onTestConnection}
          onSyncBalance={onSyncBalance}
          getBalanceForAccount={getBalanceForAccount}
          onAddBalanceSnapshot={onAddBalanceSnapshot}
        />
      ) : null}

      <ApiAccessDrawer
        opened={drawerOpened}
        onClose={() => setDrawerOpened(false)}
        baseUrl={baseUrl}
        bindConfig={bindConfig}
        running={status.running}
        onCopy={onCopy}
      />
    </div>
  );
}

function rankExposedModel(m: ExposedModel): number {
  if (m.enabled && m.hasAvailableAccount) return 0;
  if (m.enabled) return 1;
  return 2;
}
