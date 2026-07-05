import React from "react";
import { Actions, Panel, PanelHeader } from "../components/ui";
import { ChannelPreset, ProxyBindConfig, ProxyStatus, UsageSummaryRow } from "../domain";
import { runCommand } from "../services/flowletApi";

export function OverviewPage({
  status,
  usageRows,
  onCopy,
  autostartEnabled,
  onToggleAutostart,
  onExportConfig,
  onImportConfig,
  onValidateConfig,
  onRefreshAll,
  dbStats,
  onCleanupLogs,
  channels,
  hasEnabledAccount,
  hasEnabledRoute,
  onQuickSetup,
}: {
  status: ProxyStatus & { channels: number; accounts: number; clients: number };
  usageRows: UsageSummaryRow[];
  onCopy: (text: string, done: string) => Promise<void>;
  autostartEnabled: boolean;
  onToggleAutostart: () => void;
  onExportConfig: () => void;
  onImportConfig: () => void;
  onValidateConfig: () => void;
  onRefreshAll: () => void;
  dbStats: [number, number, number] | null;
  onCleanupLogs: (keepDays: number) => void;
  channels: ChannelPreset[];
  hasEnabledAccount: boolean;
  hasEnabledRoute: boolean;
  onQuickSetup: (channelId: string, apiKey: string) => void;
}) {
  const [wizardChannelId, setWizardChannelId] = React.useState("longcat");
  const [wizardApiKey, setWizardApiKey] = React.useState("");
  const [bindConfig, setBindConfig] = React.useState<ProxyBindConfig>({ host: "127.0.0.1", port: 18640, allow_lan: false });
  const today = new Date().toISOString().slice(0, 10);
  const todayRows = usageRows.filter((r) => r.date === today);
  const todayRequests = todayRows.reduce((sum, r) => sum + r.request_count, 0);
  const todayTokens = todayRows.reduce((sum, r) => sum + r.known_tokens, 0);
  const todayCost = todayRows.reduce((sum, r) => sum + r.estimated_cost, 0);
  const needsSetup = !hasEnabledAccount || !hasEnabledRoute;

  React.useEffect(() => {
    runCommand<string>("read_config")
      .then((json) => {
        const parsed = JSON.parse(json);
        if (parsed.bind) {
          setBindConfig({ host: parsed.bind.host || "127.0.0.1", port: parsed.bind.port || 18640, allow_lan: parsed.bind.host === "0.0.0.0" });
        }
      })
      .catch(() => {});
  }, []);

  const listenAddress = bindConfig.host === "0.0.0.0" ? `0.0.0.0:${bindConfig.port}` : `${bindConfig.host}:${bindConfig.port}`;
  const endpointHost = bindConfig.host === "0.0.0.0" ? "<LAN-IP>" : "127.0.0.1";
  const proxyBaseUrl = `http://${endpointHost}:${bindConfig.port}`;

  return (
    <>
      {needsSetup ? (
        <Panel className="quick-setup">
          <PanelHeader><h3>快速配置</h3></PanelHeader>
          <div className="form-grid">
            <label>
              选择渠道
              <select value={wizardChannelId} onChange={(event) => setWizardChannelId(event.target.value)}>
                {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
              </select>
            </label>
            <label>
              API Key
              <input type="password" value={wizardApiKey} placeholder="粘贴你的渠道 API Key" onChange={(event) => setWizardApiKey(event.target.value)} />
            </label>
          </div>
          <Actions>
            <button onClick={() => { onQuickSetup(wizardChannelId, wizardApiKey); setWizardApiKey(""); }}>保存快速配置</button>
          </Actions>
          <p className="hint">保存后会自动创建渠道账号，并开放该渠道默认模型的 OpenAI-compatible 与 Anthropic-compatible 入口。</p>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader>
          <h3>接入信息</h3>
          <Actions>
            <button onClick={() => void onCopy(`${proxyBaseUrl}/v1`, "OpenAI Base URL 已复制")}>复制 OpenAI Base URL</button>
            <button onClick={() => void onCopy(`${proxyBaseUrl}/anthropic`, "Anthropic Base URL 已复制")}>复制 Anthropic Base URL</button>
            <button onClick={() => void onCopy("Bearer flowlet-local-token", "Client Token 已复制")}>复制 Client Token</button>
          </Actions>
        </PanelHeader>
        <div className="info-grid">
          <label>OpenAI-compatible 入口<input readOnly value={`${proxyBaseUrl}/v1`} /></label>
          <label>Anthropic-compatible 入口<input readOnly value={`${proxyBaseUrl}/anthropic`} /></label>
          <label>健康检查<input readOnly value={`${proxyBaseUrl}/health`} /></label>
          <label>客户端 Token<input readOnly value="Bearer flowlet-local-token" /></label>
        </div>
      </Panel>

      <Panel className="compact">
        <PanelHeader><h3>系统设置</h3></PanelHeader>
        <label className="checkbox-label">
          <input type="checkbox" checked={autostartEnabled} onChange={onToggleAutostart} />
          开机自启动 Flowlet
        </label>
        <p className="hint">当前监听: {listenAddress}。是否允许局域网访问、端口等配置请编辑 config.json。</p>
      </Panel>

      <Panel className="compact">
        <PanelHeader><h3>配置管理</h3></PanelHeader>
        <Actions>
          <button onClick={() => void onValidateConfig()}>验证配置</button>
          <button onClick={() => void onExportConfig()}>导出配置</button>
          <button onClick={() => void onImportConfig()}>导入配置</button>
        </Actions>
        <p className="hint">验证配置完整性（渠道、账号、API Key、路由引用），导出为 JSON 文件备份，或从文件导入。</p>
      </Panel>

      <Panel className="compact">
        <PanelHeader><h3>数据库维护</h3></PanelHeader>
        {dbStats ? (
          <p>请求日志: {dbStats[0].toLocaleString()} 条 | 用量记录: {dbStats[1].toLocaleString()} 条 | 文件大小: {(dbStats[2] / 1024).toFixed(1)} KB</p>
        ) : (
          <p>加载中...</p>
        )}
        <Actions>
          <button onClick={() => { if (confirm("清理 30 天前的日志？此操作不可撤销。")) onCleanupLogs(30); }}>清理 30 天前日志</button>
          <button onClick={() => void onRefreshAll()}>刷新统计</button>
        </Actions>
      </Panel>
    </>
  );
}





