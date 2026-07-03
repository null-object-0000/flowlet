import {
  ProxyStatus,
  UsageSummaryRow
} from "../domain";

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
}) {
  const today = new Date().toISOString().slice(0, 10);
  const todayRows = usageRows.filter((r) => r.date === today);
  const todayRequests = todayRows.reduce((sum, r) => sum + r.request_count, 0);
  const todayTokens = todayRows.reduce((sum, r) => sum + r.known_tokens, 0);
  const todayCost = todayRows.reduce((sum, r) => sum + r.estimated_cost, 0);

  return (
    <>
      <section className="panel">
        <div className="panel-title">
          <h3>接入信息</h3>
          <div className="actions">
            <button onClick={() => void onCopy("http://127.0.0.1:11434/v1", "OpenAI Base URL 已复制")}>
              复制 OpenAI Base URL
            </button>
            <button
              onClick={() =>
                void onCopy("http://127.0.0.1:11434/anthropic", "Anthropic Base URL 已复制")
              }
            >
              复制 Anthropic Base URL
            </button>
            <button onClick={() => void onCopy("Bearer flowlet-local-token", "Client Token 已复制")}>
              复制 Client Token
            </button>
          </div>
        </div>
        <div className="info-grid">
          <label>
            OpenAI-compatible 入口
            <input readOnly value="http://127.0.0.1:11434/v1" />
          </label>
          <label>
            Anthropic-compatible 入口
            <input readOnly value="http://127.0.0.1:11434/anthropic" />
          </label>
          <label>
            健康检查
            <input readOnly value="http://127.0.0.1:11434/health" />
          </label>
          <label>
            客户端 Token
            <input readOnly value="Bearer flowlet-local-token" />
          </label>
        </div>
      </section>
      <section className="panel compact">
        <h3>当前阶段</h3>
        <p>
          已建立 Channel / Account / Model 三层架构，支持 LongCat + DeepSeek 双渠道、OpenAI-compatible
          与 Anthropic-compatible 双协议透明转发。
        </p>
        <p>
          渠道: {status.channels} | 账号: {status.accounts} | 客户端: {status.clients} | 今日请求:{" "}
          {todayRequests} | Token: {todayTokens} | 成本: ${todayCost.toFixed(6)}
        </p>
      </section>
      <section className="panel compact">
        <div className="panel-title">
          <h3>系统设置</h3>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={autostartEnabled}
            onChange={onToggleAutostart}
          />
          开机自启动 Flowlet
        </label>
      </section>
      <section className="panel compact">
        <div className="panel-title">
          <h3>配置管理</h3>
        </div>
        <div className="actions">
          <button onClick={() => void onValidateConfig()}>验证配置</button>
          <button onClick={() => void onExportConfig()}>导出配置</button>
          <button onClick={() => void onImportConfig()}>导入配置</button>
        </div>
        <p className="hint">验证配置完整性（渠道、账号、API Key、路由引用），导出为 JSON 文件备份，或从文件导入。</p>
      </section>
      <section className="panel compact">
        <div className="panel-title">
          <h3>数据库维护</h3>
        </div>
        {dbStats ? (
          <p>
            请求日志: {dbStats[0].toLocaleString()} 条 | 用量记录: {dbStats[1].toLocaleString()} 条 | 文件大小: {(dbStats[2] / 1024).toFixed(1)} KB
          </p>
        ) : (
          <p>加载中...</p>
        )}
        <div className="actions">
          <button
            onClick={() => {
              if (confirm("清理 30 天前的日志？此操作不可撤销。")) {
                onCleanupLogs(30);
              }
            }}
          >
            清理 30 天前日志
          </button>
          <button onClick={() => void onRefreshAll()}>刷新统计</button>
        </div>
      </section>
    </>
  );
}
