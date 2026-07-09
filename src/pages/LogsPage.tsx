import React from "react";
import { Badge, Button, Select, Table, TextInput } from "@mantine/core";
import { Actions, Panel, PanelHeader, TableContainer } from "../components/ui";
import { ChannelPreset, ClientConfig, LogFilter, LogMeta, RequestLogRow } from "../domain";
import { LogDetailDrawer } from "./LogDetailDrawer";

const DEFAULT_FILTER: LogFilter = {
  page: 1,
  pageSize: 50,
  status: "all",
  client: "",
  channel: "",
  search: "",
};

export function LogsPage({
  logs,
  logMeta,
  channels,
  clients,
  onRefresh,
}: {
  logs: RequestLogRow[];
  logMeta: LogMeta;
  channels: ChannelPreset[];
  clients: ClientConfig[];
  onRefresh: (filter?: LogFilter, page?: number) => void;
}) {
  const [filter, setFilter] = React.useState<LogFilter>(DEFAULT_FILTER);
  const [draft, setDraft] = React.useState<LogFilter>(DEFAULT_FILTER);
  const [selectedRequestId, setSelectedRequestId] = React.useState<string | null>(null);

  function applyFilter(next: Partial<LogFilter>) {
    const merged = { ...filter, ...next };
    setFilter(merged);
    // filter 变化回 page=1；page 翻页已在外部通过 page 参数传入
    onRefresh(merged, merged.page);
  }

  function goToPage(page: number) {
    const clamped = Math.max(1, page);
    setFilter((f) => ({ ...f, page: clamped }));
    onRefresh(filter, clamped);
  }

  function refresh() {
    onRefresh(filter, filter.page);
  }

  function resetFilter() {
    setFilter(DEFAULT_FILTER);
    setDraft(DEFAULT_FILTER);
    onRefresh(DEFAULT_FILTER, 1);
  }

  const pageCount = Math.max(1, Math.ceil(logMeta.total / logMeta.pageSize));
  const startItem = logMeta.total === 0 ? 0 : (logMeta.page - 1) * logMeta.pageSize + 1;
  const endItem = Math.min(logMeta.total, logMeta.page * logMeta.pageSize);

  return (
    <>
      <Panel>
        <PanelHeader>
          <h3>请求日志</h3>
          <Actions>
            <Button type="button" variant="default" onClick={refresh}>刷新</Button>
          </Actions>
        </PanelHeader>

        {/* 筛选栏 */}
        <div className="logs-filter-bar">
          <Select
            value={filter.status}
            onChange={(value) => applyFilter({ status: (value ?? "all") as LogFilter["status"], page: 1 })}
            data={[
              { value: "all", label: "全部状态" },
              { value: "success", label: "成功 (2xx/3xx)" },
              { value: "error", label: "错误 (4xx/5xx/无响应)" },
            ]}
            w={158}
          />

          <Select
            value={filter.client || "__all_clients__"}
            onChange={(value) => applyFilter({ client: value === "__all_clients__" || !value ? "" : value, page: 1 })}
            data={[{ value: "__all_clients__", label: "全部客户端" }, ...clients.map((c) => ({ value: c.id, label: c.name || c.id }))]}
            w={160}
          />

          <Select
            value={filter.channel || "__all_channels__"}
            onChange={(value) => applyFilter({ channel: value === "__all_channels__" || !value ? "" : value, page: 1 })}
            data={[{ value: "__all_channels__", label: "全部渠道" }, ...channels.map((ch) => ({ value: ch.id, label: ch.name || ch.id }))]}
            w={150}
          />

          <TextInput
            className="logs-search"
            placeholder="搜索路径 / 请求 ID / 错误信息"
            value={draft.search}
            onChange={(e) => setDraft((d) => ({ ...d, search: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyFilter({ search: draft.search, page: 1 });
            }}
          />
          <Button type="button" onClick={() => applyFilter({ search: draft.search, page: 1 })}>搜索</Button>
          {(filter.status !== "all" || filter.client || filter.channel || filter.search) && (
            <Button type="button" variant="subtle" color="gray" onClick={resetFilter}>重置筛选</Button>
          )}
        </div>

        <p className="hint">
          仅展示每次请求尝试的最终记录。点击「详情」查看完整尝试链路、请求/响应 Headers 与 Body（已脱敏）。
        </p>

        <TableContainer>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>时间</Table.Th>
                <Table.Th>客户端</Table.Th>
                <Table.Th>渠道</Table.Th>
                <Table.Th>账号</Table.Th>
                <Table.Th>协议</Table.Th>
                <Table.Th>类型</Table.Th>
                <Table.Th>对外模型</Table.Th>
                <Table.Th>上游模型</Table.Th>
                <Table.Th>状态</Table.Th>
                <Table.Th>TTFB</Table.Th>
                <Table.Th>耗时</Table.Th>
                <Table.Th>降级</Table.Th>
                <Table.Th>原因</Table.Th>
                <Table.Th></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {logs.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={14}>
                    {logMeta.total === 0 ? "暂无请求日志" : "当前筛选条件下无匹配记录"}
                  </Table.Td>
                </Table.Tr>
              ) : (
                logs.map((row) => (
                  <Table.Tr key={`${row.created_at}-${row.path}-${row.id}`}>
                    <Table.Td>{formatTimestamp(row.created_at)}</Table.Td>
                    <Table.Td>{row.client_name || row.client_id || "未知"}</Table.Td>
                    <Table.Td>{row.channel_name || row.channel_id || "-"}</Table.Td>
                    <Table.Td>{row.account_name || row.account_id || "-"}</Table.Td>
                    <Table.Td>{row.client_protocol}</Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={row.request_type === "error" ? "red" : "blue"} size="xs">
                        {row.request_type}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{row.public_model || "-"}</Table.Td>
                    <Table.Td>{row.upstream_model || "-"}</Table.Td>
                    <Table.Td>{row.status ?? "-"}</Table.Td>
                    <Table.Td>{formatMs(row.ttfb_ms)}</Table.Td>
                    <Table.Td>{formatMs(row.duration_ms ?? row.latency_ms)}</Table.Td>
                    <Table.Td>{row.fallback_count}</Table.Td>
                    <Table.Td>{row.route_reason || row.error_message || "-"}</Table.Td>
                    <Table.Td>
                      <Button type="button"
                        variant="subtle"
                        onClick={() => setSelectedRequestId(row.request_id)}
                      >
                        详情
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))
              )}
            </Table.Tbody>
          </Table>
        </TableContainer>

        {/* 分页栏 */}
        {logMeta.total > 0 && (
          <div className="pagination">
            <Button type="button" variant="default" disabled={logMeta.page <= 1} onClick={() => goToPage(logMeta.page - 1)}>上一页</Button>
            <span className="pagination-info">
              {logMeta.page} / {pageCount} （{startItem}–{endItem} / 共 {logMeta.total} 条）
            </span>
            <Button type="button" variant="default" disabled={logMeta.page >= pageCount} onClick={() => goToPage(logMeta.page + 1)}>下一页</Button>
            <Select
              value={String(logMeta.pageSize)}
              onChange={(value) => {
                const size = Number(value ?? 50);
                applyFilter({ pageSize: size, page: 1 });
              }}
              data={[
                { value: "25", label: "25 条/页" },
                { value: "50", label: "50 条/页" },
                { value: "100", label: "100 条/页" },
              ]}
              w={110}
            />
          </div>
        )}
      </Panel>

      {selectedRequestId ? (
        <LogDetailDrawer
          requestId={selectedRequestId}
          onClose={() => setSelectedRequestId(null)}
        />
      ) : null}
    </>
  );
}

function formatMs(ms: number | null): string {
  if (ms == null) return "-";
  return `${ms} ms`;
}

/// SQLite datetime('now') 返回 UTC；前端转本地时间展示。
function formatTimestamp(created: string | null): string {
  if (!created) return "-";
  try {
    const iso = created.includes("T") || created.endsWith("Z")
      ? created
      : `${created.replace(" ", "T")}Z`;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return created;
    return d.toLocaleString("zh-CN", {
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return created;
  }
}



