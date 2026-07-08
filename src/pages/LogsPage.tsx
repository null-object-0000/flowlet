import React from "react";
import { Button, Select, TextInput } from "@mantine/core";
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
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>客户端</th>
                <th>渠道</th>
                <th>账号</th>
                <th>协议</th>
                <th>类型</th>
                <th>对外模型</th>
                <th>上游模型</th>
                <th>状态</th>
                <th>TTFB</th>
                <th>耗时</th>
                <th>降级</th>
                <th>原因</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={14}>
                    {logMeta.total === 0 ? "暂无请求日志" : "当前筛选条件下无匹配记录"}
                  </td>
                </tr>
              ) : (
                logs.map((row) => (
                  <tr key={`${row.created_at}-${row.path}-${row.id}`}>
                    <td>{formatTimestamp(row.created_at)}</td>
                    <td>{row.client_name || row.client_id || "未知"}</td>
                    <td>{row.channel_name || row.channel_id || "-"}</td>
                    <td>{row.account_name || row.account_id || "-"}</td>
                    <td>{row.client_protocol}</td>
                    <td>
                      <span className={`request-type-badge request-type-${row.request_type}`}>
                        {row.request_type}
                      </span>
                    </td>
                    <td>{row.public_model || "-"}</td>
                    <td>{row.upstream_model || "-"}</td>
                    <td>{row.status ?? "-"}</td>
                    <td>{formatMs(row.ttfb_ms)}</td>
                    <td>{formatMs(row.duration_ms ?? row.latency_ms)}</td>
                    <td>{row.fallback_count}</td>
                    <td>{row.route_reason || row.error_message || "-"}</td>
                    <td>
                      <button type="button"
                        className="link-button"
                        onClick={() => setSelectedRequestId(row.request_id)}
                      >
                        详情
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableContainer>

        {/* 分页栏 */}
        {logMeta.total > 0 && (
          <div className="pagination">
            <Button type="button" variant="default" disabled={logMeta.page <= 1} onClick={() => goToPage(logMeta.page - 1)}>上一页</Button>
            <span className="pagination-info">
              {logMeta.page} / {pageCount} （{startItem}–{endItem} / 共 {logMeta.total} 条）
            </span>
            <Button type="button" variant="default" disabled={logMeta.page >= pageCount} onClick={() => goToPage(logMeta.page + 1)}>下一页</Button>
            <select
              value={logMeta.pageSize}
              onChange={(e) => {
                const size = Number(e.target.value);
                applyFilter({ pageSize: size, page: 1 });
              }}
            >
              <option value={25}>25 条/页</option>
              <option value={50}>50 条/页</option>
              <option value={100}>100 条/页</option>
            </select>
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



