import {
  UsageSummaryRow
} from "../domain";

export function UsagePage({
  rows,
  onAnalyze,
  onRefresh,
}: {
  rows: UsageSummaryRow[];
  onAnalyze: () => void;
  onRefresh: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-title">
        <h3>用量统计</h3>
        <div className="actions">
          <button onClick={() => void onAnalyze()}>执行离线分析</button>
          <button onClick={() => void onRefresh()}>刷新</button>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>客户端</th>
              <th>渠道</th>
              <th>账号</th>
              <th>上游模型</th>
              <th>请求数</th>
              <th>已知 Token</th>
              <th>未知</th>
              <th>估算成本</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9}>暂无用量数据</td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr
                  key={`${row.date}-${row.channel_id}-${row.account_id}-${row.upstream_model}-${index}`}
                >
                  <td>{row.date}</td>
                  <td>{row.client_name || row.client_id || "未知"}</td>
                  <td>{row.channel_name || row.channel_id || "-"}</td>
                  <td>{row.account_name || row.account_id || "-"}</td>
                  <td>{row.upstream_model || "-"}</td>
                  <td>{row.request_count}</td>
                  <td>{row.known_tokens}</td>
                  <td>{row.unknown_count}</td>
                  <td>${row.estimated_cost.toFixed(6)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
