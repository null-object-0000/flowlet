import React from "react";
import { Actions, Panel, PanelHeader } from "../components/ui";
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
            <button type="button" onClick={refresh}>刷新</button>
          </Actions>
        </PanelHeader>

        {/* 筛选栏 */}
        <div className="logs-filter-bar">
          <select
            value={filter.status}
            onChange={(e) => applyFilter({ status: e.target.value as LogFilter["status"], page: 1 })}
          >
            <option value="all">全部状态</option>
            <option value="success">成功 (2xx/3xx)</option>
            <option value="error">错误 (4xx/5xx/无响应)</option>
          </select>

          <select
            value={filter.client}
            onChange={(e) => applyFilter({ client: e.target.value, page: 1 })}
          >
            <option value="">全部客户端</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || c.id}
              </option>
            ))}
          </select>

          <select
            value={filter.channel}
            onChange={(e) => applyFilter({ channel: e.target.value, page: 1 })}
          >
            <option value="">全部渠道</option>
            {channels.map((ch) => (
              <option key={ch.id} value={ch.id}>
                {ch.name || ch.id}
              </option>
            ))}
          </select>

          <input
            className="logs-search"
            placeholder="搜索路径 / 请求 ID / 错误信息"
            value={draft.search}
            onChange={(e) => setDraft((d) => ({ ...d, search: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyFilter({ search: draft.search, page: 1 });
            }}
          />
          <button type="button" onClick={() => applyFilter({ search: draft.search, page: 1 })}>搜索</button>
          {(filter.status !== "all" || filter.client || filter.channel || filter.search) && (
            <button type="button" className="link-button" onClick={resetFilter}>
              重置筛选
            </button>
          )}
        </div>

        <p className="hint">
          仅展示每次请求尝试的最终记录。点击「详情」查看完整尝试链路、请求/响应 Headers 与 Body（已脱敏）。
        </p>

        <div className="table-wrap">
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
        </div>

        {/* 分页栏 */}
        {logMeta.total > 0 && (
          <div className="pagination">
            <button type="button"
              disabled={logMeta.page <= 1}
              onClick={() => goToPage(logMeta.page - 1)}
            >
              上一页
            </button>
            <span className="pagination-info">
              {logMeta.page} / {pageCount} （{startItem}–{endItem} / 共 {logMeta.total} 条）
            </span>
            <button type="button"
              disabled={logMeta.page >= pageCount}
              onClick={() => goToPage(logMeta.page + 1)}
            >
              下一页
            </button>
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
