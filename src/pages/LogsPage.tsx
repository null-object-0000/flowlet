import React from "react";
import { Actions, Panel, PanelHeader } from "../components/ui";
import { RequestLogRow } from "../domain";
import { LogDetailDrawer } from "./LogDetailDrawer";

export function LogsPage({
  logs,
  onRefresh,
  onOpenDetail,
}: {
  logs: RequestLogRow[];
  onRefresh: () => void;
  onOpenDetail: (requestId: string) => void;
}) {
  const [selectedRequestId, setSelectedRequestId] = React.useState<string | null>(null);

  return (
    <>
      <Panel>
        <PanelHeader>
          <h3>请求日志</h3>
          <Actions>
            <button onClick={() => void onRefresh()}>刷新</button>
          </Actions>
        </PanelHeader>
        <p className="hint">
          仅展示每次请求尝试的最终记录。点击「详情」查看完整尝试链路、请求/响应 Headers 与 Body（已脱敏）。
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>客户端</th>
                <th>渠道</th>
                <th>账号</th>
                <th>协议</th>
                <th>类型</th>
                <th>对外模型</th>
                <th>上游模型</th>
                <th>状态</th>
                <th>TTFB</th>
                <th>耗时</th>
                <th>降级</th>
                <th>原因</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={14}>暂无请求日志</td>
                </tr>
              ) : (
                logs.map((row) => (
                  <tr key={`${row.created_at}-${row.path}-${row.id}`}>
                    <td>{row.created_at}</td>
                    <td>{row.client_name || row.client_id || "未知"}</td>
                    <td>{row.channel_name || row.channel_id || "-"}</td>
                    <td>{row.account_name || row.account_id || "-"}</td>
                    <td>{row.client_protocol}</td>
                    <td>
                      <span className={`request-type-badge request-type-${row.request_type}`}>
                        {row.request_type}
                      </span>
                    </td>
                    <td>{row.public_model || "-"}</td>
                    <td>{row.upstream_model || "-"}</td>
                    <td>{row.status ?? "-"}</td>
                    <td>{formatMs(row.ttfb_ms)}</td>
                    <td>{formatMs(row.duration_ms ?? row.latency_ms)}</td>
                    <td>{row.fallback_count}</td>
                    <td>{row.route_reason || row.error_message || "-"}</td>
                    <td>
                      <button
                        className="link-button"
                        onClick={() => {
                          setSelectedRequestId(row.request_id);
                          onOpenDetail(row.request_id);
                        }}
                      >
                        详情
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      {selectedRequestId ? (
        <LogDetailDrawer
          requestId={selectedRequestId}
          onClose={() => setSelectedRequestId(null)}
        />
      ) : null}
    </>
  );
}

function formatMs(ms: number | null): string {
  if (ms == null) return "-";
  return `${ms} ms`;
}
