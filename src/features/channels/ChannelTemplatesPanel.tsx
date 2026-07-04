import React from "react";
import { Actions, DetailsPanel, PanelHeader, ProtocolBadges } from "../../components/ui";
import { ChannelPreset } from "../../domain";

type ChannelTemplatesPanelProps = {
  channels: ChannelPreset[];
  onAddAccount: (channelId: string) => void;
  onSaveChannels: () => void;
};

export function ChannelTemplatesPanel({ channels, onAddAccount, onSaveChannels }: ChannelTemplatesPanelProps) {
  const [editingChannel, setEditingChannel] = React.useState<string | null>(null);

  return (
    <DetailsPanel summary="高级设置：渠道模板">
      <PanelHeader>
        <h3>渠道模板</h3>
        <Actions>
          <button onClick={() => void onSaveChannels()}>保存渠道</button>
        </Actions>
      </PanelHeader>
      <div className="channel-grid">
        {channels.map((channel) => (
          <div className="channel-card" key={channel.id}>
            <div className="channel-header">
              <strong>{channel.name}</strong>
              <span className="channel-vendor">{channel.vendor}</span>
            </div>
            <ProtocolBadges protocols={channel.supported_protocols} />
            <button onClick={() => onAddAccount(channel.id)}>新增{channel.name}账号</button>
            <button className="link-button" onClick={() => setEditingChannel(editingChannel === channel.id ? null : channel.id)}>
              {editingChannel === channel.id ? "收起详情" : "查看配置"}
            </button>
            {editingChannel === channel.id ? (
              <div className="channel-detail">
                <label>OpenAI Base URL<input value={channel.openai_base_url} onChange={() => {}} /></label>
                <label>Anthropic Base URL<input value={channel.anthropic_base_url} readOnly /></label>
                <label>默认模型<input value={channel.default_model} readOnly /></label>
                <label>小模型（简单请求自动路由）<input value={channel.small_model ?? ""} placeholder="留空则不使用小模型路由" readOnly /></label>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </DetailsPanel>
  );
}


