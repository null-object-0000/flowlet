import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn().mockResolvedValue(null),
  open: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../features/settings/useAutostartSetting", () => ({
  useAutostartSetting: () => ({
    query: { data: false, isLoading: false, isError: false, refetch: vi.fn() },
    mutation: { isPending: false, mutateAsync: vi.fn().mockResolvedValue(true) },
  }),
}));

vi.mock("../../features/settings/useLogCaptureSetting", () => ({
  useLogCaptureSetting: () => ({
    query: {
      data: {
        capture_req_body: true,
        capture_res_body: true,
        body_retention_days: 3,
        body_max_size_mb: 512,
        redact_sensitive_headers: false,
      },
      isLoading: false,
    },
    mutation: { isPending: false, mutateAsync: vi.fn().mockResolvedValue(undefined) },
  }),
}));

vi.mock("../../features/settings/useDataRepair", () => ({
  useDataRepair: () => ({
    state: { status: "idle", currentStage: null, completedStages: [], percent: 0, results: {}, error: null },
    run: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  }),
}));

vi.mock("../../features/settings/useStorageUsage", () => ({
  useStorageUsage: () => ({
    data: {
      totalBytes: 1_572_864,
      databaseBytes: 1_500_000,
      reclaimableBytes: 1_100_000,
      autoVacuumMode: 2,
      walBytes: 72_000,
      sharedMemoryBytes: 0,
      configBytes: 864,
      captureBytes: 0,
      categorizedBytes: 800_000,
      categories: [
        { key: "configuration", rowCount: 12, allocatedBytes: 8_192 },
        { key: "requestLogs", rowCount: 240, allocatedBytes: 524_288 },
        { key: "usage", rowCount: 160, allocatedBytes: 196_608 },
        { key: "agentSessions", rowCount: 18, allocatedBytes: 65_536 },
        { key: "backgroundTasks", rowCount: 6, allocatedBytes: 5_376 },
      ],
    },
    isLoading: false,
    isError: false,
    isCounting: false,
    progress: {
      totalBytes: 0,
      databaseBytes: 0,
      reclaimableBytes: 0,
      autoVacuumMode: 0,
      walBytes: 0,
      sharedMemoryBytes: 0,
      configBytes: 0,
      captureBytes: 0,
      categorizedBytes: 0,
      categories: [],
    },
    refetch: vi.fn(),
  }),
}));

vi.mock("../../features/settings/useStorageMaintenance", () => ({
  useStorageMaintenance: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));

vi.mock("../../features/settings/useAppMeta", () => ({
  useAppMeta: () => ({
    data: { version: "0.1.0", dataDir: "/tmp/flowlet", diagnostics: { os: "windows", database: "healthy", proxy: "running" } },
    isLoading: false,
  }),
}));

import { SettingsPage } from "./SettingsPage";

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("SettingsPage", () => {
  it("renders the settings layout with search", () => {
    renderWithQueryClient(<SettingsPage />);
    expect(screen.getByRole("heading", { name: "应用设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "通用" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByPlaceholderText("搜索设置")).toBeInTheDocument();
  });

  it("shows general tab content by default", () => {
    renderWithQueryClient(<SettingsPage />);
    expect(screen.getByText("显示语言")).toBeInTheDocument();
    expect(screen.getByText("界面主题")).toBeInTheDocument();
  });

  it("switches content when a different tab is selected", async () => {
    renderWithQueryClient(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "数据捕获" }));
    expect(await screen.findByText("记录请求 Body")).toBeInTheDocument();
    expect(screen.getByText("推荐开启")).toBeInTheDocument();
  });

  it("filters settings by search keyword", async () => {
    renderWithQueryClient(<SettingsPage />);
    const search = screen.getByPlaceholderText("搜索设置") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "主题" } });
    await screen.findByText("界面主题");
    expect(screen.getByText("界面主题")).toBeVisible();
    expect(screen.getByText("登录后自动启动 Flowlet")).not.toBeVisible();
  });
});
