import { render, screen } from "@testing-library/react";
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

vi.mock("../../features/settings/useDataImportExport", () => ({
  useDataExport: () => ({
    isPending: false,
    mutateAsync: vi.fn().mockRejectedValue(new Error("CANCELLED")),
  }),
  useDataImport: () => ({
    isPending: false,
    mutateAsync: vi.fn().mockRejectedValue(new Error("CANCELLED")),
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

import { SettingsPage } from "./SettingsPage";

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("SettingsPage", () => {
  it("uses the reference layout sections without changing preference behavior", () => {
    renderWithQueryClient(<SettingsPage />);
    expect(screen.getByRole("heading", { name: "应用设置" })).toBeInTheDocument();
    expect(screen.getByText("显示语言")).toBeInTheDocument();
    expect(screen.getByText("界面外观")).toBeInTheDocument();
    expect(screen.getByText("系统启动")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "显示语言" })).toHaveTextContent("简体中文");
    expect(screen.getByRole("combobox", { name: "界面外观" })).toHaveTextContent("跟随系统");
    expect(screen.getByRole("switch", { name: "开机启动" })).toBeInTheDocument();
    expect(screen.queryByText("本地数据修复")).not.toBeInTheDocument();
    expect(screen.getByText("根据已捕获的请求与响应，补全会话归因、Token 用量和预估费用。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始修复" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "修复时间范围" })).toHaveTextContent("全部时间");
    expect(screen.getByText("数据管理")).toBeInTheDocument();
    expect(screen.getByText("存储占用")).toBeInTheDocument();
    expect(screen.getByText("1.5 MB")).toBeInTheDocument();
    expect(screen.getByText("配置与账号")).toBeInTheDocument();
    expect(screen.getByText("Agent 会话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "优化存储" })).toBeEnabled();
    expect(screen.getByText("导入备份会覆盖现有数据，并自动重启代理。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出数据" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入数据" })).toBeInTheDocument();
  });
});
