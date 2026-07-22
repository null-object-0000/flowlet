import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestLogRow } from "../../domains/request-log/types";

const mocks = vi.hoisted(() => ({
  useLogs: vi.fn(),
  useDetail: vi.fn(),
  cleanup: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("lottie-web", () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) } }));
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
};

beforeEach(() => {
  mocks.useLogs.mockReturnValue({ data: { rows: [row], total: 1, page: 1, pageSize: 8, summary: { requestCount: 1, successCount: 1, errorCount: 0, averageDurationMs: 860, averageTtftMs: 200, averageOutputTokensPerSecond: 75.76, knownTokens: 150, inputTokens: 100, inputCachedTokens: 60, inputUncachedTokens: 40, cacheHitRate: 0.6, estimatedCost: 0.0012 } }, isLoading: false, isFetching: false, isError: false, dataUpdatedAt: 1, refetch: mocks.refetch });
  mocks.useDetail.mockReturnValue({ data: [row], isLoading: false, isError: false, isSuccess: true, refetch: mocks.refetch });
  mocks.cleanup.mockResolvedValue([1, 0]);
});

describe("RequestLogsPage", () => {
  it("renders server-backed rows and applies a search filter", async () => {
    const user = userEvent.setup();
    render(<RequestLogsPage />);

    expect(mocks.useLogs).toHaveBeenLastCalledWith(expect.objectContaining({ timeRange: "all" }), true);
    const logRow = screen.getByRole("button", { name: `查看请求 ${row.request_id}` });
    expect(logRow).toHaveTextContent("/anthropic/v1/messages");
    expect(screen.getByText("请求数")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).not.toHaveTextContent("刷新");
    expect(screen.getAllByText("150")).toHaveLength(2);
    expect(screen.getByText("缓存命中率 60.0%")).toBeInTheDocument();
    await user.hover(within(logRow).getByText("150"));
    expect(await screen.findByText("缓存输入 Token")).toBeInTheDocument();
    expect(screen.getByText("未缓存输入 Token")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("搜索请求 ID、模型、账号或会话"), "messages");
    await waitFor(() => expect(mocks.useLogs).toHaveBeenLastCalledWith(expect.objectContaining({ search: "messages", page: 1 }), true));
  });

  it("loads details on demand and preserves captured credentials", async () => {
    const user = userEvent.setup();
    render(<RequestLogsPage />);
    await user.click(screen.getByRole("button", { name: `查看请求 ${row.request_id}` }));

    expect(await screen.findByText("请求详情")).toBeInTheDocument();
    expect(screen.queryByText("路由信息")).not.toBeInTheDocument();
    expect(screen.getByText("flowlet-pro → LongCat-2.0 · 直接路由")).toBeInTheDocument();
    expect(screen.getByText("https://api.longcat.chat/anthropic/v1/messages")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制底层接口地址" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "性能" }));
    expect(screen.getByText("响应性能")).toBeInTheDocument();
    expect(screen.getByText("Token 明细")).toBeInTheDocument();
    expect(screen.getByText("660 ms")).toBeInTheDocument();
    await user.click(screen.getByText("请求"));
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
});
