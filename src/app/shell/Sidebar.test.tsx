import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

describe("Sidebar", () => {
  it("keeps the existing navigation and omits the redundant proxy status module", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "概览",
      "模型服务",
      "请求日志",
      "会话管理",
      "用量成本",
      "设置",
    ]);
    expect(screen.queryByText(/服务运行中|代理服务运行中/)).not.toBeInTheDocument();
  });
});
