import React from "react";
import { Actions, Panel, PanelHeader, ProtocolBadges } from "../../components/ui";
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
          <button onClick={() => onRefreshChannelModels()}>刷新状态</button>
        </Actions>
      </PanelHeader>
      {channels.length === 0 ? (
        <p>暂无渠道配置。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>渠道</th>
                <th>协议</th>
                <th>同步来源</th>
                <th>同步时间</th>
                <th>已同步模型数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => {
                const status = statusMap.get(channel.id);
                const hasAccount = accounts.some(
                  (a) => a.channel_id === channel.id && a.enabled && a.api_key.trim()
                );
                return (
                  <tr key={channel.id}>
                    <td>{getChannelName(channel.id)}</td>
                    <td><ProtocolBadges protocols={channel.supported_protocols} /></td>
                    <td>{status?.source ?? "-"}</td>
                    <td>{status?.synced_at ? new Date(status.synced_at).toLocaleString() : "-"}</td>
                    <td>{status?.model_count ?? 0}</td>
                    <td>
                      <Actions>
                        <button
                          disabled={!hasAccount || syncingId === channel.id}
                          onClick={() => syncChannel(channel.id)}
                          title={hasAccount ? "同步模型列表" : "请先添加并启用一个已填写 API Key 的账号"}
                        >
                          {syncingId === channel.id ? "同步中..." : "同步"}
                        </button>
                      </Actions>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">
        同步结果将更新可开放模型列表。LongCat 同步失败时保留内置 LongCat-2.0 作为兜底。
      </p>
    </Panel>
  );
}
