import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toast } from "@douyinfe/semi-ui-19";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mutateAsync = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const captureState = vi.hoisted(() => ({
  data: {
    capture_req_headers: true,
    capture_req_body: true,
    capture_res_headers: true,
    capture_res_body: true,
    max_body_bytes: 1_048_576,
    redact_sensitive_headers: false,
    body_retention_days: 7,
    body_max_size_mb: 512,
    body_prune_ratio: 0.1,
  },
}));

vi.mock("../../features/settings/useLogCaptureSetting", () => ({
  useLogCaptureSetting: () => ({
    query: { data: captureState.data, isLoading: false, isError: false },
    mutation: { isPending: false, mutateAsync },
  }),
}));

import { CaptureSettings } from "./CaptureSettings";

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("CaptureSettings", () => {
  afterEach(() => {
    mutateAsync.mockClear();
    Toast.destroyAll();
  });

  it("renders capture, retention and privacy controls", () => {
    renderWithQueryClient(<CaptureSettings />);
    expect(screen.getByRole("switch", { name: "记录请求 Body" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "记录响应 Body" })).toBeChecked();
    expect(screen.getByText("Body 保留时长")).toBeInTheDocument();
    expect(screen.getByText("Body 存储上限")).toBeInTheDocument();
    expect(screen.getByText("自动脱敏敏感 Header")).toBeInTheDocument();
    expect(screen.getByText("推荐开启")).toBeInTheDocument();
  });

  it("persists capture toggles through the settings mutation", async () => {
    renderWithQueryClient(<CaptureSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "记录请求 Body" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ capture_req_body: false });
  });

  it("persists the redaction switch", async () => {
    renderWithQueryClient(<CaptureSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "自动脱敏敏感 Header" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ redact_sensitive_headers: true });
  });
});
