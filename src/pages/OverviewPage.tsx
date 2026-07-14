import React from "react";
import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Code,
  Drawer,
  Group,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconCircleX,
  IconChevronRight,
  IconCopy,
  IconDatabaseImport,
  IconExternalLink,
  IconPlayerPlay,
  IconRefresh,
} from "@tabler/icons-react";
import { Actions, Panel, PanelHeader, StatusPill } from "../components/ui";
import {
  AccountBalanceSnapshot,
  AccountResourceMode,
  ChannelAccount,
  ChannelPreset,
  ClientConfig,
  ProxyBindConfig,
  ProxyStatus,
  RouteCandidate,
  createAccount,
} from "../domain";
import { AccountEditorDrawer, BalanceSnapshotEditor, LongCatPackManager, summarizeLots, parseSnapshotTokenPacks, formatTokenCount, formatLongCatTime, LongCatLot, ChannelAccountOnboarding, ChannelAccountSection, formatIsoDateTime } from "../features/channels";
import { AgentAccessCard } from "../features/agents";
import { ProxyStatusCard } from "../features/proxy";
import { ClientAccessCard } from "../features/clients";
import { ChannelLogo } from "../components/ChannelLogo";
import { ExposedModelsCard } from "../features/routes";
import { buildExposedModels } from "../features/routes/exposedModels";

type AccountEditor = {
  mode: "create" | "edit";
  index: number | null;
  draft: ChannelAccount;
  apiKeyVisible: boolean;
  advancedOpen: boolean;
  snapshotDraft: ResourceSnapshotDraft;
};

type ResourceSnapshotDraft = {
  balance: string;
  currency: string;
  tokenTotal: string;
  tokenUsed: string;
  tokenRemaining: string;
  tokenExpire: string;
  tokenPacks: string;
};

type OverviewPageProps = {
  status: ProxyStatus;
  bindConfig: ProxyBindConfig;
  channels: ChannelPreset[];
  accounts: ChannelAccount[];
  clients: ClientConfig[];
  routes: RouteCandidate[];
  onCopy: (text: string, done: string) => Promise<void>;
  onRefreshAll: () => void;
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

function toDatetimeLocal(value?: string | null): string {
  if (!value) return "";
  const normalized = value.length === 10 ? `${value}T23:59` : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return "";
  const offset = parsed.getTimezoneOffset();
  const local = new Date(parsed.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function fromDatetimeLocal(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function snapshotDraftFrom(account: ChannelAccount, snapshot?: AccountBalanceSnapshot): ResourceSnapshotDraft {
  return {
    balance: snapshot?.balance?.toString() ?? "",
    currency: snapshot?.currency ?? (account.channel_id === "longcat" ? "USD" : "CNY"),
    tokenTotal: snapshot?.token_pack_total?.toString() ?? "",
    tokenUsed: snapshot?.token_pack_used?.toString() ?? "",
    tokenRemaining: snapshot?.token_pack_remaining?.toString() ?? "",
    tokenExpire: toDatetimeLocal(snapshot?.token_pack_expire_at),
    tokenPacks: snapshot?.token_packs ?? "",
  };
}

function parseOptionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function OverviewPage({
  status,
  bindConfig,
  channels,
  accounts,
  clients,
  routes,
  onCopy,
  onRefreshAll,
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
  const [snapshotAccountId, setSnapshotAccountId] = React.useState<string | null>(null);
  const [accountEditor, setAccountEditor] = React.useState<AccountEditor | null>(null);
  const [drawerOpened, setDrawerOpened] = React.useState(false);

  const port = bindConfig.port || Number(status.bind_addr.split(":").pop()) || 18640;
  const baseUrl = `http://127.0.0.1:${port}`;
  const exposedModels = React.useMemo(() => {
    return buildExposedModels(routes, accounts, channels)
      .filter((model) => model.kind === "direct")
      .sort((a, b) => {
        const rank = (m: ReturnType<typeof buildExposedModels>[number]): number => {
          if (m.enabled && m.hasAvailableAccount) return 0;
          if (m.enabled) return 1;
          return 2;
        };
        return rank(a) - rank(b) || a.publicModel.localeCompare(b.publicModel);
      });
  }, [routes, accounts, channels]);
  const hasAccounts = accounts.length > 0;
  const availableAccounts = accounts.filter((account) => account.enabled && !!account.api_key.trim());
  const hasAvailableAccount = availableAccounts.length > 0;
  const hasAvailableModel = exposedModels.some((model) => model.enabled && model.hasAvailableAccount);
  const configurationStatus = !hasAvailableAccount ? "unconfigured" : hasAvailableModel ? "ready" : "no_models";
  const snapshotAccount = accounts.find((account) => account.id === snapshotAccountId);
  const editorChannel = accountEditor ? channels.find((channel) => channel.id === accountEditor.draft.channel_id) : undefined;
  const editorSnapshot = accountEditor ? getBalanceForAccount(accountEditor.draft.id) : undefined;
  const [inlineImportOpened, setInlineImportOpened] = React.useState(false);

  function openCreateAccount(channelId = channels[0]?.id ?? "longcat") {
    const existing = accounts.filter((account) => account.channel_id === channelId);
    const draft = createAccount(channelId, existing.length);
    setAccountEditor({
      mode: "create",
      index: null,
      draft,
      apiKeyVisible: false,
      advancedOpen: false,
      snapshotDraft: snapshotDraftFrom(draft),
    });
  }

  function openEditAccount(index: number) {
    const account = accounts[index];
    if (!account) return;
    setAccountEditor({
      mode: "edit",
      index,
      draft: { ...account },
      apiKeyVisible: false,
      advancedOpen: false,
      snapshotDraft: snapshotDraftFrom(account, getBalanceForAccount(account.id)),
    });
  }

  function updateAccountDraft(patch: Partial<ChannelAccount>) {
    setAccountEditor((current) => {
      if (!current) return current;
      const draft = { ...current.draft, ...patch, updated_at: new Date().toISOString() };
      const channelChanged = patch.channel_id != null && patch.channel_id !== current.draft.channel_id;
      return {
        ...current,
        draft,
        snapshotDraft: channelChanged ? snapshotDraftFrom(draft, getBalanceForAccount(draft.id)) : current.snapshotDraft,
      };
    });
  }

  function updateSnapshotDraft(patch: Partial<ResourceSnapshotDraft>) {
    setAccountEditor((current) => current ? { ...current, snapshotDraft: { ...current.snapshotDraft, ...patch } } : current);
  }

  function handleInlineSavePacks(lots: LongCatLot[]) {
    const summary = summarizeLots(lots);
    setAccountEditor((current) => {
      if (!current) return current;
      return {
        ...current,
        snapshotDraft: {
          ...current.snapshotDraft,
          tokenTotal: String(summary.total),
          tokenUsed: String(summary.used),
          tokenRemaining: String(summary.remaining),
          tokenExpire: summary.expireAt ? toDatetimeLocal(summary.expireAt) : current.snapshotDraft.tokenExpire,
          tokenPacks: JSON.stringify(lots),
        },
      };
    });
    setInlineImportOpened(false);
  }

  async function saveAccountEditor() {
    if (!accountEditor) return;
    const draft = {
      ...accountEditor.draft,
      name: accountEditor.draft.name.trim(),
      api_key: accountEditor.draft.api_key.trim(),
      base_url_override: accountEditor.draft.base_url_override?.trim() || null,
      updated_at: new Date().toISOString(),
    };
    const nextAccounts =
      accountEditor.mode === "create" || accountEditor.index == null
        ? [...accounts, draft]
        : accounts.map((account, index) => (index === accountEditor.index ? draft : account));

    const editorChannel = channels.find((item) => item.id === draft.channel_id);
    const autoSyncBalance = editorChannel?.supports_balance_query === true;

    await onSaveAccounts(nextAccounts);

    // 支持余额自动同步的渠道（DeepSeek）不需要手动快照，保存时已自动同步
    if (!autoSyncBalance) {
      const resource = accountEditor.snapshotDraft;
      const resourceMode = draft.resource_mode ?? (draft.channel_id === "longcat" ? "token_pack" : "pay_as_you_go");
      const hasResourceData = resourceMode === "token_pack"
        ? Boolean(resource.tokenTotal.trim() || resource.tokenUsed.trim() || resource.tokenExpire.trim())
        : Boolean(resource.balance.trim());
      if (hasResourceData) {
        onAddBalanceSnapshot({
          account_id: draft.id,
          balance: resourceMode === "pay_as_you_go" ? parseOptionalNumber(resource.balance) : null,
          currency: resourceMode === "pay_as_you_go" ? resource.currency.trim() || null : null,
          token_pack_total: resourceMode === "token_pack" ? parseOptionalNumber(resource.tokenTotal) : null,
          token_pack_used: resourceMode === "token_pack" ? parseOptionalNumber(resource.tokenUsed) : null,
          token_pack_remaining: resourceMode === "token_pack" ? parseOptionalNumber(resource.tokenRemaining) : null,
          token_pack_expire_at: resourceMode === "token_pack" ? fromDatetimeLocal(resource.tokenExpire) : null,
          token_packs: resourceMode === "token_pack" && resource.tokenPacks?.trim() ? resource.tokenPacks.trim() : null,
          source: "manual",
          synced_at: new Date().toISOString(),
          remark: null,
        });
      }
    }
    setAccountEditor(null);
  }

  async function removeEditingAccount() {
    if (!accountEditor || accountEditor.index == null) return;
    const nextAccounts = accounts.filter((_, index) => index !== accountEditor.index);
    await onSaveAccounts(nextAccounts);
    setAccountEditor(null);
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
          <Button className="overview-action-button refresh" leftSection={<IconRefresh size={16} />} variant="outline" onClick={() => void onRefreshAll()}>刷新数据</Button>
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
              onOpenEditor={(request) => {
                if (request.mode === "create") {
                  openCreateAccount(request.channelId);
                } else {
                  openEditAccount(request.index);
                }
              }}
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
          request={accountEditor.mode === "create"
            ? { mode: "create", channelId: accountEditor.draft.channel_id }
            : { mode: "edit", index: accountEditor.index ?? 0 }}
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
        opened={false}
        onClose={() => setAccountEditor(null)}
        title={accountEditor?.mode === "create" ? "新增渠道账号" : "编辑渠道账号"}
        position="right"
        size="min(760px, 94vw)"
        padding="md"
      >
        {accountEditor ? (
          <>
            <p className="hint">{accountEditor.mode === "create" ? "添加 LongCat 或 DeepSeek 账号，用于上游模型转发。" : "修改账号信息、启用状态与高级配置。"}</p>
            <div className="account-modal-body">
              <section className="account-form-section">
                <h4><span className="mini-section-icon">▣</span>基础信息</h4>
                {accountEditor.mode === "create" ? (
                  <div className="channel-segment">
                    {channels.map((channel) => (
                      <Button
                        type="button"
                        key={channel.id}
                        variant={accountEditor.draft.channel_id === channel.id ? "light" : "default"}
                        onClick={() => updateAccountDraft({ channel_id: channel.id })}
                      >
                        <ChannelLogo channelId={channel.id} channelName={channel.name} size={20} variant="color" />
                        {channel.name}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <Group align="end" gap="xs" wrap="nowrap">
                    <ChannelLogo channelId={accountEditor.draft.channel_id} channelName={getChannelName(accountEditor.draft.channel_id)} size={24} variant="avatar" />
                    <Select label="渠道" value={accountEditor.draft.channel_id} onChange={(value) => value && updateAccountDraft({ channel_id: value })} data={channels.map((channel) => ({ value: channel.id, label: channel.name }))} flex={1} />
                  </Group>
                )}

                <label>
                  账号名称
                  <TextInput value={accountEditor.draft.name} placeholder="请输入账号名称" onChange={(event) => updateAccountDraft({ name: event.target.value })} />
                  <small>便于识别和管理，支持中英文、数字、下划线。</small>
                </label>

                <label>
                  <span className="account-key-label-row">
                    API Key
                    {editorChannel?.platform_url ? (
                      <Anchor
                        href={editorChannel.platform_url}
                        target="_blank"
                        rel="noreferrer"
                        size="xs"
                        className="account-api-key-link"
                      >
                        <IconExternalLink size={12} />
                        前往查看
                      </Anchor>
                    ) : null}
                  </span>
                  <div className="secret-input">
                    <PasswordInput
                      visible={accountEditor.apiKeyVisible}
                      value={accountEditor.draft.api_key}
                      placeholder="请输入 API Key"
                      onChange={(event) => updateAccountDraft({ api_key: event.target.value })}
                    />
                    <Button type="button" variant="default" onClick={() => setAccountEditor((current) => current ? { ...current, apiKeyVisible: !current.apiKeyVisible } : current)}>
                      {accountEditor.apiKeyVisible ? "隐藏" : "显示"}
                    </Button>
                  </div>
                  <small>创建后将加密存储，仅用于与上游服务通信。</small>
                </label>

                <label className="switch-row">
                  <span>启用状态</span>
                  <Switch checked={accountEditor.draft.enabled} onChange={(event) => updateAccountDraft({ enabled: event.currentTarget.checked })} />
                  <strong>{accountEditor.draft.enabled ? "已开启" : "已关闭"}</strong>
                </label>
              </section>

              <section className="account-form-section">
                {editorChannel?.supports_balance_query === true ? (
                  <>
                    <div className="section-headline">
                      <h4><span className="mini-section-icon">▤</span>余额信息（自动同步）</h4>
                      {accountEditor.mode === "edit" ? (
                        <ActionIcon variant="subtle" size="sm" aria-label="同步余额" onClick={() => onSyncBalance(accountEditor.draft.id)}>
                          <IconRefresh size={15} />
                        </ActionIcon>
                      ) : (
                        <span className="sync-badge">自动同步</span>
                      )}
                    </div>
                    <div className="resource-grid">
                      <label>账户余额<div className="static-field">{editorSnapshot != null && editorSnapshot.balance != null ? `${editorSnapshot.balance} ${editorSnapshot.currency ?? ""}` : "尚未同步"}</div></label>
                      <label>货币<div className="static-field">{editorSnapshot?.currency ?? "跟随上游返回"}</div></label>
                      <label>最近更新<TextInput readOnly value={formatIsoDateTime(editorSnapshot?.synced_at)} /></label>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="section-headline">
                      <h4><span className="mini-section-icon">▤</span>余额 / 资源包信息（手动维护）</h4>
                      <span className="sync-badge warn">手动维护</span>
                    </div>
                    {(() => {
                      const mode = accountEditor.draft.resource_mode ?? (accountEditor.draft.channel_id === "longcat" ? "token_pack" : "pay_as_you_go");
                      if (mode !== "token_pack") {
                        return (
                          <div className="resource-grid">
                            <label>账户余额<TextInput type="number" min="0" step="0.01" placeholder="手动填写" value={accountEditor.snapshotDraft.balance} onChange={(event) => updateSnapshotDraft({ balance: event.target.value })} /></label>
                            <label>货币<TextInput value={accountEditor.snapshotDraft.currency} onChange={(event) => updateSnapshotDraft({ currency: event.target.value })} /></label>
                          </div>
                        );
                      }
                      const packs = parseSnapshotTokenPacks(accountEditor.snapshotDraft.tokenPacks);
                      const summary = summarizeLots(packs);
                      return (
                        <div className="account-longcat-import">
                          <Button
                            type="button"
                            variant="subtle"
                            size="xs"
                            leftSection={<IconDatabaseImport size={13} />}
                            onClick={() => setInlineImportOpened(true)}
                          >
                            管理资源包
                          </Button>
                          <small>导入、添加、编辑或删除 LongCat 资源包。</small>
                          {packs.length > 0 ? (
                            <div className="longcat-packs-summary">
                              <span>总量 <strong>{formatTokenCount(summary.total)}</strong></span>
                              <span>已消耗 <strong>{formatTokenCount(summary.used)}</strong></span>
                              <span>剩余 <strong>{formatTokenCount(summary.remaining)}</strong></span>
                              <span>最早到期 <strong>{summary.expireAt ? formatLongCatTime(summary.expireAt) : "-"}</strong></span>
                            </div>
                          ) : null}
                        </div>
                      );
                    })()}
                  </>
                )}
              </section>

              <section className={accountEditor.advancedOpen ? "account-form-section advanced open" : "account-form-section advanced"}>
                <Button variant="subtle" className="advanced-toggle" onClick={() => setAccountEditor((current) => current ? { ...current, advancedOpen: !current.advancedOpen } : current)}>
                  <span>高级配置</span>
                  <span>{accountEditor.advancedOpen ? "⌃" : "⌄"}</span>
                </Button>
                {accountEditor.advancedOpen ? (
                  <div className="advanced-content">
                    <label>Base URL 覆盖（可选）<TextInput value={accountEditor.draft.base_url_override ?? ""} placeholder={editorChannel?.openai_base_url ?? "https://api.example.com/v1"} onChange={(event) => updateAccountDraft({ base_url_override: event.target.value || null })} /></label>
                    <div className="test-row">
                      <Button variant="default" disabled={!accountEditor.draft.api_key?.trim()} onClick={() => onTestConnection(accountEditor.draft.channel_id, accountEditor.draft.api_key, accountEditor.draft.base_url_override)}>测试连接</Button>
                      <span>上次测试：{formatIsoDateTime(accountEditor.draft.last_used_at)}</span>
                      {accountEditor.draft.last_error ? <strong>{accountEditor.draft.last_error}</strong> : null}
                    </div>
                  </div>
                ) : null}
              </section>

              {accountEditor.mode === "edit" ? (
                <section className="danger-zone">
                  <div>
                    <strong>危险区域</strong>
                    <span>删除账号后将无法恢复，请谨慎操作</span>
                  </div>
                  <Button variant="subtle" color="red" onClick={() => void removeEditingAccount()}>删除账号</Button>
                </section>
              ) : null}
            </div>
            <LongCatPackManager
              opened={inlineImportOpened}
              onClose={() => setInlineImportOpened(false)}
              onSave={handleInlineSavePacks}
              initialLots={parseSnapshotTokenPacks(accountEditor?.snapshotDraft.tokenPacks)}
            />
            <footer className="account-modal-footer">
              <Button variant="default" onClick={() => setAccountEditor(null)}>取消</Button>
              <Button onClick={() => void saveAccountEditor()}>{accountEditor.mode === "create" ? "保存账号" : "保存修改"}</Button>
            </footer>
          </>
        ) : null}
      </Drawer>

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

      {snapshotAccount ? (
        <BalanceSnapshotEditor
          account={snapshotAccount}
          channel={channels.find((c) => c.id === snapshotAccount.channel_id)}
          initialSnapshot={getBalanceForAccount(snapshotAccount.id)}
          onCancel={() => setSnapshotAccountId(null)}
          onSave={(snapshot) => { onAddBalanceSnapshot(snapshot); setSnapshotAccountId(null); }}
        />
      ) : null}
    </div>
  );
}
