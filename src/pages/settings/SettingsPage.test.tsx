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

vi.mock("../../features/device-sync/useDeviceSync", () => ({
  useKnownDevices: () => ({
    data: [{
      deviceId: "8d58734f-0b71-49ea-b5a4-115b389a9ae7",
      deviceCreatedAt: "2026-07-28T00:00:00Z",
      displayName: "公司笔记本",
      platform: "windows",
      appVersion: "0.1.0",
      isCurrent: true,
      timezoneOffsetMinutes: 480,
      firstUsageDate: "2026-07-28",
      lastUsageDate: "2026-07-28",
      dayCount: 1,
      requestCount: 3,
      knownTokens: 1200,
      lastSeenAt: "2026-07-28T01:00:00Z",
    }],
    isLoading: false,
    isError: false,
  }),
  useS3SyncSettings: () => ({
    data: {
      config: null,
      status: {
        status: "never",
        lastAttemptAt: null,
        lastSuccessAt: null,
        message: "尚未同步",
        remoteDevices: 0,
        importedDevices: 0,
        importedDays: 0,
        failedObjects: 0,
      },
    },
    isError: false,
  }),
  useDeviceUsageTransfer: () => ({
    renameCurrentDevice: { isPending: false, mutateAsync: vi.fn() },
    exportBundle: { isPending: false, mutateAsync: vi.fn() },
    previewImport: { isPending: false, mutateAsync: vi.fn() },
    importBundle: { isPending: false, mutateAsync: vi.fn() },
    saveS3Config: { isPending: false, mutateAsync: vi.fn() },
    testS3Connection: { isPending: false, mutateAsync: vi.fn() },
    syncS3: { isPending: false, mutateAsync: vi.fn() },
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

  it("shows the current device in storage management", async () => {
    renderWithQueryClient(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "存储管理" }));
    expect(await screen.findByText("设备与用量共享")).toBeInTheDocument();
    expect(screen.getByText("当前设备")).toBeInTheDocument();
    expect(screen.getByText("公司笔记本")).toBeInTheDocument();
    expect(screen.getByText("8d58734f-0b71-49ea-b5a4-115b389a9ae7")).toBeInTheDocument();
  });

  it("opens the current device rename dialog", async () => {
    renderWithQueryClient(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "存储管理" }));
    fireEvent.click(await screen.findByRole("button", { name: "重命名" }));

    expect(screen.getByText("重命名当前设备")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("例如：公司笔记本")).toHaveValue("公司笔记本");
    expect(screen.getByText("设备名称用于导出和同步时区分设备，不会改变设备 ID。")).toBeInTheDocument();
  });

  it("opens the S3-compatible configuration dialog", async () => {
    renderWithQueryClient(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "存储管理" }));
    fireEvent.click(await screen.findByRole("button", { name: "配置 S3" }));

    expect(screen.getByText("配置 S3-compatible 同步")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("flowlet-sync")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试连接" })).toBeInTheDocument();
    expect(screen.getByText("Bucket：oss:HeadBucket、oss:GetBucketInfo、oss:ListObjects；对象：oss:GetObject、oss:PutObject、oss:DeleteObject")).toBeInTheDocument();
    const pathStyle = screen.getByRole("switch", { name: "使用 Path-style 地址" });
    expect(pathStyle).toBeChecked();
    fireEvent.click(pathStyle);
    expect(pathStyle).not.toBeChecked();
  });
});
