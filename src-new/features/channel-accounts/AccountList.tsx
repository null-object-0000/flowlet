import { Button, Card, Space, Table, Tag, Typography } from "@douyinfe/semi-ui-19";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";

const { Text } = Typography;

type Row = ChannelAccount & { channelName: string };

type Props = {
  presets: ChannelPreset[];
  accounts: ChannelAccount[];
  onEdit: (accountId: string) => void;
  onAdd: (channelId: string) => void;
  onTestConnection: (account: ChannelAccount) => void;
  onRemove: (accountId: string) => void;
  busy?: boolean;
};

const STATUS_LABEL: Record<string, { label: string; color: "green" | "red" | "grey" }> = {
  healthy: { label: "可用", color: "green" },
  invalid_key: { label: "鉴权失败", color: "red" },
};

/** Per-channel account list. API keys are never shown here (only inside the
 *  editor). */
export function AccountList({
  presets,
  accounts,
  onEdit,
  onAdd,
  onTestConnection,
  onRemove,
  busy,
}: Props) {
  const nameById = new Map(presets.map((p) => [p.id, p.name]));
  const rows: Row[] = accounts.map((a) => ({
    ...a,
    channelName: nameById.get(a.channel_id) ?? a.channel_id,
  }));

  const columns = [
    { title: "渠道", dataIndex: "channelName", render: (v: string) => <Text>{v}</Text> },
    { title: "名称", dataIndex: "name" },
    {
      title: "状态",
      dataIndex: "credential_status",
      render: (s: string) => {
        const st = STATUS_LABEL[s] ?? { label: s || "未知", color: "grey" as const };
        return <Tag color={st.color}>{st.label}</Tag>;
      },
    },
    { title: "启用", dataIndex: "enabled", render: (v: boolean) => <Tag color={v ? "green" : "grey"}>{v ? "是" : "否"}</Tag> },
    {
      title: "操作",
      render: (_: unknown, row: Row) => (
        <Space spacing="tight">
          <Button size="small" onClick={() => onEdit(row.id)}>编辑</Button>
          <Button size="small" onClick={() => onTestConnection(row)} disabled={busy}>
            测试连接
          </Button>
          <Button size="small" type="danger" onClick={() => onRemove(row.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card>
      <Space vertical align="start" spacing="loose" style={{ width: "100%" }}>
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Typography.Title heading={5} style={{ margin: 0 }}>
            渠道账号
          </Typography.Title>
        </Space>
        {presets.map((p) => (
          <div key={p.id} style={{ width: "100%" }}>
            <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }}>
              <Text strong>{p.name}</Text>
              <Button size="small" onClick={() => onAdd(p.id)}>
                + 添加账号
              </Button>
            </Space>
            <Table
              columns={columns}
              dataSource={rows.filter((r) => r.channel_id === p.id)}
              pagination={false}
              empty={<Text type="tertiary">尚未添加账号</Text>}
            />
          </div>
        ))}
      </Space>
    </Card>
  );
}
