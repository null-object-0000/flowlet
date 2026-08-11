import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestLogRow } from "../../domains/request-log/types";

const mocks = vi.hoisted(() => ({
  useLogs: vi.fn(),
  useDetail: vi.fn(),
  cleanup: vi.fn(),
  refetch: vi.fn(),
  navigate: vi.fn(),
  useLocation: vi.fn(),
}));

vi.mock("lottie-web", () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) } }));
vi.mock("react-router-dom", () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => mocks.useLocation(),
}));
vi.mock("../../features/channel-accounts", () => ({
  useChannelPresets: () => ({ data: [{ id: "longcat", name: "LongCat" }], isLoading: false }),
}));
vi.mock("../../features/request-logs/useRequestLogs", () => ({
  useRequestLogs: (...args: unknown[]) => mocks.useLogs(...args),
  useRequestLogClients: () => ({ data: [{ id: "claude-code", name: "Claude Code" }], isLoading: false }),
  useRequestLogModels: () => ({ data: { publicModels: ["flowlet-pro"], upstreamModels: ["LongCat-2.0"] }, isLoading: false }),
  useRequestLogDetail: (...args: unknown[]) => mocks.useDetail(...args),
  useRequestLogActions: () => ({ cleanup: { mutateAsync: mocks.cleanup, isPending: false } }),
}));

import { RequestLogsPage } from "./RequestLogsPage";

const row: RequestLogRow = {
  id: "log-1", request_id: "request-123456789", client_id: "claude-code", client_name: "Claude Code",
  channel_id: "longcat", channel_name: "LongCat", account_id: "account-1", account_name: "主账号",
  client_protocol: "anthropic", upstream_protocol: "anthropic", virtual_model: "flowlet-pro",
  public_model: "flowlet-pro", upstream_model: "LongCat-2.0", request_type: "messages", method: "POST",
  path: "/anthropic/v1/messages", upstream_url: "https://api.longcat.chat/anthropic/v1/messages", status: 200, latency_ms: 860, is_stream: true, error_message: null,
  fallback_count: 0, route_reason: "primary", created_at: "2026-07-15 06:00:00", ttfb_ms: 120,
  ttft_ms: 200, duration_ms: 860, attempt_seq: 1, req_headers_json: JSON.stringify({ Authorization: "Bearer secret-key" }),
  req_body_b64: btoa(JSON.stringify({ model: "flowlet-pro" })), res_headers_json: JSON.stringify({ "content-type": "application/json" }),
  req_body_cleared_at: null, req_body_cleanup_reason: null,
  res_body_b64: btoa(JSON.stringify({ ok: true })), is_last_attempt: true,
  res_body_cleared_at: null, res_body_cleanup_reason: null,
  input_tokens: 100, input_cached_tokens: 60, input_uncached_tokens: 40, output_tokens: 50, total_tokens: 150, estimated_cost: 0.0012,
  estimated_input_uncached_cost: 0.0004, estimated_input_cached_cost: 0.00024, estimated_input_cache_write_cost: null, estimated_output_cost: 0.0004,
  agent_type: "claude-code", agent_session_id: "session-123", parent_agent_session_id: null,
};

beforeEach(() => {
  mocks.useLogs.mockReturnValue({ data: { rows: [row], total: 1, page: 1, pageSize: 8, summary: { requestCount: 1, successCount: 1, errorCount: 0, averageDurationMs: 860, averageTtftMs: 200, averageOutputTokensPerSecond: 75.76, knownTokens: 150, inputTokens: 100, inputCachedTokens: 60, inputUncachedTokens: 40, cacheHitRate: 0.6, estimatedCost: 0.0012 } }, isLoading: false, isFetching: false, isError: false, dataUpdatedAt: 1, refetch: mocks.refetch });
  mocks.useDetail.mockReturnValue({ data: [row], isLoading: false, isError: false, isSuccess: true, refetch: mocks.refetch });
  mocks.cleanup.mockResolvedValue([1, 0]);
  mocks.useLocation.mockReturnValue({ search: "", hash: "" });
});

describe("RequestLogsPage", () => {
  it("renders server-backed rows and applies a search filter", async () => {
    const user = userEvent.setup();
    render(<RequestLogsPage />);

    expect(mocks.useLogs).toHaveBeenLastCalledWith(expect.objectContaining({ timeRange: "all" }), true);
    const logRow = screen.getByRole("button", { name: `查看请求 ${row.request_id}` });
    expect(logRow).toHaveTextContent("/anthropic/v1/messages");
    // 请求数/失败统计卡片已融合到表格左下角 footer，不再作为顶部独立卡片展示。
    expect(screen.queryByText("请求数")).not.toBeInTheDocument();
    expect(screen.getByText("请求 1 条")).toBeInTheDocument();
    expect(screen.getByText("失败 0 条")).toBeInTheDocument();
    expect(screen.getByText("当前显示 1 条")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新数据" })).not.toHaveTextContent("刷新数据");
    expect(screen.getAllByText("150")).toHaveLength(2);
    expect(screen.getByText("缓存命中率 60.0%")).toBeInTheDocument();
    await user.hover(within(logRow).getByText("150"));
    expect(await screen.findByText("缓存输入 Token")).toBeInTheDocument();
    expect(screen.getByText("未缓存输入 Token")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("搜索请求 ID、模型、账号或会话"), "messages");
    await waitFor(() => expect(mocks.useLogs).toHaveBeenLastCalledWith(expect.objectContaining({ search: "messages", page: 1 }), true));
  });

  it("renders grouped model options and applies the selected model filter", async () => {
    const user = userEvent.setup();
    render(<RequestLogsPage />);

    const filterToolbar = screen.getByRole("region", { name: "日志筛选" });
    const modelSelect = within(filterToolbar).getAllByRole("combobox")[1];
    expect(modelSelect).toHaveTextContent("全部模型");
    await user.click(modelSelect);
    expect(await screen.findByText("路由模型 · LongCat-2.0")).toBeInTheDocument();
    const publicModelOption = (await screen.findByText("对外模型 · flowlet-pro")).closest(".semi-select-option");
    expect(publicModelOption).not.toBeNull();
    fireEvent.click(publicModelOption as HTMLElement);

    await waitFor(() => expect(mocks.useLogs).toHaveBeenCalledWith(expect.objectContaining({
      model: "flowlet-pro",
      modelKind: "public",
      page: 1,
    }), true));
  });

  it("loads details on demand and preserves captured credentials", async () => {
    const user = userEvent.setup();
    const { container } = render(<RequestLogsPage />);
    await user.click(screen.getByRole("button", { name: `查看请求 ${row.request_id}` }));

    expect(await screen.findByText("请求详情")).toBeInTheDocument();
    // 大体积日志不能在宽度为 0 的隐藏面板中初始化 autoWrap JsonViewer，
    // 否则 WebView 会在打开详情时崩溃；概览阶段只能挂载概览内容。
    expect(container.querySelector(".semi-json-viewer")).not.toBeInTheDocument();
    expect(screen.queryByText("路由信息")).not.toBeInTheDocument();
    expect(screen.getByText("flowlet-pro → LongCat-2.0 · 直接路由")).toBeInTheDocument();
    expect(screen.getByText("https://api.longcat.chat/anthropic/v1/messages")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制底层接口地址" })).toBeInTheDocument();
    // 入口请求地址已包含完整路径，"请求接口"（method + path）会与它重复展示 path，
    // 因此详情只保留完整的入口请求地址，method 由独立的"请求方法"字段展示。
    expect(screen.getByText("请求方法")).toBeInTheDocument();
    expect(screen.queryByText("请求接口")).not.toBeInTheDocument();
    // 请求方法 / 客户端 / 客户端协议 / HTTP 状态 合并到同一行展示，提高信息密度。
    // 表格列头也有"客户端"文本，因此限定在 metaRow 行容器内断言。
    const metaRow = screen.getByText("请求方法").closest("div")?.parentElement;
    expect(metaRow).not.toBeNull();
    for (const label of ["请求方法", "客户端", "客户端协议", "HTTP 状态"]) {
      expect(within(metaRow as HTMLElement).getByText(label)).toBeInTheDocument();
    }
    expect(metaRow?.textContent).toContain("POST");
    expect(metaRow?.textContent).toContain("Claude Code");
    expect(metaRow?.textContent).toContain("anthropic");
    expect(metaRow?.textContent).toContain("200");
    await user.click(screen.getByRole("tab", { name: "性能" }));
    expect(screen.getByText("响应性能")).toBeInTheDocument();
    expect(screen.getByText("Token 明细")).toBeInTheDocument();
    expect(screen.getByText("660 ms")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "请求" }));
    expect(screen.queryByText("敏感凭据已隐藏")).not.toBeInTheDocument();
    expect(screen.getByText(/secret-key/)).toBeInTheDocument();
  });

  it("distinguishes the inbound URL from a missing upstream route", async () => {
    const user = userEvent.setup();
    mocks.useDetail.mockReturnValue({
      data: [{
        ...row,
        status: 404,
        upstream_url: null,
        channel_id: null,
        channel_name: null,
        account_id: null,
        account_name: null,
        route_reason: "model_not_exposed",
        error_message: "model_not_exposed",
        req_headers_json: JSON.stringify({ host: "127.0.0.1:18640" }),
      }],
      isLoading: false,
      isError: false,
      isSuccess: true,
      refetch: mocks.refetch,
    });

    render(<RequestLogsPage />);
    await user.click(screen.getByRole("button", { name: `查看请求 ${row.request_id}` }));

    expect(await screen.findByText("http://127.0.0.1:18640/anthropic/v1/messages")).toBeInTheDocument();
    expect(screen.getByText("未发往上游（路由前失败）")).toBeInTheDocument();
    expect(screen.queryByText("旧日志未记录")).not.toBeInTheDocument();
  });

  it("exposes the session ID with copy and click-to-filter in the overview", async () => {
    const user = userEvent.setup();
    mocks.useDetail.mockReturnValue({
      data: [{ ...row, agent_session_id: "session-123", agent_type: "claude-code", parent_agent_session_id: null }],
      isLoading: false,
      isError: false,
      isSuccess: true,
      refetch: mocks.refetch,
    });
    // 点击会话 ID 链接后，RequestLogsPage 通过 navigate 写入 search 参数；这里模拟
    // react-router 的 useLocation 返回更新后的 search，驱动筛选 effect 同步到 filter。
    mocks.useLocation.mockReturnValue({ search: "?search=session-123", hash: "" });

    render(<RequestLogsPage />);
    await user.click(screen.getByRole("button", { name: `查看请求 ${row.request_id}` }));

    expect(await screen.findByText("请求详情")).toBeInTheDocument();
    expect(screen.getByText("会话 ID")).toBeInTheDocument();
    expect(screen.getByText("session-123")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制会话 ID" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "查看会话 session-123 的请求日志" }));
    expect(mocks.navigate).toHaveBeenLastCalledWith("/logs?search=session-123");

    // 关键：search 参数同步到搜索框并触发筛选，不能只导航不筛选。
    expect(await screen.findByDisplayValue("session-123")).toBeInTheDocument();
    await waitFor(() => expect(mocks.useLogs).toHaveBeenLastCalledWith(expect.objectContaining({ search: "session-123", page: 1 }), true));
  });

  it("shows a placeholder session ID row without link or copy when the log has no session", async () => {
    const user = userEvent.setup();
    mocks.useDetail.mockReturnValue({
      data: [{ ...row, agent_session_id: null, agent_type: null, parent_agent_session_id: null }],
      isLoading: false,
      isError: false,
      isSuccess: true,
      refetch: mocks.refetch,
    });

    render(<RequestLogsPage />);
    await user.click(screen.getByRole("button", { name: `查看请求 ${row.request_id}` }));

    expect(await screen.findByText("请求详情")).toBeInTheDocument();
    expect(screen.getByText("会话 ID")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制会话 ID" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /查看会话/ })).not.toBeInTheDocument();
  });
});
