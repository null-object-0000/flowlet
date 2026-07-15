import { Card, Space, Typography } from "@douyinfe/semi-ui-19";
import type { ChannelPreset } from "../../domains/channel/types";

const { Paragraph, Text, Title } = Typography;

type Props = {
  presets: ChannelPreset[];
  onAdd: (channelId: string) => void;
};

/** "No accounts yet" empty state: invites the user to add their first account.
 *  Per AGENTS.md §6 accounts must be explicitly created — no implicit default. */
export function AccountOnboarding({ presets, onAdd }: Props) {
  return (
    <Card>
      <Space vertical align="start" spacing="loose" style={{ width: "100%" }}>
        <Title heading={4} style={{ margin: 0 }}>
          还没有渠道账号
        </Title>
        <Paragraph type="tertiary" style={{ margin: 0 }}>
          添加你的第一个渠道账号，Flowlet 就能在本地为 AI 客户端和 Agent 提供模型服务。
          API Key 只保存在本机配置中。
        </Paragraph>
        <Space>
          {presets.map((p) => (
            <a key={p.id} href={p.platform_url ?? undefined} target="_blank" rel="noreferrer">
              <Text type="tertiary" size="small">
                获取 {p.name} API Key →
              </Text>
            </a>
          ))}
        </Space>
        <Space>
          {presets.map((p) => (
            <button
              key={p.id}
              style={{
                border: "none",
                borderRadius: 6,
                padding: "8px 16px",
                background: "var(--semi-color-primary)",
                color: "#fff",
                cursor: "pointer",
              }}
              onClick={() => onAdd(p.id)}
            >
              + 添加 {p.name} 账号
            </button>
          ))}
        </Space>
      </Space>
    </Card>
  );
}
