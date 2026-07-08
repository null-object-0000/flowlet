import { Badge, Button, Group, Text } from "@mantine/core";
import { IconPlayerPlay, IconPlayerStop } from "@tabler/icons-react";
import { ProxyStatus } from "../../domain";

type ProxyTopbarProps = {
  status: ProxyStatus;
  onStart: () => void;
  onStop: () => void;
};

export function ProxyTopbar({ status, onStart, onStop }: ProxyTopbarProps) {
  return (
    <header className="topbar">
      <div>
        <Text fw={700} size="sm">代理服务</Text>
        <Text c="dimmed" size="xs">{status.running ? "正在监听本地请求" : "代理服务未启动"}</Text>
      </div>
      <Group className="topbar-actions" gap="xs" wrap="nowrap">
        <Button leftSection={<IconPlayerPlay size={14} />} onClick={onStart} disabled={status.running} variant="light">
          启动
        </Button>
        <Button leftSection={<IconPlayerStop size={14} />} onClick={onStop} disabled={!status.running} variant="default">
          停止
        </Button>
        <Badge color={status.running ? "green" : "gray"} variant="light">
          {status.running ? "运行中" : "已停止"}
        </Badge>
      </Group>
    </header>
  );
}
