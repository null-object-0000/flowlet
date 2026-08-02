import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { AppPreferencesProvider } from "../preferences/AppPreferences";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

describe("Sidebar", () => {
  afterEach(() => localStorage.clear());

  it("keeps the existing navigation and omits the redundant proxy status module", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "运行概览",
      "模型服务",
      "请求日志",
      "会话管理",
      "任务日志",
      "用量概览",
      "用量分析NEW",
      "应用设置",
    ]);
    expect(screen.queryByText(/服务运行中|代理服务运行中/)).not.toBeInTheDocument();
  });

  it("uses concise product labels in English", () => {
    localStorage.setItem("flowlet.language", "en-US");
    render(
      <AppPreferencesProvider>
        <MemoryRouter>
          <Sidebar />
        </MemoryRouter>
      </AppPreferencesProvider>,
    );

    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Overview",
      "Models",
      "Requests",
      "Sessions",
      "Tasks",
      "Usage Overview",
      "Usage AnalysisNEW",
      "Settings",
    ]);
  });
});
