import React from "react";
import {
  ActionIcon,
  Badge,
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
  IconBrandOpenai,
  IconCircleX,
  IconChevronRight,
  IconCopy,
  IconDotsVertical,
  IconInfoCircle,
  IconPlayerPlay,
  IconRefresh,
  IconRobot,
} from "@tabler/icons-react";
import { Actions, Panel, PanelHeader, StatusPill } from "../components/ui";
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
import { AccountEditorDrawer, BalanceSnapshotEditor } from "../features/channels";
import { ChannelLogo } from "../components/ChannelLogo";
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

/** RFC3339 字符串转换为 YYYY-MM-DD HH:mm:ss（与前端展示风格一致）。 */
function formatRfc3339(value?: string | null): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  // 与 AGENTS.md / OverviewPage 现有格式保持一致。
  return parsed.toLocaleString();
}

function formatAmount(value: number | null | undefined, fallback = "-"): string {
  if (value == null) return fallback;
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function snapshotDraftFrom(account: ChannelAccount, snapshot?: AccountBalanceSnapshot): ResourceSnapshotDraft {
  return {
    balance: snapshot?.balance?.toString() ?? "",
    currency: snapshot?.currency ?? (account.channel_id === "longcat" ? "USD" : "CNY"),
  };
}

function parseOptionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
  proxyStarting,
  proxyStartError,
  autoStartAttempted,
  onStartProxy,
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
  const [drawerOpened, setDrawerOpened] = React.useState(false);

  // 当后端回传的 running / started_at 状态变化时同步本地显示起点。
  // 仅在后端尚未提供新启动时间时回退为本地「首次观察到 running」的时刻。
  React.useEffect(() => {
    if (status.running) {
      // 后端补充了 started_at 时直接使用，否则回退并用当前渲染时刻近似。
      const backendStamp = status.started_at;
      if (backendStamp && observedStartedAt) {
        const observedIso = observedStartedAt.toISOString();
        if (observedIso !== backendStamp) setObservedStartedAt(new Date(backendStamp));
      }
      if (!observedStartedAt && !backendStamp) setObservedStartedAt(new Date());
    } else {
      if (observedStartedAt) setObservedStartedAt(null);
    }
  }, [status.running, status.started_at]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    const timer = window.setInterval(() => forceTick((value) => value + 1), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const port = bindConfig.port || Number(status.bind_addr.split(":").pop()) || 18640;
  const baseUrl = `http://127.0.0.1:${port}`;
  const exposedModels = buildExposedModels(routes, accounts);
  const hasAccounts = accounts.length > 0;
  const availableAccounts = accounts.filter((account) => account.enabled && !!account.api_key.trim());
  const hasAvailableAccount = availableAccounts.length > 0;
  const hasAvailableModel = exposedModels.some((model) => model.enabled && model.hasAvailableAccount);
  const configurationStatus = !hasAvailableAccount ? "unconfigured" : hasAvailableModel ? "ready" : "no_models";
  const proxyPhase = proxyStarting ? "starting" : proxyStartError ? "failed" : status.running ? "running" : "stopped";
  const snapshotAccount = accounts.find((account) => account.id === snapshotAccountId);
  const editorChannel = accountEditor ? channels.find((channel) => channel.id === accountEditor.draft.channel_id) : undefined;
  const editorSnapshot = accountEditor ? getBalanceForAccount(accountEditor.draft.id) : undefined;

  // 启动时间：优先复用后端提供的真实启动时间（跨会话保持），回退本地观察到 running 的时刻。
  const startedAtDate = status.started_at ? new Date(status.started_at) : observedStartedAt;
  const statusMetrics: Array<{ label: string; value: string; hint?: string }> = [
    { label: "监听地址", value: status.running ? bindConfig.host || "127.0.0.1" : "-" },
    { label: "端口", value: String(port) },
    {
      label: "运行时长",
      value: startedAtDate ? formatDuration(Date.now() - startedAtDate.getTime()) : "-",
      hint: startedAtDate ? `启动时间：${formatRfc3339(startedAtDate.toISOString())}` : undefined,
    },
  ];

  const proxyHint = proxyPhase === "failed"
    ? `错误原因：${proxyStartError}`
    : proxyPhase === "starting"
      ? "正在启动本地代理服务…"
      : proxyPhase === "stopped"
        ? autoStartAttempted ? "代理服务已停止，可重新启动。" : "等待启动代理服务。"
        : configurationStatus === "unconfigured"
          ? "代理服务已启动，但尚未配置渠道账号，当前没有可用模型。"
          : configurationStatus === "no_models"
            ? "渠道账号已配置，请开放至少一个模型后开始使用。"
            : "服务正在监听本地请求";
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
    const hasResourceData = resource.balance.trim() || resource.currency.trim();
    if (hasResourceData) {
      onAddBalanceSnapshot({
        account_id: draft.id,
        balance: parseOptionalNumber(resource.balance),
        currency: resource.currency.trim() || null,
        token_pack_total: null,
        token_pack_used: null,
        token_pack_remaining: null,
        token_pack_expire_at: null,
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

  return (
    <div className="overview-page overview-guide">
      <header className="page-header overview-guide-header">
        <div>
          <h2>概览</h2>
          <p>系统状态总览与接入引导</p>
        </div>
        <Actions>
          {proxyPhase === "running" ? (
            <Button className="overview-action-button" leftSection={<IconRefresh size={16} />} variant="default" onClick={onRestartProxy}>重启服务</Button>
          ) : proxyPhase === "starting" ? (
            <Button className="overview-action-button" leftSection={<IconRefresh size={16} />} disabled>正在启动…</Button>
          ) : (
            <Button className="overview-action-button primary" leftSection={<IconPlayerPlay size={16} />} onClick={onStartProxy}>
              {proxyPhase === "failed" ? "重新启动" : "启动服务"}
            </Button>
          )}
          <Button className="overview-action-button refresh" leftSection={<IconRefresh size={16} />} variant="default" onClick={() => void onRefreshAll()}>刷新数据</Button>
        </Actions>
      </header>

      <Panel className="overview-status-card">
        <div className="overview-status-layout">
          <div className="overview-status-intro">
            <Group gap="xs">
              <h3>代理服务状态</h3>
              <Badge color={proxyPhase === "running" ? "green" : proxyPhase === "failed" ? "red" : "orange"} variant="light">
                {proxyPhase === "running" ? "运行中" : proxyPhase === "starting" ? "正在启动" : proxyPhase === "failed" ? "启动失败" : "已停止"}
              </Badge>
            </Group>
            <Text size="sm" className={proxyPhase === "running" ? "overview-state-text running" : proxyPhase === "failed" ? "overview-state-text failed" : "overview-state-text"}>
              {proxyHint}
            </Text>
          </div>
          <div className="overview-status-metrics">
            {statusMetrics.map((item) => (
              <div className="overview-status-metric" key={item.label}>
                <span>{item.label}</span>
                <div className="overview-metric-value">
                  <strong>{item.value}</strong>
                  {item.hint ? (
                    <Tooltip label={item.hint} withArrow position="top">
                      <ActionIcon className="overview-hint-icon" variant="transparent" size="xs" aria-label="启动时间提示">
                        <IconInfoCircle size={13} />
                      </ActionIcon>
                    </Tooltip>
                  ) : null}
                </div>
              </div>
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
                <Button className="overview-view-all" variant="subtle" rightSection={<IconChevronRight size={15} />} onClick={onOpenAccounts}>查看全部</Button>
              </PanelHeader>
              <div className="overview-list">
                {accounts.slice(0, 3).map((account, index) => (
                  <div className="overview-account-card" key={account.id}>
                    <div className="overview-card-main">
                      <ChannelLogo channelId={account.channel_id} channelName={getChannelName(account.channel_id)} size={32} variant="avatar" />
                      <div className="row-main"><strong>{account.name || getChannelName(account.channel_id)}</strong><span>{getChannelName(account.channel_id)}</span></div>
                      <StatusPill running={account.enabled && !!account.api_key.trim()}>{accountState(account)}</StatusPill>
                      <ActionIcon variant="subtle" onClick={() => openEditAccount(index)} aria-label="编辑账号"><IconDotsVertical size={17} /></ActionIcon>
                    </div>
                    <div className="overview-card-meta"><span>余额: {accountResource(account)}</span></div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel className="overview-section-card">
              <PanelHeader>
                <div>
                  <h3>开放模型</h3>
                  <Text size="sm" c="dimmed">已开放 {exposedModels.filter((model) => model.enabled).length} 个模型</Text>
                </div>
                <Button className="overview-view-all" variant="subtle" rightSection={<IconChevronRight size={15} />} onClick={onOpenModelServices}>查看全部</Button>
              </PanelHeader>
              <div className="overview-list">
                {exposedModels.length === 0 ? <Text c="dimmed">暂无模型。请同步或进入模型服务生成默认模型。</Text> : null}
                {exposedModels.map((model) => (
                  <div className="overview-model-card" key={model.publicModel}>
                    <div className="overview-card-main model summary">
                      <span className="provider-mark">FL</span>
                      <div className="row-main">
                        <strong>{model.publicModel === "flowlet-pro" ? "Flowlet Pro" : "Flowlet Flash"}</strong>
                        <span>{model.publicModel}</span>
                      </div>
                      <StatusPill running={model.enabled && model.hasAvailableAccount}>{modelState(model)}</StatusPill>
                      <Switch checked={model.enabled} onChange={(event) => setModelEnabled(model.routeIndexes, event.currentTarget.checked)} />
                    </div>
                    <div className="overview-card-meta">
                      <span>底层模型: {model.underlyingModelCount}</span>
                      <span>可用账号: {model.availableAccountCount}</span>
                      <span>状态: {model.hasAvailableAccount ? "正常" : "不可用"}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, lg: 2 }} spacing={16}>
            <Panel className="overview-section-card">
              <PanelHeader>
                <div>
                  <h3>客户端访问信息</h3>
                </div>
                <Button className="overview-view-all" variant="subtle" rightSection={<IconChevronRight size={15} />} onClick={() => setDrawerOpened(true)}>查看接入详情</Button>
              </PanelHeader>
              <div className="overview-endpoints">
                <div className="overview-endpoint-row">
                  <span>OpenAI Base URL</span>
                  <Code className="overview-endpoint-url">{baseUrl}/v1</Code>
                  <Button variant="default" size="xs" leftSection={<IconCopy size={14} />} onClick={() => void onCopy(`${baseUrl}/v1`, "OpenAI Base URL 已复制")}>复制</Button>
                </div>
                <div className="overview-endpoint-row">
                  <span>Anthropic Base URL</span>
                  <Code className="overview-endpoint-url">{baseUrl}/anthropic</Code>
                  <Button variant="default" size="xs" leftSection={<IconCopy size={14} />} onClick={() => void onCopy(`${baseUrl}/anthropic`, "Anthropic Base URL 已复制")}>复制</Button>
                </div>
                <div className="overview-endpoint-row">
                  <span>健康检查地址</span>
                  <Code className="overview-endpoint-url">{baseUrl}/health</Code>
                  <Button variant="default" size="xs" leftSection={<IconCopy size={14} />} onClick={() => void onCopy(`${baseUrl}/health`, "健康检查地址已复制")}>复制</Button>
                </div>
              </div>
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
            </Panel>
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
                  <h4><span className="mini-section-icon">▤</span>余额信息（手动维护）</h4>
                  <span className="sync-badge warn">手动维护</span>
                </div>

                <div className="resource-grid">
                  <label>余额<div className="unit-input"><TextInput type="number" min="0" step="0.01" value={accountEditor.snapshotDraft.balance} onChange={(event) => updateSnapshotDraft({ balance: event.target.value })} /><span>{accountEditor.snapshotDraft.currency || "CNY"}</span></div></label>
                  <label>货币<TextInput value={accountEditor.snapshotDraft.currency} onChange={(event) => updateSnapshotDraft({ currency: event.target.value })} /></label>
                  <label>最近更新时间<TextInput readOnly value={formatIsoDateTime(editorSnapshot?.synced_at)} /></label>
                </div>
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
          initialSnapshot={getBalanceForAccount(snapshotAccount.id)}
          onCancel={() => setSnapshotAccountId(null)}
          onSave={(snapshot) => { onAddBalanceSnapshot(snapshot); setSnapshotAccountId(null); }}
        />
      ) : null}
    </div>
  );
}
