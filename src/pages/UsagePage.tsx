import {
  ChannelPreset,
  ModelPrice,
  UsageSummaryRow
} from "../domain";

export function UsagePage({
  rows,
  onAnalyze,
  onRefresh,
  prices,
  channels,
  onAddPrice,
  onUpdatePrice,
  onRemovePrice,
  onSavePrices,
}: {
  rows: UsageSummaryRow[];
  onAnalyze: () => void;
  onRefresh: () => void;
  prices: ModelPrice[];
  channels: ChannelPreset[];
  onAddPrice: () => void;
  onUpdatePrice: (index: number, patch: Partial<ModelPrice>) => void;
  onRemovePrice: (index: number) => void;
  onSavePrices: () => void;
}) {
  function formatPrice(price: ModelPrice): string {
    const isUnconfiguredLongCat =
      price.channel_id === "longcat" &&
      price.input_uncached_price === 0 &&
      price.input_cached_price === 0 &&
      price.output_price === 0;
    if (isUnconfiguredLongCat) return "价格待配置";
    return `${price.input_uncached_price}/${price.input_cached_price}/${price.output_price} ${price.currency}`;
  }

  return (
    <>
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

      <details className="panel advanced-panel">
        <summary>成本设置</summary>
        <div className="panel-title">
          <h3>模型价格表（三段价格）</h3>
          <div className="actions">
            <button onClick={onAddPrice}>新增价格</button>
            <button onClick={() => void onSavePrices()}>保存价格</button>
          </div>
        </div>
        <div className="price-list">
          {prices.length === 0 ? (
            <p>暂无模型价格</p>
          ) : (
            prices.map((price, index) => (
              <div className="price-row-3" key={price.id}>
                <select
                  value={price.channel_id}
                  onChange={(e) => onUpdatePrice(index, { channel_id: e.target.value })}
                >
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  value={price.upstream_model}
                  placeholder="模型名"
                  onChange={(e) => onUpdatePrice(index, { upstream_model: e.target.value })}
                />
                <span className="price-preview">{formatPrice(price)}</span>
                <input
                  type="number"
                  min="0"
                  step="0.000001"
                  value={price.input_uncached_price}
                  placeholder="输入(未命中缓存)"
                  onChange={(e) =>
                    onUpdatePrice(index, { input_uncached_price: Number(e.target.value) })
                  }
                />
                <input
                  type="number"
                  min="0"
                  step="0.000001"
                  value={price.input_cached_price}
                  placeholder="输入(命中缓存)"
                  onChange={(e) =>
                    onUpdatePrice(index, { input_cached_price: Number(e.target.value) })
                  }
                />
                <input
                  type="number"
                  min="0"
                  step="0.000001"
                  value={price.output_price}
                  placeholder="输出"
                  onChange={(e) => onUpdatePrice(index, { output_price: Number(e.target.value) })}
                />
                <button onClick={() => onRemovePrice(index)}>删除</button>
              </div>
            ))
          )}
        </div>
      </details>
    </>
  );
}
