import React from "react";
import { Actions, Panel, PanelHeader } from "../components/ui";
import { AccountStatsRow, LogCaptureConfig } from "../domain";

const KB = 1024;

export function StatsPage({
  rows,
  onRefresh,
  routingScores,
  getAccountName,
  getChannelName,
  logCaptureConfig,
  onSaveLogCaptureConfig,
}: {
  rows: AccountStatsRow[];
  onRefresh: () => void;
  routingScores: Array<[string, string, number, number, number]>;
  getAccountName: (accountId: string) => string;
  getChannelName: (channelId: string) => string;
  logCaptureConfig: LogCaptureConfig | null;
  onSaveLogCaptureConfig: (next: LogCaptureConfig) => void;
}) {
  const cfg = logCaptureConfig ?? {
    capture_req_headers: true,
    capture_req_body: true,
    capture_res_headers: true,
    capture_res_body: true,
    stream_summary_max_bytes: 16 * KB,
    max_body_bytes: KB * KB,
  };

  const set = <K extends keyof LogCaptureConfig>(key: K, value: LogCaptureConfig[K]) => {
    onSaveLogCaptureConfig({ ...cfg, [key]: value });
  };

  return (
    <>
      <Panel>
        <PanelHeader>
          <h3>日志记录</h3>
          <Actions>
            <span className="muted">设置生效需要重启代理</span>
          </Actions>
        </PanelHeader>
        <p className="hint">控制请求日志中是否捕获 Headers / Body，以及最大捕获体积。敏感 Header（Authorization、x-api-key 等）会自动脱敏为 <code>[redacted]</code>。</p>
        <div className="capture-settings">
          <Checkbox
            label="捕获请求 Headers"
            checked={cfg.capture_req_headers}
            onChange={(v) => set("capture_req_headers", v)}
          />
          <Checkbox
            label="捕获请求 Body"
            checked={cfg.capture_req_body}
            onChange={(v) => set("capture_req_body", v)}
          />
          < KilobytesInput
            label="请求 Body 上限"
            value={Math.max(1, Math.floor(cfg.max_body_bytes / KB))}
            onChange={(v) => set("max_body_bytes", v * KB)}
          />
          <Checkbox
            label="捕获响应 Headers"
            checked={cfg.capture_res_headers}
            onChange={(v) => set("capture_res_headers", v)}
          />
          <Checkbox
            label="捕获响应 Body"
            checked={cfg.capture_res_body}
            onChange={(v) => set("capture_res_body", v)}
          />
          <KilobytesInput
            label="响应 Body / 流式摘要上限"
            value={Math.max(1, Math.floor(cfg.stream_summary_max_bytes / KB))}
            onChange={(v) => set("stream_summary_max_bytes", v * KB)}
          />
        </div>
        <ul className="muted" style={{ marginTop: 8, paddingLeft: 18 }}>
          <li>流式请求（SSE）仅记录首尾片段摘要与最多前 N 字节。</li>
          <li>记录过的请求日志不受影响：本次设置仅对后续新请求生效。</li>
        </ul>
      </Panel>
      <Panel>
        <PanelHeader>
          <h3>账号成本与稳定性统计</h3>
          <Actions>
            <button onClick={() => void onRefresh()}>刷新</button>
          </Actions>
        </PanelHeader>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>账号</th>
                <th>渠道</th>
                <th>请求数</th>
                <th>成功</th>
                <th>失败</th>
                <th>失败率</th>
                <th>Fallback</th>
                <th>Token</th>
                <th>估算成本</th>
                <th>最近错误</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10}>暂无统计数据</td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.account_id}>
                    <td>{row.account_name || row.account_id}</td>
                    <td>{row.channel_name || row.channel_id || "-"}</td>
                    <td>{row.total_requests}</td>
                    <td>{row.success_requests}</td>
                    <td>{row.failed_requests}</td>
                    <td>{row.failure_rate.toFixed(1)}%</td>
                    <td>{row.total_fallbacks}</td>
                    <td>{row.known_tokens.toLocaleString()}</td>
                    <td>{"$"}{row.estimated_cost.toFixed(6)}</td>
                    <td title={row.last_error ?? ""}>
                      {row.last_error
                        ? row.last_error.length > 40
                          ? row.last_error.slice(0, 40) + "…"
                          : row.last_error
                        : "-"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel>
        <PanelHeader>
          <h3>智能路由评分（成本/延迟/成功率）</h3>
        </PanelHeader>
        <p className="hint">
          综合调度算法：得分 = 0.4×归一化成本 + 0.3×归一化延迟 + 0.3×失败率。得分越低优先级越高。
        </p>
        {routingScores.length === 0 ? (
          <p>暂无评分数据。需要至少 3 条请求记录才能计算。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>账号</th>
                  <th>渠道</th>
                  <th>平均延迟</th>
                  <th>成功率</th>
                  <th>单次成本</th>
                </tr>
              </thead>
              <tbody>
                {routingScores.map(
                  ([accountId, channelId, latency, successRate, cost], idx) => (
                    <tr key={`${accountId}-${channelId}-${idx}`}>
                      <td>{getAccountName(accountId)}</td>
                      <td>{getChannelName(channelId)}</td>
                      <td>{Math.round(latency)} ms</td>
                      <td>{successRate.toFixed(1)}%</td>
                      <td>{"$"}{cost.toFixed(6)}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="checkbox-label">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function KilobytesInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="kb-input">
      <span>{label} (KB)</span>
      <div className="kb-input-row">
        <input
          type="number"
          min={1}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isNaN(n) && n >= 1) onChange(n);
          }}
        />
      </div>
    </label>
  );
}
