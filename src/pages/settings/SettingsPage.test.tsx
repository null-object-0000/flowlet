import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

vi.mock("../../features/settings/useAutostartSetting", () => ({
  useAutostartSetting: () => ({
    query: { data: false, isLoading: false, isError: false, refetch: vi.fn() },
    mutation: { isPending: false, mutateAsync: vi.fn().mockResolvedValue(true) },
  }),
}));

import { SettingsPage } from "./SettingsPage";

describe("SettingsPage", () => {
  it("uses the reference layout sections without changing preference behavior", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { name: "应用设置" })).toBeInTheDocument();
    expect(screen.getByText("显示语言")).toBeInTheDocument();
    expect(screen.getByText("界面外观")).toBeInTheDocument();
    expect(screen.getByText("配置 Flowlet 的系统启动行为")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "开机启动" })).toBeInTheDocument();
  });
});
