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
    expect(screen.getByText("配置 Flowlet 的系统启动行为")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "开机启动" })).toBeInTheDocument();
    expect(screen.getByText("本地数据修复")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始修复" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "修复时间范围" })).toHaveTextContent("全部时间");
    expect(screen.getByText("数据管理")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出数据" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入数据" })).toBeInTheDocument();
  });
});
