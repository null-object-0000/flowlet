import React from "react";
import { Actions, Panel, PanelHeader, ProtocolBadges, StatusPill } from "../components/ui";
import {
  AccountBalanceSnapshot,
  ChannelAccount,
  ChannelPreset,
  ClientConfig,
  ProxyBindConfig,
  ProxyStatus,
  RouteCandidate,
} from "../domain";
import { BalanceSnapshotEditor } from "../features/channels";
import { accountCountLabel, buildExposedModels } from "../features/routes/exposedModels";

type Drawer = "apis" | "tokens" | "accounts" | "models" | null;


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
  onSaveAccounts: () => void;
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
        <button type="button" className="primary" onClick={() => void onRefreshAll()}>刷新数据</button>
      </header>

      <section className="dashboard-grid top-cards">
        <Panel className="dashboard-card status-card">
          <PanelHeader>
            <h3><CardIcon name="status" />代理状态</h3>
            <Actions>
              <button type="button" className="ghost-button" onClick={onStartProxy} disabled={status.running}>启动</button>
              <button type="button" className="ghost-button" onClick={onStopProxy} disabled={!status.running}>停止</button>
              <button type="button" className="ghost-button" onClick={onRestartProxy}>重启</button>
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
              <button type="button" onClick={() => void onCopy(`${baseUrl}/v1`, "OpenAI Base URL 已复制")}><span className="copy-icon" aria-hidden="true" />复制</button>
            </div>
            <div className="endpoint-row">
              <div><span>Anthropic 协议</span><strong>{baseUrl}/anthropic</strong></div>
              <button type="button" onClick={() => void onCopy(`${baseUrl}/anthropic`, "Anthropic Base URL 已复制")}><span className="copy-icon" aria-hidden="true" />复制</button>
            </div>
          </div>
          <button type="button" className="list-link" onClick={() => setDrawer("apis")}>查看所有 API</button>
        </Panel>

        <Panel className="dashboard-card token-card">
          <PanelHeader>
            <h3><CardIcon name="token" />客户端令牌</h3>
            <button type="button" onClick={regenerateDefaultToken}>重新生成</button>
          </PanelHeader>
          <div className="token-box">
            <span>当前默认 Token</span>
            <strong>{defaultClient?.name ?? "未创建客户端"}</strong>
            <code>{defaultClient ? `Bearer ${maskSecret(defaultClient.token)}` : "Bearer -"}</code>
            <button type="button" disabled={!defaultClient} onClick={() => defaultClient && void onCopy(`Bearer ${defaultClient.token}`, "Bearer Token 已复制")}><span className="copy-icon" aria-hidden="true" />复制</button>
          </div>
          <button type="button" className="list-link" onClick={() => setDrawer("tokens")}>管理 Token</button>
        </Panel>
      </section>

      <section className="dashboard-grid list-cards">
        <Panel className="dashboard-card wide-card">
          <PanelHeader>
            <h3><CardIcon name="accounts" />上游账户</h3>
            <button type="button" onClick={() => setDrawer("accounts")}>新增账号</button>
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
                  <button type="button" onClick={() => setDrawer("accounts")}>编辑</button>
                  {account.channel_id === "longcat" ? <button type="button" onClick={() => setSnapshotAccountId(account.id)}>登记资源包</button> : null}
                  {account.channel_id === "deepseek" ? <button type="button" onClick={() => onTestConnection(account.id)}>同步余额</button> : null}
                  <button type="button" onClick={() => setDrawer("accounts")}>更多</button>
                </Actions>
              </div>
            ))}
          </div>
          <div className="card-footer-line"><span>共 {accounts.length} 个账户</span><button type="button" className="list-link" onClick={() => setDrawer("accounts")}>查看全部</button></div>
        </Panel>

        <Panel className="dashboard-card wide-card">
          <PanelHeader>
            <h3><CardIcon name="models" />已暴露模型</h3>
            <Actions>
              <button type="button" className="ghost-button" onClick={() => void onSyncModels()}>同步模型</button>
              <button type="button" onClick={() => setDrawer("models")}>查看全部</button>
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
                <button type="button" className="row-icon-button" onClick={() => setDrawer("models")} aria-label="操作">↗</button>
              </div>
            ))}
          </div>
          <div className="card-footer-line">
            <span>共 {exposedModels.length} 个模型</span>
            <button type="button" className="list-link" onClick={() => setDrawer("models")}>查看全部</button>
          </div>
        </Panel>
      </section>

      <Panel className="dashboard-card quick-start-card">
        <PanelHeader><h3><CardIcon name="quick" />快速开始</h3><button type="button" className="ghost-button">查看配置示例</button></PanelHeader>
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

      {drawer ? (
        <div className="drawer-backdrop" onClick={() => setDrawer(null)}>
          <aside className="console-drawer" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3>{drawer === "apis" ? "所有可用 API" : drawer === "tokens" ? "管理 Token" : drawer === "accounts" ? "管理上游账户" : "管理已暴露模型"}</h3>
              <button type="button" onClick={() => setDrawer(null)}>关闭</button>
            </header>
            {drawer === "apis" ? (
              <div className="drawer-list">
                {apiItems.map(([label, url]) => (
                  <div className="endpoint-row" key={label}>
                    <div><span>{label}</span><strong>{url}</strong></div>
                    <button type="button" onClick={() => void onCopy(url, `${label} 已复制`)}><span className="copy-icon" aria-hidden="true" />复制</button>
                  </div>
                ))}
              </div>
            ) : null}
            {drawer === "tokens" ? (
              <div className="drawer-list">
                <Actions>
                  <button type="button" onClick={onAddClient}>新增客户端</button>
                  <button type="button" className="primary" onClick={() => void onSaveClients()}>保存 Token</button>
                </Actions>
                {clients.map((client, index) => (
                  <div className="editor-card" key={client.id}>
                    <input value={client.name} onChange={(event) => onUpdateClient(index, { name: event.target.value })} />
                    <input value={client.token} onChange={(event) => onUpdateClient(index, { token: event.target.value })} />
                    <select value={client.app_type} onChange={(event) => onUpdateClient(index, { app_type: event.target.value })}>
                      <option value="local">本机</option>
                      <option value="claude-code">Claude Code</option>
                      <option value="cursor">Cursor</option>
                      <option value="cline">Cline</option>
                      <option value="open-webui">Open WebUI</option>
                      <option value="custom">自定义</option>
                    </select>
                    <Actions>
                      <button type="button" onClick={() => void onCopy(`Bearer ${client.token}`, "Bearer Token 已复制")}><span className="copy-icon" aria-hidden="true" />复制</button>
                      <button type="button" onClick={() => onUpdateClient(index, { token: tokenSeed() })}>重新生成</button>
                      <button type="button" onClick={() => onRemoveClient(index)}>删除</button>
                    </Actions>
                  </div>
                ))}
              </div>
            ) : null}
            {drawer === "accounts" ? (
              <div className="drawer-list">
                <Actions>
                  {channels.map((channel) => <button type="button" key={channel.id} onClick={() => onAddAccount(channel.id)}>新增{channel.name}</button>)}
                  <button type="button" className="primary" onClick={() => void onSaveAccounts()}>保存账号</button>
                </Actions>
                {accounts.map((account, index) => {
                  const channel = channels.find((item) => item.id === account.channel_id);
                  return (
                    <div className="editor-card" key={account.id}>
                      <select value={account.channel_id} onChange={(event) => onUpdateAccount(index, { channel_id: event.target.value })}>
                        {channels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                      <input value={account.name} placeholder="账号名称" onChange={(event) => onUpdateAccount(index, { name: event.target.value })} />
                      <input type="password" value={account.api_key} placeholder="API Key" onChange={(event) => onUpdateAccount(index, { api_key: event.target.value })} />
                      <input value={account.base_url_override ?? ""} placeholder={channel?.openai_base_url ?? "Base URL 覆盖"} onChange={(event) => onUpdateAccount(index, { base_url_override: event.target.value || null })} />
                      <label className="checkbox-label"><input type="checkbox" checked={account.enabled} onChange={(event) => onUpdateAccount(index, { enabled: event.target.checked })} />启用账号</label>
                      <Actions>
                        {account.channel_id === "longcat" ? <button type="button" onClick={() => setSnapshotAccountId(account.id)}>登记资源包</button> : null}
                        {account.channel_id === "deepseek" ? <button type="button" onClick={() => onTestConnection(account.id)}>同步余额</button> : null}
                        <button type="button" onClick={() => onRemoveAccount(index)}>删除</button>
                      </Actions>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {drawer === "models" ? (
              <div className="drawer-list">
                <Actions>
                  <button type="button" onClick={() => void onSyncModels()}>同步模型</button>
                  <button type="button" onClick={onOpenAdvancedSettings}>进入高级映射</button>
                  <button type="button" className="primary" onClick={() => void onSaveRoutes()}>保存模型配置</button>
                </Actions>
                {exposedModels.map((model) => {
                  const channelAccounts = accounts.filter((account) => account.channel_id === model.channelId);
                  return (
                    <div className="model-service-row drawer-model-row" key={`${model.channelId}:${model.publicModel}`}>
                      <div className="row-main"><strong>{model.publicModel}</strong><span>{getChannelName(model.channelId)} · {model.upstreamModel}</span></div>
                      <select value={model.accountId} onChange={(event) => switchModelAccount(model.routeIndexes, event.target.value)}>
                        {channelAccounts.map((account) => (
                          <option key={account.id} value={account.id}>{account.name}</option>
                        ))}
                      </select>
                      <ProtocolBadges protocols={model.protocols} />
                      <span>{accountCountLabel(model.accountIds.length)}</span>
                      <StatusPill running={model.enabled && model.hasAvailableAccount}>{modelState(model)}</StatusPill>
                      <button type="button" onClick={() => setModelEnabled(model.routeIndexes, !model.enabled)}>{model.enabled ? "关闭" : "开放"}</button>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}

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
