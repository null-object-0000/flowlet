import { Badge, Box, Group, NavLink, Stack, Text } from "@mantine/core";
import {
  IconActivity,
  IconChartBar,
  IconDashboard,
  IconListDetails,
  IconRoute,
} from "@tabler/icons-react";
import { ProxyStatus, View, views } from "../../domain";

type SidebarProps = {
  view: View;
  status: ProxyStatus;
  onViewChange: (view: View) => void;
};

const navIcons: Record<View, typeof IconDashboard> = {
  overview: IconDashboard,
  routes: IconRoute,
  logs: IconListDetails,
  usage: IconChartBar,
  stats: IconActivity,
};

export function Sidebar({ view, status, onViewChange }: SidebarProps) {
  return (
    <Stack className="sidebar-shell" gap="md" h="100%">
      <Group className="brand" justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <span className="brand-mark">F</span>
          <Box className="brand-copy">
            <Text fw={700} lh={1.1}>Flowlet</Text>
            <Badge variant="light" color="gray" size="xs">v0.1.0</Badge>
          </Box>
        </Group>
      </Group>

      <Stack component="nav" gap={4} className="nav-stack">
        {views.map((item) => {
          const Icon = navIcons[item.id];
          const link = (
            <NavLink
              key={item.id}
              active={view === item.id}
              label={item.label}
              leftSection={<Icon size={18} />}
              onClick={() => onViewChange(item.id)}
              className="nav-link"
              aria-label={item.label}
            />
          );
          return link;
        })}
      </Stack>

      <Box className="sidebar-status" mt="auto">
        <span className={status.running ? "status-dot" : "status-dot muted"} />
        <Text fw={700} size="sm">{status.running ? "服务运行中" : "服务已停止"}</Text>
        <Text size="xs" c="dimmed">{status.running ? "代理正在监听本地请求" : "等待启动代理服务"}</Text>
      </Box>
    </Stack>
  );
}
