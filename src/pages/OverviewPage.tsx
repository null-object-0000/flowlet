import React from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Drawer,
  Group,
  PasswordInput,
  Select,
  SimpleGrid,
  Switch,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import {
  IconBrandOpenai,
  IconChevronRight,
  IconCopy,
  IconDotsVertical,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconRobot,
} from "@tabler/icons-react";
import { Actions, Panel, PanelHeader, ProtocolBadges, StatusPill } from "../components/ui";
import {
  AccountBalanceSnapshot,
  ChannelAccount,
  ChannelPreset,
  ClientConfig,
  ProxyBindConfig,
  ProxyStatus,
  RouteCandidate,
  createAccount,
} from "../domain";
import { BalanceSnapshotEditor } from "../features/channels";
import { accountCountLabel, buildExposedModels } from "../features/routes/exposedModels";

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
  onStartProxy: () => void;
  onStopProxy: () => void;
  onRestartProxy: () => void;
  onSaveAccounts: (nextAccounts?: ChannelAccount[]) => Promise<void>;
  onTestConnection: (accountId: string) => void;
  getBalanceForAccount: (accountId: string) => AccountBalanceSnapshot | undefined;
  onAddBalanceSnapshot: (snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">) => void;
  onUpdateRoute: (index: number, patch: Partial<RouteCandidate>) => void;
  onSaveRoutes: () => void;
  onSyncModels: () => void;
  onOpenAccounts: () => void;
  onOpenModelServices: () => void;
  getChannelName: (channelId: string) => string;
};

function maskSecret(value: string): string {
  if (!value) return "未配置";
  if (value.length <= 8) return `${value.slice(0, 2)}******`;
  return `${value.slice(0, 3)}-${"*".repeat(Math.min(18, value.length - 6))}${value.slice(-3)}`;
}

function formatDateTime(value: Date | null): string {
  if (!value) return "-";
  return value.toLocaleString();
}

function formatIsoDateTime(value?: string | null): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatAmount(value: number | null | undefined, fallback = "-"): string {
  if (value == null) return fallback;
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

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
  };
}

function parseOptionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function channelLogo(channelId: string): string {
  if (channelId === "longcat") return "LC";
  if (channelId === "deepseek") return "DS";
  return channelId.slice(0, 2).toUpperCase();
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "-";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}天 ${hours}小时 ${minutes}分钟`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  return `${minutes}分钟`;
}

function AccountEmptyIllustration() {
  return (
    <div className="overview-empty-illustration" aria-hidden="true">
      <span className="empty-dot dot-a" />
      <span className="empty-dot dot-b" />
      <span className="empty-dot dot-c" />
      <div className="empty-base" />
      <div className="empty-avatar">
        <IconRobot size={34} stroke={1.8} />
      </div>
    </div>
  );
}

function StatusSignal({ running }: { running: boolean }) {
  return (
    <div className={running ? "overview-status-signal running" : "overview-status-signal"} aria-hidden="true">
      <svg viewBox="0 0 64 64">
        <path d="M10 34h10l5-15 10 30 7-20h12" />
      </svg>
    </div>
  );
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
  onStartProxy,
  onStopProxy,
  onRestartProxy,
  onSaveAccounts,
  onTestConnection,
  getBalanceForAccount,
  onAddBalanceSnapshot,
  onUpdateRoute,
  onSaveRoutes,
  onSyncModels,
  onOpenAccounts,
  onOpenModelServices,
  getChannelName,
}: OverviewPageProps) {
  const [snapshotAccountId, setSnapshotAccountId] = React.useState<string | null>(null);
  const [accountEditor, setAccountEditor] = React.useState<AccountEditor | null>(null);
  const [observedStartedAt, setObservedStartedAt] = React.useState<Date | null>(status.running ? new Date() : null);
  const [, forceTick] = React.useState(0);

  React.useEffect(() => {
    if (status.running && !observedStartedAt) setObservedStartedAt(new Date());
    if (!status.running && observedStartedAt) setObservedStartedAt(null);
  }, [status.running, observedStartedAt]);

  React.useEffect(() => {
    const timer = window.setInterval(() => forceTick((value) => value + 1), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const port = bindConfig.port || Number(status.bind_addr.split(":").pop()) || 18640;
  const baseUrl = `http://127.0.0.1:${port}`;
  const exposedModels = buildExposedModels(routes, accounts);
  const hasAccounts = accounts.length > 0;
  const snapshotAccount = accounts.find((account) => account.id === snapshotAccountId);
  const editorChannel = accountEditor ? channels.find((channel) => channel.id === accountEditor.draft.channel_id) : undefined;
  const editorSnapshot = accountEditor ? getBalanceForAccount(accountEditor.draft.id) : undefined;
  const statusMetrics = hasAccounts
    ? [
        ["监听地址", status.running ? bindConfig.host || "127.0.0.1" : "-"],
        ["端口", String(port)],
        ["运行时长", observedStartedAt ? formatDuration(Date.now() - observedStartedAt.getTime()) : "-"],
        ["启动时间", formatDateTime(observedStartedAt)],
        ["平均响应时间", "-"],
        ["成功率", "-"],
      ]
    : [
        ["运行时长", observedStartedAt ? formatDuration(Date.now() - observedStartedAt.getTime()) : "-"],
        ["启动时间", formatDateTime(observedStartedAt)],
        ["成功率", "-"],
        ["平均响应时间", "-"],
      ];

  const agentCards = [
    ["Claude Code", "官方 CLI 工具", `${baseUrl}/anthropic`],
    ["Cline", "VS Code 扩展", `${baseUrl}/v1`],
    ["OpenCode", "智能编码助手", `${baseUrl}/v1`],
    ["Continue", "开源 AI 助手", `${baseUrl}/v1`],
  ];

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

    await onSaveAccounts(nextAccounts);

    const resource = accountEditor.snapshotDraft;
    const hasResourceData = [resource.balance, resource.tokenTotal, resource.tokenUsed, resource.tokenRemaining, resource.tokenExpire].some((value) => value.trim());
    if (hasResourceData) {
      const isLongCat = draft.channel_id === "longcat";
      onAddBalanceSnapshot({
        account_id: draft.id,
        balance: isLongCat ? null : parseOptionalNumber(resource.balance),
        currency: isLongCat ? null : resource.currency.trim() || null,
        token_pack_total: isLongCat ? parseOptionalNumber(resource.tokenTotal) : null,
        token_pack_used: isLongCat ? parseOptionalNumber(resource.tokenUsed) : null,
        token_pack_remaining: isLongCat ? parseOptionalNumber(resource.tokenRemaining) : null,
        token_pack_expire_at: isLongCat ? fromDatetimeLocal(resource.tokenExpire) : null,
        source: "manual",
        synced_at: new Date().toISOString(),
        remark: null,
      });
    }
    setAccountEditor(null);
  }

  async function removeEditingAccount() {
    if (!accountEditor || accountEditor.index == null) return;
    const nextAccounts = accounts.filter((_, index) => index !== accountEditor.index);
    await onSaveAccounts(nextAccounts);
    setAccountEditor(null);
  }

  function accountState(account: ChannelAccount): string {
    if (!account.api_key.trim()) return "未配置";
    return account.enabled ? "已启用" : "已停用";
  }

  function accountResource(account: ChannelAccount): string {
    const snapshot = getBalanceForAccount(account.id);
    if (account.channel_id === "longcat") {
      return `${formatAmount(snapshot?.token_pack_remaining)} 上下文`;
    }
    if (snapshot?.balance != null) {
      return `${formatAmount(snapshot.balance)} ${snapshot.currency ?? ""}`;
    }
    return "-";
  }

  function modelState(model: ReturnType<typeof buildExposedModels>[number]): string {
    if (!model.hasAvailableAccount) return "不可用";
    return model.enabled ? "已启用" : "已停用";
  }

  function setModelEnabled(routeIndexes: number[], enabled: boolean) {
    routeIndexes.forEach((routeIndex) => onUpdateRoute(routeIndex, { enabled }));
    window.setTimeout(() => void onSaveRoutes(), 0);
  }

  function switchModelAccount(routeIndexes: number[], accountId: string) {
    const account = accounts.find((item) => item.id === accountId);
    if (!account) return;
    routeIndexes.forEach((routeIndex) => onUpdateRoute(routeIndex, { account_id: account.id, channel_id: account.channel_id }));
  }

  return (
    <div className="overview-page overview-guide">
      <header className="page-header overview-guide-header">
        <div>
          <h2>概览</h2>
          <p>系统状态总览与接入引导</p>
        </div>
        <Actions>
          <Button className="overview-action-button primary" leftSection={<IconPlayerPlay size={16} />} onClick={onStartProxy} disabled={status.running}>启动</Button>
          <Button className="overview-action-button" leftSection={<IconPlayerStop size={16} />} variant="default" color="gray" onClick={onStopProxy} disabled={!status.running}>停止</Button>
          <Button className="overview-action-button" leftSection={<IconRefresh size={16} />} variant="default" onClick={onRestartProxy} disabled={!hasAccounts}>重启</Button>
          <Button className="overview-action-button refresh" leftSection={<IconRefresh size={16} />} variant="default" onClick={() => void onRefreshAll()}>刷新数据</Button>
        </Actions>
      </header>

      <Panel className="overview-status-card">
        <div className="overview-status-layout">
          <div>
            <Group gap="xs">
              <h3>代理服务状态</h3>
              <Badge color={status.running ? "green" : "orange"} variant="light">{status.running ? "运行中" : "未运行"}</Badge>
            </Group>
            <Text className={status.running ? "overview-state-text running" : "overview-state-text"}>
              {status.running ? "服务正在监听本地请求" : hasAccounts ? "账号已配置，可以启动代理服务" : "未完全配置"}
            </Text>
            {!hasAccounts ? <Text size="sm" c="dimmed">请先配置并启动代理服务以提供 API 访问。</Text> : null}
          </div>
          <div className="overview-status-metrics">
            {statusMetrics.map(([label, value]) => (
              <div key={label}><span>{label}</span><strong>{value}</strong></div>
            ))}
          </div>
          <StatusSignal running={status.running} />
        </div>
      </Panel>

      {!hasAccounts ? (
        <Panel className="overview-onboarding-card">
          <PanelHeader>
            <h3>渠道账号</h3>
          </PanelHeader>
          <div className="overview-empty-state">
            <AccountEmptyIllustration />
            <Text className="overview-empty-title">
              你还没有添加任何渠道账号，先添加 LongCat 或 DeepSeek 账号后，
              才能开放模型并接入客户端与 AI Agent。
            </Text>
            <Group justify="center" gap="md">
              <Button size="sm" className="longcat-action" onClick={() => openCreateAccount("longcat")}>添加 LongCat 账号</Button>
              <Button size="sm" onClick={() => openCreateAccount("deepseek")}>添加 DeepSeek 账号</Button>
            </Group>
            <div className="overview-steps">
              <span />
              <strong>接入流程（仅需 3 步）</strong>
              <span />
            </div>
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="lg" className="overview-step-grid">
              <div><b>1</b><strong>添加渠道账号</strong><span>选择 LongCat 或 DeepSeek</span></div>
              <div><b>2</b><strong>开放模型</strong><span>选择并开放模型给代理</span></div>
              <div><b>3</b><strong>接入客户端 / AI Agent</strong><span>获取访问地址并开始使用</span></div>
            </SimpleGrid>
          </div>
        </Panel>
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, lg: 2 }} spacing={16}>
            <Panel className="overview-section-card">
              <PanelHeader>
                <div>
                  <h3>渠道账号</h3>
                  <Text size="sm" c="dimmed">已添加 {accounts.length} 个渠道账号</Text>
                </div>
              </PanelHeader>
              <div className="overview-list">
                {accounts.slice(0, 3).map((account, index) => (
                  <div className="overview-account-row" key={account.id}>
                    <span className={`provider-mark channel-${account.channel_id}`}>{channelLogo(account.channel_id)}</span>
                    <div className="row-main">
                      <strong>{getChannelName(account.channel_id)}</strong>
                      <span>{account.name} · {maskSecret(account.api_key)}</span>
                    </div>
                    <StatusPill running={account.enabled && !!account.api_key.trim()}>{accountState(account)}</StatusPill>
                    <span className="overview-resource">{accountResource(account)}</span>
                    <ActionIcon variant="subtle" onClick={() => openEditAccount(index)} aria-label="编辑账号"><IconDotsVertical size={17} /></ActionIcon>
                  </div>
                ))}
              </div>
              <Button variant="subtle" rightSection={<IconChevronRight size={15} />} onClick={onOpenAccounts}>查看全部渠道账号</Button>
            </Panel>

            <Panel className="overview-section-card">
              <PanelHeader>
                <div>
                  <h3>开放模型</h3>
                  <Text size="sm" c="dimmed">已开放 {exposedModels.filter((model) => model.enabled).length} 个模型</Text>
                </div>
                <Button variant="default" onClick={() => void onSyncModels()}>同步模型</Button>
              </PanelHeader>
              <div className="overview-list">
                {exposedModels.length === 0 ? <Text c="dimmed">暂无模型。请同步或进入模型服务生成默认模型。</Text> : null}
                {exposedModels.slice(0, 3).map((model) => {
                  const channelAccounts = accounts.filter((account) => account.channel_id === model.channelId);
                  return (
                    <div className="overview-model-row" key={`${model.channelId}:${model.publicModel}`}>
                      <span className={`provider-mark channel-${model.channelId}`}>{channelLogo(model.channelId)}</span>
                      <div className="row-main">
                        <strong>{model.publicModel}</strong>
                        <span>{getChannelName(model.channelId)} · {model.upstreamModel}</span>
                      </div>
                      <Select
                        value={model.accountId}
                        onChange={(value) => value && switchModelAccount(model.routeIndexes, value)}
                        data={channelAccounts.map((account) => ({ value: account.id, label: account.name }))}
                      />
                      <StatusPill running={model.enabled && model.hasAvailableAccount}>{modelState(model)}</StatusPill>
                      <Switch checked={model.enabled} onChange={(event) => setModelEnabled(model.routeIndexes, event.currentTarget.checked)} />
                    </div>
                  );
                })}
              </div>
              <Button variant="subtle" rightSection={<IconChevronRight size={15} />} onClick={onOpenModelServices}>查看全部模型</Button>
            </Panel>
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, lg: 2 }} spacing={16}>
            <Panel className="overview-section-card">
              <PanelHeader>
                <div>
                  <h3>客户端访问信息</h3>
                  <Text size="sm" c="dimmed">使用以下地址在指定客户端中配置</Text>
                </div>
              </PanelHeader>
              <div className="overview-endpoints">
                <div>
                  <span>OpenAI 兼容端点</span>
                  <code>{baseUrl}/v1</code>
                  <Button variant="default" leftSection={<IconCopy size={14} />} onClick={() => void onCopy(`${baseUrl}/v1`, "OpenAI Base URL 已复制")}>复制</Button>
                </div>
                <div>
                  <span>Anthropic 兼容端点</span>
                  <code>{baseUrl}/anthropic</code>
                  <Button variant="default" leftSection={<IconCopy size={14} />} onClick={() => void onCopy(`${baseUrl}/anthropic`, "Anthropic Base URL 已复制")}>复制</Button>
                </div>
              </div>
              <Text className="overview-note">支持 OpenAI 与 Anthropic 兼容协议，可直接在各类客户端中配置使用。</Text>
            </Panel>

            <Panel className="overview-section-card">
              <PanelHeader>
                <div>
                  <h3>AI Agent 接入</h3>
                  <Text size="sm" c="dimmed">选择接入的 Agent 并复制配置</Text>
                </div>
              </PanelHeader>
              <div className="overview-agent-grid">
                {agentCards.map(([name, desc, endpoint]) => (
                  <UnstyledButton
                    type="button"
                    className="overview-agent-card"
                    key={name}
                    onClick={() => void onCopy(endpoint, `${name} 接入地址已复制`)}
                  >
                    <span>{name === "Claude Code" ? <IconBrandOpenai size={28} /> : <IconRobot size={28} />}</span>
                    <strong>{name}</strong>
                    <small>{desc}</small>
                  </UnstyledButton>
                ))}
              </div>
              <Button variant="subtle" rightSection={<IconChevronRight size={15} />} onClick={() => void onCopy(`${baseUrl}/v1`, "接入地址已复制")}>查看接入指南</Button>
            </Panel>
          </SimpleGrid>
        </>
      )}

      <Drawer
        opened={accountEditor != null}
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
                        <span className={`provider-mark channel-${channel.id}`}>{channelLogo(channel.id)}</span>
                        {channel.name}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <Group align="end" gap="xs" wrap="nowrap">
                    <span className={`provider-mark channel-${accountEditor.draft.channel_id}`}>{channelLogo(accountEditor.draft.channel_id)}</span>
                    <Select label="渠道" value={accountEditor.draft.channel_id} onChange={(value) => value && updateAccountDraft({ channel_id: value })} data={channels.map((channel) => ({ value: channel.id, label: channel.name }))} flex={1} />
                  </Group>
                )}

                <label>
                  账号名称
                  <TextInput value={accountEditor.draft.name} placeholder="请输入账号名称" onChange={(event) => updateAccountDraft({ name: event.target.value })} />
                  <small>便于识别和管理，支持中英文、数字、下划线。</small>
                </label>

                <label>
                  API Key
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
                <div className="section-headline">
                  <h4><span className="mini-section-icon">▤</span>余额 / 资源包信息（手动维护）</h4>
                  {accountEditor.draft.channel_id === "longcat" ? <span className="sync-badge warn">不支持自动同步</span> : <span className="sync-badge">支持自动同步</span>}
                </div>

                {accountEditor.draft.channel_id === "longcat" ? (
                  <>
                    <div className="resource-grid">
                      <label>资源包剩余<div className="unit-input"><TextInput type="number" min="0" value={accountEditor.snapshotDraft.tokenRemaining} onChange={(event) => updateSnapshotDraft({ tokenRemaining: event.target.value })} /><span>Tokens</span></div></label>
                      <label>已消耗<div className="unit-input"><TextInput type="number" min="0" value={accountEditor.snapshotDraft.tokenUsed} onChange={(event) => updateSnapshotDraft({ tokenUsed: event.target.value })} /><span>Tokens</span></div></label>
                      <label>资源包总量<div className="unit-input"><TextInput type="number" min="0" value={accountEditor.snapshotDraft.tokenTotal} onChange={(event) => updateSnapshotDraft({ tokenTotal: event.target.value })} /><span>Tokens</span></div></label>
                      <label>过期时间<TextInput type="datetime-local" value={accountEditor.snapshotDraft.tokenExpire} onChange={(event) => updateSnapshotDraft({ tokenExpire: event.target.value })} /></label>
                    </div>
                    <Button variant="default" disabled={accountEditor.mode === "create"} onClick={() => { setAccountEditor(null); setSnapshotAccountId(accountEditor.draft.id); }}>
                      登记资源包
                    </Button>
                  </>
                ) : (
                  <div className="resource-grid">
                    <label>余额<div className="unit-input"><TextInput type="number" min="0" step="0.01" value={accountEditor.snapshotDraft.balance} onChange={(event) => updateSnapshotDraft({ balance: event.target.value })} /><span>{accountEditor.snapshotDraft.currency || "CNY"}</span></div></label>
                    <label>货币<TextInput value={accountEditor.snapshotDraft.currency} onChange={(event) => updateSnapshotDraft({ currency: event.target.value })} /></label>
                    <label>最近更新时间<TextInput readOnly value={formatIsoDateTime(editorSnapshot?.synced_at)} /></label>
                    <div className="field-action"><Button variant="default" disabled={accountEditor.mode === "create"} onClick={() => onTestConnection(accountEditor.draft.id)}>同步余额</Button></div>
                  </div>
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
                      <Button variant="default" disabled={accountEditor.mode === "create"} onClick={() => onTestConnection(accountEditor.draft.id)}>测试连接</Button>
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
            <footer className="account-modal-footer">
              <Button variant="default" onClick={() => setAccountEditor(null)}>取消</Button>
              <Button onClick={() => void saveAccountEditor()}>{accountEditor.mode === "create" ? "保存账号" : "保存修改"}</Button>
            </footer>
          </>
        ) : null}
      </Drawer>

      {snapshotAccount ? (
        <BalanceSnapshotEditor
          account={snapshotAccount}
          initialSnapshot={getBalanceForAccount(snapshotAccount.id)}
          onCancel={() => setSnapshotAccountId(null)}
          onSave={(snapshot) => { onAddBalanceSnapshot(snapshot); setSnapshotAccountId(null); }}
        />
      ) : null}
    </div>
  );
}
