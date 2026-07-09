import React from "react";
import { Button, Table } from "@mantine/core";
import { Actions, Panel, PanelHeader, ProtocolBadges, TableContainer } from "../../components/ui";
import { ChannelAccount, ChannelModel, ChannelPreset } from "../../domain";

type ModelSyncPanelProps = {
  channels: ChannelPreset[];
  accounts: ChannelAccount[];
  channelModels: ChannelModel[];
  onSyncModels: (accountId: string) => void;
  onRefreshChannelModels: () => void;
  getChannelName: (channelId: string) => string;
};

type SyncStatus = {
  source: string | null;
  synced_at: string | null;
  model_count: number;
  is_syncing: boolean;
};

function buildStatusMap(channelModels: ChannelModel[]): Map<string, SyncStatus> {
  const map = new Map<string, SyncStatus>();
  for (const model of channelModels) {
    const existing = map.get(model.channel_id);
    if (!existing || (model.synced_at && model.synced_at > (existing.synced_at ?? ""))) {
      map.set(model.channel_id, {
        source: model.source,
        synced_at: model.synced_at ?? null,
        model_count: 0,
        is_syncing: false,
      });
    }
    const current = map.get(model.channel_id)!;
    if (model.enabled) {
      map.set(model.channel_id, { ...current, model_count: current.model_count + 1 });
    }
  }
  return map;
}

export function ModelSyncPanel({
  channels,
  accounts,
  channelModels,
  onSyncModels,
  onRefreshChannelModels,
  getChannelName,
}: ModelSyncPanelProps) {
  const [syncingId, setSyncingId] = React.useState<string | null>(null);
  const statusMap = buildStatusMap(channelModels);

  function syncChannel(channelId: string) {
    const account = accounts.find((a) => a.channel_id === channelId && a.enabled && a.api_key.trim());
    if (!account) return;
    setSyncingId(channelId);
    Promise.resolve(onSyncModels(account.id)).finally(() => {
      setSyncingId(null);
      onRefreshChannelModels();
    });
  }

  return (
    <Panel>
      <PanelHeader>
        <h3>模型同步</h3>
        <Actions>
          <Button type="button" variant="default" onClick={() => onRefreshChannelModels()}>刷新状态</Button>
        </Actions>
      </PanelHeader>
      {channels.length === 0 ? (
        <p>暂无渠道配置。</p>
      ) : (
        <TableContainer>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>渠道</Table.Th>
                <Table.Th>协议</Table.Th>
                <Table.Th>同步来源</Table.Th>
                <Table.Th>同步时间</Table.Th>
                <Table.Th>已同步模型数</Table.Th>
                <Table.Th>操作</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {channels.map((channel) => {
                const status = statusMap.get(channel.id);
                const hasAccount = accounts.some(
                  (a) => a.channel_id === channel.id && a.enabled && a.api_key.trim()
                );
                return (
                  <Table.Tr key={channel.id}>
                    <Table.Td>{getChannelName(channel.id)}</Table.Td>
                    <Table.Td><ProtocolBadges protocols={channel.supported_protocols} /></Table.Td>
                    <Table.Td>{status?.source ?? "-"}</Table.Td>
                    <Table.Td>{status?.synced_at ? new Date(status.synced_at).toLocaleString() : "-"}</Table.Td>
                    <Table.Td>{status?.model_count ?? 0}</Table.Td>
                    <Table.Td>
                      <Actions>
                        <Button type="button"
                          variant="default"
                          disabled={!hasAccount || syncingId === channel.id}
                          onClick={() => syncChannel(channel.id)}
                          title={hasAccount ? "同步模型列表" : "请先添加并启用一个已填写 API Key 的账号"}
                        >
                          {syncingId === channel.id ? "同步中..." : "同步"}
                        </Button>
                      </Actions>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </TableContainer>
      )}
      <p className="hint">
        同步结果将更新可开放模型列表。DeepSeek 与 LongCat 均支持同步；LongCat 同步失败时自动以内置 LongCat-2.0 兜底。
      </p>
    </Panel>
  );
}
