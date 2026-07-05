import React from "react";
import { runCommand } from "../services/flowletApi";
import { RequestLogRow } from "../domain";

type Status = "idle" | "loading" | "ready" | "error";

export function LogDetailDrawer({
  requestId,
  onClose,
}: {
  requestId: string;
  onClose: () => void;
}) {
  const [rows, setRows] = React.useState<RequestLogRow[]>([]);
  const [status, setStatus] = React.useState<Status>("idle");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);
    runCommand<RequestLogRow[]>("get_request_log_detail", { requestId })
      .then((result) => {
        if (cancelled) return;
        setRows(result);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  const finalRow = rows.length === 0 ? null : rows[rows.length - 1];

  return (
    <>
      <div className="detail-backdrop" onClick={onClose} />
      <aside className="detail-drawer" role="dialog" aria-label="请求日志详情">
        <header className="detail-header">
          <div>
            <h3>请求详情</h3>
            <div className="muted">{requestId}</div>
          </div>
          <button type="button" className="link-button" onClick={onClose}>
            关闭 ✕
          </button>
        </header>

        <div className="detail-body">
          {status === "loading" ? <p>加载中…</p> : null}
          {status === "error" ? <p className="error">加载失败：{error}</p> : null}
          {status !== "loading" && status !== "error" && rows.length === 0 ? (
            <p>未找到匹配的日志记录。</p>
          ) : null}

          {finalRow ? (
            <>
              <section className="section">
                <h4 className="section-title">基础信息</h4>
                <dl className="kv-grid">
                  <dt>时间</dt>
                  <dd>{formatTimestamp(finalRow.created_at)}</dd>
                  <dt>客户端</dt>
                  <dd>{finalRow.client_name || finalRow.client_id || "-"}</dd>
                  <dt>协议</dt>
                  <dd>{finalRow.client_protocol}</dd>
                  <dt>对外模型</dt>
                  <dd>{finalRow.public_model || "-"}</dd>
                  <dt>上游模型</dt>
                  <dd>{finalRow.upstream_model || "-"}</dd>
                  <dt>请求类型</dt>
                  <dd>{finalRow.request_type}</dd>
                  <dt>状态码</dt>
                  <dd>{finalRow.status ?? "-"}</dd>
                  <dt>TTFB</dt>
                  <dd>{fmtMs(finalRow.ttfb_ms)}</dd>
                  <dt>耗时</dt>
                  <dd>{fmtMs(finalRow.duration_ms ?? finalRow.latency_ms)}</dd>
                  <dt>降级次数</dt>
                  <dd>{finalRow.fallback_count}</dd>
                  <dt>路由原因</dt>
                  <dd>{finalRow.route_reason || "-"}</dd>
                  <dt>错误信息</dt>
                  <dd>{finalRow.error_message || "-"}</dd>
                </dl>
              </section>

              {rows.length > 1 ? (
                <section className="section">
                  <h4 className="section-title">尝试链路（{rows.length} 次尝试）</h4>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>渠道</th>
                          <th>账号</th>
                          <th>状态</th>
                          <th>TTFB</th>
                          <th>耗时</th>
                          <th>原因</th>
                          <th>错误</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, idx) => (
                          <tr key={row.id} className="attempt-row">
                            <td>{idx + 1}</td>
                            <td>{row.channel_name || row.channel_id || "-"}</td>
                            <td>{row.account_name || row.account_id || "-"}</td>
                            <td>{row.status ?? "-"}</td>
                            <td>{fmtMs(row.ttfb_ms)}</td>
                            <td>{fmtMs(row.duration_ms)}</td>
                            <td>{row.route_reason || "-"}</td>
                            <td title={row.error_message ?? ""}>
                              {row.error_message
                                ? row.error_message.length > 40
                                  ? row.error_message.slice(0, 40) + "…"
                                  : row.error_message
                                : "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : null}

              <section className="section">
                <h4 className="section-title">请求详情</h4>
                <dl className="kv-grid">
                  <dt>Method</dt>
                  <dd>{finalRow.method}</dd>
                  <dt>Path</dt>
                  <dd>{finalRow.path}</dd>
                  <dt>是否流式</dt>
                  <dd>{finalRow.is_stream ? "是" : "否"}</dd>
                </dl>
                <h5 className="block-title">Request Headers</h5>
                <code className="code-block">{formatJson(finalRow.req_headers_json)}</code>
                <h5 className="block-title">Request Body</h5>
                <code className="code-block">{formatBody(finalRow.req_body_b64)}</code>
              </section>

              <section className="section">
                <h4 className="section-title">响应详情</h4>
                <h5 className="block-title">Response Headers</h5>
                <code className="code-block">{formatJson(finalRow.res_headers_json)}</code>
                <h5 className="block-title">Response Body</h5>
                <code className="code-block">{formatBody(finalRow.res_body_b64)}</code>
                {finalRow.stream_summary ? (
                  <>
                    <h5 className="block-title">流式摘要</h5>
                    <pre className="code-block">{finalRow.stream_summary}</pre>
                  </>
                ) : null}
              </section>
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "-";
  return `${ms} ms`;
}

/// SQLite 的 datetime('now') 返回 UTC（如 2026-07-04 03:07:23）。
/// 附加 'Z' 让浏览器按 UTC 解析，再用本地时间展示。
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

function formatJson(s: string | null): string {
  if (!s) return "— （未捕获）";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

/// base64 解码：先用 atob 转为 Latin-1 字节串，再用 TextDecoder
/// 按 UTF-8 解码，避免多字节中文出现乱码。
function formatBody(b64: string | null): string {
  if (!b64) return "— （未捕获）";
  try {
    if (typeof atob !== "function") return b64;
    const latin1 = atob(b64);
    const bytes = new Uint8Array(latin1.length);
    for (let i = 0; i < latin1.length; i++) {
      bytes[i] = latin1.charCodeAt(i);
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  } catch {
    return b64;
  }
}
