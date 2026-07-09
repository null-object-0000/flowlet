import { ActionIcon, Badge, Box, Group, NavLink, Stack, Text, Tooltip } from "@mantine/core";
import {
  IconActivity,
  IconChartBar,
  IconChevronLeft,
  IconChevronRight,
  IconDashboard,
  IconKey,
  IconListDetails,
  IconRoute,
} from "@tabler/icons-react";
import { ProxyStatus, View, views } from "../../domain";

type SidebarProps = {
  view: View;
  status: ProxyStatus;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onViewChange: (view: View) => void;
};

const navIcons: Record<View, typeof IconDashboard> = {
  overview: IconDashboard,
  routes: IconRoute,
  accounts: IconKey,
  logs: IconListDetails,
  usage: IconChartBar,
  stats: IconActivity,
};

export function Sidebar({ view, status, collapsed, onToggleCollapsed, onViewChange }: SidebarProps) {
  return (
    <Stack className="sidebar-shell" gap="md" h="100%">
      <Group className="brand" justify={collapsed ? "center" : "space-between"} wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <span className="brand-mark">F</span>
          {!collapsed ? (
            <Box className="brand-copy">
              <Text fw={700} lh={1.1}>Flowlet</Text>
              <Badge variant="light" color="gray" size="xs">v0.1.0</Badge>
            </Box>
          ) : null}
        </Group>
        <Tooltip label={collapsed ? "展开侧栏" : "折叠侧栏"} position="right" withArrow>
          <ActionIcon variant="subtle" color="gray" onClick={onToggleCollapsed} aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}>
            {collapsed ? <IconChevronRight size={16} /> : <IconChevronLeft size={16} />}
          </ActionIcon>
        </Tooltip>
      </Group>

      <Stack component="nav" gap={4} className="nav-stack">
        {views.map((item) => {
          const Icon = navIcons[item.id];
          const link = (
            <NavLink
              key={item.id}
              active={view === item.id}
              label={collapsed ? undefined : item.label}
              leftSection={<Icon size={18} />}
              onClick={() => onViewChange(item.id)}
              className={collapsed ? "nav-link collapsed" : "nav-link"}
              aria-label={item.label}
            />
          );
          return collapsed ? (
            <Tooltip key={item.id} label={item.label} position="right" withArrow>
              {link}
            </Tooltip>
          ) : link;
        })}
      </Stack>

      <Box className={collapsed ? "sidebar-status collapsed" : "sidebar-status"} mt="auto">
        <span className={status.running ? "status-dot" : "status-dot muted"} />
        {!collapsed ? (
          <>
            <Text fw={700} size="sm">{status.running ? "服务运行中" : "服务已停止"}</Text>
            <Text size="xs" c="dimmed">{status.running ? "代理正在监听本地请求" : "等待启动代理服务"}</Text>
          </>
        ) : null}
      </Box>
    </Stack>
  );
}
