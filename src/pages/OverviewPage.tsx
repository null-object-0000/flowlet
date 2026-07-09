import React from "react";
import { ActionIcon, Button, Drawer, Group, PasswordInput, Select, Switch, TextInput } from "@mantine/core";
import { IconExternalLink, IconX } from "@tabler/icons-react";
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

type Drawer = "apis" | "tokens" | "accounts" | "models" | null;

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

type CardIconName = "status" | "access" | "token" | "accounts" | "models" | "quick";

const cardIconPaths: Record<CardIconName, string> = {
  status: "M12 3a9 9 0 1 0 9 9 M12 3a9 9 0 0 1 9 9 M3 12h18 M12 3c2.5 2.5 3.8 5.5 3.8 9S14.5 18.5 12 21 M12 3C9.5 5.5 8.2 8.5 8.2 12S9.5 18.5 12 21",
  access: "M7 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M17 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M4 21v-2a4 4 0 0 1 4-4h1 M14 21v-2a4 4 0 0 1 4-4h2",
  token: "M12 3l7 3v5c0 4.5-2.7 8.4-7 10-4.3-1.6-7-5.5-7-10V6l7-3Z M12 9v5 M12 17h.01",
  accounts: "M12 3l8 4-8 4-8-4 8-4Z M4 12l8 4 8-4 M4 17l8 4 8-4",
  models: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z M12 8v8 M8 10.2l4 2.3 4-2.3",
  quick: "M5 19l4-11 4 6 3-9 3 14 M4 19h16",
};

function CardIcon({ name }: { name: CardIconName }) {
  return (
    <span className="section-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d={cardIconPaths[name]} /></svg>
    </span>
  );
}

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
  onAddAccount: (channelId: string) => void;
  onUpdateAccount: (index: number, patch: Partial<ChannelAccount>) => void;
  onRemoveAccount: (index: number) => void;
  onSaveAccounts: (nextAccounts?: ChannelAccount[]) => Promise<void>;
  onTestConnection: (accountId: string) => void;
  getBalanceForAccount: (accountId: string) => AccountBalanceSnapshot | undefined;
  onAddBalanceSnapshot: (snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">) => void;
  onAddClient: () => void;
  onUpdateClient: (index: number, patch: Partial<ClientConfig>) => void;
  onRemoveClient: (index: number) => void;
  onSaveClients: () => void;
  onUpdateRoute: (index: number, patch: Partial<RouteCandidate>) => void;
  onSaveRoutes: () => void;
  onSyncModels: () => void;
  onOpenAdvancedSettings: () => void;
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
  if (channelId === "longcat") return "♛";
  if (channelId === "deepseek") return "◆";
  return "●";
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "-";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时 ${minutes} 分钟`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function tokenSeed(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `flowlet-${Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 18)}`;
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
  onAddAccount,
  onUpdateAccount,
  onRemoveAccount,
  onSaveAccounts,
  onTestConnection,
  getBalanceForAccount,
  onAddBalanceSnapshot,
  onAddClient,
  onUpdateClient,
  onRemoveClient,
  onSaveClients,
  onUpdateRoute,
  onSaveRoutes,
  onSyncModels,
  onOpenAdvancedSettings,
  getChannelName,
}: OverviewPageProps) {
  const [drawer, setDrawer] = React.useState<Drawer>(null);
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

  const defaultClient = clients[0];
  const port = bindConfig.port || Number(status.bind_addr.split(":").pop()) || 18640;
  const endpointHost = bindConfig.allow_lan || bindConfig.host === "0.0.0.0" ? "127.0.0.1" : "127.0.0.1";
  const baseUrl = `http://${endpointHost}:${port}`;
  const exposedModels = buildExposedModels(routes, accounts);
  const snapshotAccount = accounts.find((account) => account.id === snapshotAccountId);
  const editorChannel = accountEditor ? channels.find((channel) => channel.id === accountEditor.draft.channel_id) : undefined;
  const editorSnapshot = accountEditor ? getBalanceForAccount(accountEditor.draft.id) : undefined;

  const apiItems = [
    ["OpenAI Base URL", `${baseUrl}/v1`],
    ["Anthropic Base URL", `${baseUrl}/anthropic`],
    ["健康检查", `${baseUrl}/health`],
    ["OpenAI 模型列表", `${baseUrl}/v1/models`],
    ["Anthropic 模型列表", `${baseUrl}/anthropic/v1/models`],
    ["OpenAI Chat Completions", `${baseUrl}/v1/chat/completions`],
    ["Anthropic Messages", `${baseUrl}/anthropic/v1/messages`],
  ];

  function channelInitial(channelId: string): string {
    if (channelId === "longcat") return "LC";
    if (channelId === "deepseek") return "DS";
    return getChannelName(channelId).slice(0, 2).toUpperCase();
  }

  function accountStatus(account: ChannelAccount): string {
    if (!account.api_key.trim()) return "未配置";
    return account.enabled ? "可用" : "未启用";
  }

  function accountModelCount(account: ChannelAccount): number {
    return routes.filter((route) => route.account_id === account.id && route.enabled).length;
  }

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

  function modelState(model: ReturnType<typeof buildExposedModels>[number]): string {
    if (!model.hasAvailableAccount) return "不可用";
    return model.enabled ? "已开放" : "已关闭";
  }

  function setModelEnabled(routeIndexes: number[], enabled: boolean) {
    routeIndexes.forEach((routeIndex) => onUpdateRoute(routeIndex, { enabled }));
  }

  function switchModelAccount(routeIndexes: number[], accountId: string) {
    const account = accounts.find((item) => item.id === accountId);
    if (!account) return;
    routeIndexes.forEach((routeIndex) => onUpdateRoute(routeIndex, { account_id: account.id, channel_id: account.channel_id }));
  }

  function regenerateDefaultToken() {
    if (!defaultClient) {
      onAddClient();
      setDrawer("tokens");
      return;
    }
    onUpdateClient(0, { token: tokenSeed() });
    window.setTimeout(() => void onSaveClients(), 0);
  }

  return (
    <div className="overview-page">
      <header className="page-header">
        <div>
          <h2>概览</h2>
          <p>Flowlet 状态总览与快速操作</p>
        </div>
        <Button type="button" onClick={() => void onRefreshAll()}>刷新数据</Button>
      </header>

      <section className="dashboard-grid top-cards">
        <Panel className="dashboard-card status-card">
          <PanelHeader>
            <h3><CardIcon name="status" />代理状态</h3>
            <Actions>
              <Button type="button" variant="default" onClick={onStartProxy} disabled={status.running}>启动</Button>
              <Button type="button" variant="default" onClick={onStopProxy} disabled={!status.running}>停止</Button>
              <Button type="button" variant="default" onClick={onRestartProxy}>重启</Button>
            </Actions>
          </PanelHeader>
          <div className="status-card-body">
            <div className="status-hero">
              <strong>{status.running ? "运行中" : "已停止"}</strong>
              <span className={status.running ? "dot-text ok" : "dot-text muted-dot"}>{status.running ? "连接正常" : "等待启动"}</span>
            </div>
            <div className="status-visual" aria-hidden="true">
              <span className="layer layer-top" />
              <span className="layer layer-mid" />
              <span className="layer layer-bottom" />
            </div>
          </div>
          <dl className="info-list">
            <div><dt>本地端口</dt><dd>{port}</dd></div>
            <div><dt>启动时间</dt><dd>{formatDateTime(observedStartedAt)}</dd></div>
            <div><dt>运行时长</dt><dd>{observedStartedAt ? formatDuration(Date.now() - observedStartedAt.getTime()) : "-"}</dd></div>
            <div><dt>允许局域网连接</dt><dd><StatusPill running={bindConfig.allow_lan}>{bindConfig.allow_lan ? "已开启" : "未开启"}</StatusPill></dd></div>
          </dl>
        </Panel>

        <Panel className="dashboard-card access-card">
          <PanelHeader><h3><CardIcon name="access" />客户端访问信息</h3></PanelHeader>
          <div className="endpoint-list">
            <div className="endpoint-row">
              <div><span>OpenAI 协议</span><strong>{baseUrl}/v1</strong></div>
              <Button type="button" variant="default" onClick={() => void onCopy(`${baseUrl}/v1`, "OpenAI Base URL 已复制")}>复制</Button>
            </div>
            <div className="endpoint-row">
              <div><span>Anthropic 协议</span><strong>{baseUrl}/anthropic</strong></div>
              <Button type="button" variant="default" onClick={() => void onCopy(`${baseUrl}/anthropic`, "Anthropic Base URL 已复制")}>复制</Button>
            </div>
          </div>
          <Button type="button" variant="subtle" onClick={() => setDrawer("apis")}>查看所有 API</Button>
        </Panel>

        <Panel className="dashboard-card token-card">
          <PanelHeader>
            <h3><CardIcon name="token" />客户端令牌</h3>
            <Button type="button" variant="default" onClick={regenerateDefaultToken}>重新生成</Button>
          </PanelHeader>
          <div className="token-box">
            <span>当前默认 Token</span>
            <strong>{defaultClient?.name ?? "未创建客户端"}</strong>
            <code>{defaultClient ? `Bearer ${maskSecret(defaultClient.token)}` : "Bearer -"}</code>
            <Button type="button" variant="default" disabled={!defaultClient} onClick={() => defaultClient && void onCopy(`Bearer ${defaultClient.token}`, "Bearer Token 已复制")}>复制</Button>
          </div>
          <Button type="button" variant="subtle" onClick={() => setDrawer("tokens")}>管理 Token</Button>
        </Panel>
      </section>

      <section className="dashboard-grid list-cards">
        <Panel className="dashboard-card wide-card">
          <PanelHeader>
            <h3><CardIcon name="accounts" />上游账户</h3>
            <Button type="button" variant="default" onClick={() => openCreateAccount()}>新增账号</Button>
          </PanelHeader>
          <div className="console-list">
            {accounts.length === 0 ? <p className="muted">暂无上游账号。请新增 LongCat 或 DeepSeek 账号。</p> : null}
            {accounts.slice(0, 5).map((account, index) => (
              <div className="console-row" key={account.id}>
                <span className={`avatar-mark channel-${account.channel_id}`}>{channelInitial(account.channel_id)}</span>
                <div className="row-main">
                  <strong>{getChannelName(account.channel_id)}</strong>
                  <span>{account.name} · {maskSecret(account.api_key)}</span>
                </div>
                <StatusPill running={account.enabled && !!account.api_key.trim()}>{accountStatus(account)}</StatusPill>
                <span className="muted">{accountModelCount(account)} 个模型</span>
                <Actions>
                  <Button type="button" variant="subtle" onClick={() => openEditAccount(index)}>编辑</Button>
                  {account.channel_id === "longcat" ? <Button type="button" variant="subtle" onClick={() => setSnapshotAccountId(account.id)}>登记资源包</Button> : null}
                  {account.channel_id === "deepseek" ? <Button type="button" variant="subtle" onClick={() => onTestConnection(account.id)}>同步余额</Button> : null}
                  <Button type="button" variant="subtle" onClick={() => setDrawer("accounts")}>更多</Button>
                </Actions>
              </div>
            ))}
          </div>
          <div className="card-footer-line"><span>共 {accounts.length} 个账户</span><Button type="button" variant="subtle" onClick={() => setDrawer("accounts")}>查看全部</Button></div>
        </Panel>

        <Panel className="dashboard-card wide-card">
          <PanelHeader>
            <h3><CardIcon name="models" />已暴露模型</h3>
            <Actions>
              <Button type="button" variant="default" onClick={() => void onSyncModels()}>同步模型</Button>
              <Button type="button" variant="default" onClick={() => setDrawer("models")}>查看全部</Button>
            </Actions>
          </PanelHeader>
          <div className="console-list">
            {exposedModels.length === 0 ? <p className="muted">暂无已暴露模型。</p> : null}
            {exposedModels.slice(0, 5).map((model) => (
              <div className="console-row model-row" key={`${model.channelId}:${model.publicModel}`}>
                <div className="row-main">
                  <strong>{model.publicModel}</strong>
                  <span>{getChannelName(model.channelId)}</span>
                </div>
                <StatusPill running={model.enabled && model.hasAvailableAccount}>{modelState(model)}</StatusPill>
                <span className="muted">{accountCountLabel(model.accountIds.length)}</span>
                <ActionIcon variant="subtle" onClick={() => setDrawer("models")} aria-label="操作"><IconExternalLink size={16} /></ActionIcon>
              </div>
            ))}
          </div>
          <div className="card-footer-line">
            <span>共 {exposedModels.length} 个模型</span>
            <Button type="button" variant="subtle" onClick={() => setDrawer("models")}>查看全部</Button>
          </div>
        </Panel>
      </section>

      <Panel className="dashboard-card quick-start-card">
        <PanelHeader><h3><CardIcon name="quick" />快速开始</h3><Button type="button" variant="default">查看配置示例</Button></PanelHeader>
        <div className="steps-row">
          {[
            ["配置客户端", "将连接 URL 配置到您的 AI 客户端中"],
            ["获取令牌", "在客户端中设置 Bearer Token"],
            ["选择模型", "从可用模型列表中选择合适的模型"],
            ["开始使用", "通过 Flowlet 访问 AI 服务"],
          ].map(([step, desc], index) => (
            <React.Fragment key={step}>
              <div className="step-card">
                <span>{index + 1}</span>
                <div><strong>{step}</strong><small>{desc}</small></div>
              </div>
              {index < 3 ? <span className="step-arrow" aria-hidden="true">›</span> : null}
            </React.Fragment>
          ))}
        </div>
      </Panel>

      <Drawer
        opened={drawer != null}
        onClose={() => setDrawer(null)}
        title={drawer === "apis" ? "所有可用 API" : drawer === "tokens" ? "管理 Token" : drawer === "accounts" ? "管理上游账户" : drawer === "models" ? "管理已暴露模型" : ""}
        position="right"
        size="min(720px, 92vw)"
        padding="md"
        className="console-drawer-root"
      >
        {drawer ? (
          <>
            {drawer === "apis" ? (
              <div className="drawer-list">
                {apiItems.map(([label, url]) => (
                  <div className="endpoint-row" key={label}>
                    <div><span>{label}</span><strong>{url}</strong></div>
                    <Button type="button" variant="default" onClick={() => void onCopy(url, `${label} 已复制`)}>复制</Button>
                  </div>
                ))}
              </div>
            ) : null}
            {drawer === "tokens" ? (
              <div className="drawer-list">
                <Actions>
                  <Button type="button" variant="default" onClick={onAddClient}>新增客户端</Button>
                  <Button type="button" onClick={() => void onSaveClients()}>保存 Token</Button>
                </Actions>
                {clients.map((client, index) => (
                  <div className="editor-card" key={client.id}>
                    <TextInput value={client.name} onChange={(event) => onUpdateClient(index, { name: event.target.value })} />
                    <TextInput value={client.token} onChange={(event) => onUpdateClient(index, { token: event.target.value })} />
                    <Select value={client.app_type} onChange={(value) => value && onUpdateClient(index, { app_type: value })} data={[
                      { value: "local", label: "本机" },
                      { value: "claude-code", label: "Claude Code" },
                      { value: "cursor", label: "Cursor" },
                      { value: "cline", label: "Cline" },
                      { value: "open-webui", label: "Open WebUI" },
                      { value: "custom", label: "自定义" },
                    ]} />
                    <Actions>
                      <Button type="button" variant="default" onClick={() => void onCopy(`Bearer ${client.token}`, "Bearer Token 已复制")}>复制</Button>
                      <Button type="button" variant="default" onClick={() => onUpdateClient(index, { token: tokenSeed() })}>重新生成</Button>
                      <Button type="button" variant="subtle" color="red" onClick={() => onRemoveClient(index)}>删除</Button>
                    </Actions>
                  </div>
                ))}
              </div>
            ) : null}
            {drawer === "accounts" ? (
              <div className="drawer-list">
                <Actions>
                  {channels.map((channel) => <Button type="button" variant="default" key={channel.id} onClick={() => openCreateAccount(channel.id)}>新增{channel.name}</Button>)}
                </Actions>
                <div className="account-drawer-table">
                  {accounts.map((account, index) => {
                    const snapshot = getBalanceForAccount(account.id);
                    return (
                      <div className="account-drawer-row" key={account.id}>
                        <span className={`provider-mark channel-${account.channel_id}`}>{channelLogo(account.channel_id)}</span>
                        <div className="row-main">
                          <strong>{account.name}</strong>
                          <span>{getChannelName(account.channel_id)} · {maskSecret(account.api_key)}</span>
                        </div>
                        <StatusPill running={account.enabled && !!account.api_key.trim()}>{accountStatus(account)}</StatusPill>
                        <span className="muted">
                          {account.channel_id === "longcat"
                            ? `${formatAmount(snapshot?.token_pack_remaining)} Tokens`
                            : snapshot?.balance != null
                              ? `${formatAmount(snapshot.balance)} ${snapshot.currency ?? ""}`
                              : "-"}
                        </span>
                        <Button type="button" variant="default" onClick={() => openEditAccount(index)}>编辑</Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {drawer === "models" ? (
              <div className="drawer-list">
                <Actions>
                  <Button type="button" variant="default" onClick={() => void onSyncModels()}>同步模型</Button>
                  <Button type="button" variant="default" onClick={onOpenAdvancedSettings}>进入模型服务</Button>
                  <Button type="button" onClick={() => void onSaveRoutes()}>保存模型配置</Button>
                </Actions>
                {exposedModels.map((model) => {
                  const channelAccounts = accounts.filter((account) => account.channel_id === model.channelId);
                  return (
                    <div className="model-service-row drawer-model-row" key={`${model.channelId}:${model.publicModel}`}>
                      <div className="row-main"><strong>{model.publicModel}</strong><span>{getChannelName(model.channelId)} · {model.upstreamModel}</span></div>
                      <Select value={model.accountId} onChange={(value) => value && switchModelAccount(model.routeIndexes, value)} data={channelAccounts.map((account) => ({ value: account.id, label: account.name }))} />
                      <ProtocolBadges protocols={model.protocols} />
                      <span>{accountCountLabel(model.accountIds.length)}</span>
                      <StatusPill running={model.enabled && model.hasAvailableAccount}>{modelState(model)}</StatusPill>
                      <Switch checked={model.enabled} onChange={(event) => setModelEnabled(model.routeIndexes, event.currentTarget.checked)} />
                    </div>
                  );
                })}
              </div>
            ) : null}
          </>
        ) : null}
      </Drawer>

      <Drawer
        opened={accountEditor != null}
        onClose={() => setAccountEditor(null)}
        title={accountEditor?.mode === "create" ? "新增上游账号" : "编辑上游账号"}
        position="right"
        size="min(760px, 94vw)"
        padding="md"
        className="account-editor-drawer-root"
      >
        {accountEditor ? (
          <>
            <p className="hint">{accountEditor.mode === "create" ? "添加 LongCat 或 DeepSeek 账号，用于上游模型转发" : "修改账号信息、启用状态与高级配置"}</p>

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
                    <Button
                      type="button"
                      variant="default"
                      onClick={() => setAccountEditor((current) => current ? { ...current, apiKeyVisible: !current.apiKeyVisible } : current)}
                    >
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
                      <label>
                        资源包剩余
                        <div className="unit-input"><TextInput type="number" min="0" value={accountEditor.snapshotDraft.tokenRemaining} onChange={(event) => updateSnapshotDraft({ tokenRemaining: event.target.value })} /><span>Tokens</span></div>
                      </label>
                      <label>
                        已消耗
                        <div className="unit-input"><TextInput type="number" min="0" value={accountEditor.snapshotDraft.tokenUsed} onChange={(event) => updateSnapshotDraft({ tokenUsed: event.target.value })} /><span>Tokens</span></div>
                      </label>
                      <label>
                        资源包总量
                        <div className="unit-input"><TextInput type="number" min="0" value={accountEditor.snapshotDraft.tokenTotal} onChange={(event) => updateSnapshotDraft({ tokenTotal: event.target.value })} /><span>Tokens</span></div>
                      </label>
                      <label>
                        过期时间
                        <TextInput type="datetime-local" value={accountEditor.snapshotDraft.tokenExpire} onChange={(event) => updateSnapshotDraft({ tokenExpire: event.target.value })} />
                      </label>
                    </div>
                    <Button
                      type="button"
                      variant="default"
                      className="outline-primary"
                      disabled={accountEditor.mode === "create"}
                      onClick={() => {
                        setAccountEditor(null);
                        setSnapshotAccountId(accountEditor.draft.id);
                      }}
                    >
                      登记资源包
                    </Button>
                  </>
                ) : (
                  <div className="resource-grid">
                    <label>
                      余额
                      <div className="unit-input"><TextInput type="number" min="0" step="0.01" value={accountEditor.snapshotDraft.balance} onChange={(event) => updateSnapshotDraft({ balance: event.target.value })} /><span>{accountEditor.snapshotDraft.currency || "CNY"}</span></div>
                    </label>
                    <label>
                      货币
                      <TextInput value={accountEditor.snapshotDraft.currency} onChange={(event) => updateSnapshotDraft({ currency: event.target.value })} />
                    </label>
                    <label>
                      最近更新时间
                      <TextInput readOnly value={formatIsoDateTime(editorSnapshot?.synced_at)} />
                    </label>
                    <div className="field-action">
                      <Button type="button" variant="default" disabled={accountEditor.mode === "create"} onClick={() => onTestConnection(accountEditor.draft.id)}>同步余额</Button>
                    </div>
                  </div>
                )}
                <p className="info-note">
                  {accountEditor.draft.channel_id === "longcat"
                    ? "LongCat 不支持自动同步，请手动登记和维护余额 / 资源包信息。"
                    : "DeepSeek 等支持自动同步的渠道会在保存后提供自动同步能力。"}
                </p>
              </section>

              <section className={accountEditor.advancedOpen ? "account-form-section advanced open" : "account-form-section advanced"}>
                <Button type="button" variant="subtle" className="advanced-toggle" onClick={() => setAccountEditor((current) => current ? { ...current, advancedOpen: !current.advancedOpen } : current)}>
                  <span>高级配置</span>
                  <span>{accountEditor.advancedOpen ? "⌃" : "⌄"}</span>
                </Button>
                {accountEditor.advancedOpen ? (
                  <div className="advanced-content">
                    <label>
                      Base URL 覆盖（可选）
                    <TextInput value={accountEditor.draft.base_url_override ?? ""} placeholder={editorChannel?.openai_base_url ?? "https://api.example.com/v1"} onChange={(event) => updateAccountDraft({ base_url_override: event.target.value || null })} />
                    </label>
                    <div className="test-row">
                      <Button type="button" variant="default" disabled={accountEditor.mode === "create"} onClick={() => onTestConnection(accountEditor.draft.id)}>测试连接</Button>
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
                  <Button type="button" variant="subtle" color="red" onClick={() => void removeEditingAccount()}>删除账号</Button>
                </section>
              ) : null}
            </div>

            <footer className="account-modal-footer">
              <Button type="button" variant="default" onClick={() => setAccountEditor(null)}>取消</Button>
              <Button type="button" onClick={() => void saveAccountEditor()}>{accountEditor.mode === "create" ? "保存账号" : "保存修改"}</Button>
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
