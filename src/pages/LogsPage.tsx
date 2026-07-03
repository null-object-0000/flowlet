import {
  RequestLogRow
} from "../domain";

export function LogsPage({
  logs,
  onRefresh,
}: {
  logs: RequestLogRow[];
  onRefresh: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-title">
        <h3>请求日志</h3>
        <div className="actions">
          <button onClick={() => void onRefresh()}>刷新</button>
        </div>
      </div>
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
              <th>公开模型</th>
              <th>上游模型</th>
              <th>状态</th>
              <th>耗时</th>
              <th>降级</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr>
                <td colSpan={11}>暂无请求日志</td>
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
                  <td>{row.latency_ms == null ? "-" : `${row.latency_ms} ms`}</td>
                  <td>{row.fallback_count}</td>
                  <td>{row.route_reason || row.error_message || "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
