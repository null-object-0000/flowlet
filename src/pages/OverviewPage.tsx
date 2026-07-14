import React from "react";
import {
  ActionIcon,
  Box,
  Button,
  Code,
  Drawer,
  Group,
  SimpleGrid,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import {
  IconChevronRight,
  IconCopy,
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
import { ClientAccessCard } from "../features/clients";
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

      <Drawer
        opened={drawerOpened}
        onClose={() => setDrawerOpened(false)}
        title="API 接入详情"
        position="right"
        size="min(720px, 92vw)"
        padding="md"
      >
        <Box className="api-detail-drawer">
          <section className="api-detail-section">
            <h4><span className="mini-section-icon">▣</span>服务信息</h4>
            <div className="api-detail-row">
              <span className="api-detail-label">服务基础地址</span>
              <Code className="api-detail-value">{baseUrl}</Code>
              <ActionIcon variant="subtle" size="sm" aria-label="复制服务基础地址" onClick={() => void onCopy(baseUrl, "服务基础地址已复制")}>
                <IconCopy size={15} />
              </ActionIcon>
            </div>
            <div className="api-detail-row">
              <span className="api-detail-label">监听地址</span>
              <Code className="api-detail-value">{status.running ? bindConfig.host || "127.0.0.1" : "-"}</Code>
            </div>
            <div className="api-detail-row">
              <span className="api-detail-label">当前端口</span>
              <Code className="api-detail-value">{String(port)}</Code>
            </div>
            <div className="api-detail-row">
              <span className="api-detail-label">健康检查地址</span>
              <Code className="api-detail-value">/health</Code>
              <ActionIcon variant="subtle" size="sm" aria-label="复制健康检查地址" onClick={() => void onCopy(`${baseUrl}/health`, "健康检查地址已复制")}>
                <IconCopy size={15} />
              </ActionIcon>
            </div>
          </section>

          <section className="api-detail-section">
            <h4><span className="mini-section-icon">▤</span>OpenAI-compatible</h4>
            <div className="api-detail-row">
              <span className="api-detail-label">Base URL</span>
              <Code className="api-detail-value">{baseUrl}/v1</Code>
              <ActionIcon variant="subtle" size="sm" aria-label="复制 OpenAI Base URL" onClick={() => void onCopy(`${baseUrl}/v1`, "OpenAI Base URL 已复制")}>
                <IconCopy size={15} />
              </ActionIcon>
            </div>
            <div className="api-detail-row">
              <span className="api-detail-label">模型列表</span>
              <Code className="api-detail-value">GET /v1/models</Code>
              <ActionIcon variant="subtle" size="sm" aria-label="复制模型列表地址" onClick={() => void onCopy(`${baseUrl}/v1/models`, "模型列表地址已复制")}>
                <IconCopy size={15} />
              </ActionIcon>
            </div>
            <div className="api-detail-row">
              <span className="api-detail-label">对话接口</span>
              <Code className="api-detail-value">POST /v1/chat/completions</Code>
              <ActionIcon variant="subtle" size="sm" aria-label="复制对话接口地址" onClick={() => void onCopy(`${baseUrl}/v1/chat/completions`, "对话接口地址已复制")}>
                <IconCopy size={15} />
              </ActionIcon>
            </div>
            <div className="api-detail-row">
              <span className="api-detail-label">鉴权 Header</span>
              <Code className="api-detail-value">Authorization: Bearer &lt;Client Token&gt;</Code>
              <ActionIcon variant="subtle" size="sm" aria-label="复制鉴权 Header" onClick={() => void onCopy("Authorization: Bearer <Client Token>", "鉴权 Header 已复制")}>
                <IconCopy size={15} />
              </ActionIcon>
            </div>
          </section>

          <section className="api-detail-section">
            <h4><span className="mini-section-icon">▤</span>Anthropic-compatible</h4>
            <div className="api-detail-row">
              <span className="api-detail-label">Base URL</span>
              <Code className="api-detail-value">{baseUrl}/anthropic</Code>
              <ActionIcon variant="subtle" size="sm" aria-label="复制 Anthropic Base URL" onClick={() => void onCopy(`${baseUrl}/anthropic`, "Anthropic Base URL 已复制")}>
                <IconCopy size={15} />
              </ActionIcon>
            </div>
            <div className="api-detail-row">
              <span className="api-detail-label">模型列表</span>
              <Code className="api-detail-value">GET /anthropic/v1/models</Code>
              <ActionIcon variant="subtle" size="sm" aria-label="复制 Anthropic 模型列表地址" onClick={() => void onCopy(`${baseUrl}/anthropic/v1/models`, "Anthropic 模型列表地址已复制")}>
                <IconCopy size={15} />
              </ActionIcon>
            </div>
            <div className="api-detail-row">
              <span className="api-detail-label">消息接口</span>
              <Code className="api-detail-value">POST /anthropic/v1/messages</Code>
              <ActionIcon variant="subtle" size="sm" aria-label="复制消息接口地址" onClick={() => void onCopy(`${baseUrl}/anthropic/v1/messages`, "消息接口地址已复制")}>
                <IconCopy size={15} />
              </ActionIcon>
            </div>
            <div className="api-detail-row api-detail-row-multiline">
              <span className="api-detail-label">鉴权 Header</span>
              <Stack gap={4} className="api-detail-stack">
                <Group gap="xs" wrap="nowrap">
                  <Code className="api-detail-value">Authorization: Bearer &lt;Client Token&gt;</Code>
                  <ActionIcon variant="subtle" size="sm" aria-label="复制 Authorization Header" onClick={() => void onCopy("Authorization: Bearer <Client Token>", "Authorization Header 已复制")}>
                    <IconCopy size={15} />
                  </ActionIcon>
                </Group>
                <Group gap="xs" wrap="nowrap">
                  <Code className="api-detail-value">X-Api-Key: &lt;Client Token&gt;</Code>
                  <ActionIcon variant="subtle" size="sm" aria-label="复制 X-Api-Key Header" onClick={() => void onCopy("X-Api-Key: <Client Token>", "X-Api-Key Header 已复制")}>
                    <IconCopy size={15} />
                  </ActionIcon>
                </Group>
              </Stack>
            </div>
          </section>

          <section className="api-detail-section api-detail-security">
            <h4><span className="mini-section-icon">⚠</span>安全提示</h4>
            <ul className="api-detail-warning-list">
              <li>客户端应使用 <Code>Flowlet Client Token</Code>，不要在客户端中直接配置上游渠道的真实 API Key。</li>
              <li>Flowlet 根据 Client Token 识别请求来源，并在转发时替换上游鉴权信息。</li>
            </ul>
          </section>
        </Box>
      </Drawer>
    </div>
  );
}

function rankExposedModel(m: ExposedModel): number {
  if (m.enabled && m.hasAvailableAccount) return 0;
  if (m.enabled) return 1;
  return 2;
}
