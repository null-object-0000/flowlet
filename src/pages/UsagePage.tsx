import { Button, Select, Table, TextInput } from "@mantine/core";
import { Actions, DetailsPanel, Panel, PanelHeader } from "../components/ui";
import { TableContainer } from "../components/ui";
import { ChannelPreset, ModelPrice, UsageSummaryRow } from "../domain";

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
      <Panel>
        <PanelHeader>
          <h3>用量统计</h3>
          <Actions>
            <Button type="button" variant="default" onClick={() => void onAnalyze()}>执行离线分析</Button>
            <Button type="button" onClick={() => void onRefresh()}>刷新</Button>
          </Actions>
        </PanelHeader>
        <TableContainer>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>日期</Table.Th>
                <Table.Th>客户端</Table.Th>
                <Table.Th>渠道</Table.Th>
                <Table.Th>账号</Table.Th>
                <Table.Th>上游模型</Table.Th>
                <Table.Th>请求数</Table.Th>
                <Table.Th>已知 Token</Table.Th>
                <Table.Th>未知</Table.Th>
                <Table.Th>估算成本</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.length === 0 ? (
                <Table.Tr><Table.Td colSpan={9}>暂无用量数据</Table.Td></Table.Tr>
              ) : (
                rows.map((row, index) => (
                  <Table.Tr key={`${row.date}-${row.channel_id}-${row.account_id}-${row.upstream_model}-${index}`}>
                    <Table.Td>{row.date}</Table.Td>
                    <Table.Td>{row.client_name || row.client_id || "未知"}</Table.Td>
                    <Table.Td>{row.channel_name || row.channel_id || "-"}</Table.Td>
                    <Table.Td>{row.account_name || row.account_id || "-"}</Table.Td>
                    <Table.Td>{row.upstream_model || "-"}</Table.Td>
                    <Table.Td>{row.request_count}</Table.Td>
                    <Table.Td>{row.known_tokens}</Table.Td>
                    <Table.Td>{row.unknown_count}</Table.Td>
                    <Table.Td>${row.estimated_cost.toFixed(6)}</Table.Td>
                  </Table.Tr>
                ))
              )}
            </Table.Tbody>
          </Table>
        </TableContainer>
      </Panel>

      <DetailsPanel summary="成本设置">
        <PanelHeader>
          <h3>模型价格表（三段价格）</h3>
          <Actions>
            <Button type="button" variant="default" onClick={onAddPrice}>新增价格</Button>
            <Button type="button" onClick={() => void onSavePrices()}>保存价格</Button>
          </Actions>
        </PanelHeader>
        <div className="price-list">
          {prices.length === 0 ? (
            <p>暂无模型价格</p>
          ) : (
            prices.map((price, index) => (
              <div className="price-row-3" key={price.id}>
                <Select value={price.channel_id} onChange={(value) => value && onUpdatePrice(index, { channel_id: value })} data={channels.map((c) => ({ value: c.id, label: c.name }))} />
                <TextInput value={price.upstream_model} placeholder="模型名" onChange={(e) => onUpdatePrice(index, { upstream_model: e.target.value })} />
                <span className="price-preview">{formatPrice(price)}</span>
                <TextInput type="number" min="0" step="0.000001" value={price.input_uncached_price} placeholder="输入(未命中缓存)" onChange={(e) => onUpdatePrice(index, { input_uncached_price: Number(e.target.value) })} />
                <TextInput type="number" min="0" step="0.000001" value={price.input_cached_price} placeholder="输入(命中缓存)" onChange={(e) => onUpdatePrice(index, { input_cached_price: Number(e.target.value) })} />
                <TextInput type="number" min="0" step="0.000001" value={price.output_price} placeholder="输出" onChange={(e) => onUpdatePrice(index, { output_price: Number(e.target.value) })} />
                <Button type="button" variant="subtle" color="red" onClick={() => onRemovePrice(index)}>删除</Button>
              </div>
            ))
          )}
        </div>
      </DetailsPanel>
    </>
  );
}
