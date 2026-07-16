import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OverviewAgentAccessCard } from "./OverviewAgentAccessCard";

const refetch = vi.fn();

vi.mock("./useAgentEnvironment", () => ({
  useClaudeCodeEnvironment: () => ({
    data: {
      agent_id: "claude-code",
      agent_name: "Claude Code CLI",
      installed: true,
      primary: {
        executable_path: "C:\\Users\\test\\.local\\bin\\claude.exe",
        install_dir: "C:\\Users\\test\\.local\\bin",
        install_method: "native",
        version: "2.1.207",
        version_output: "2.1.207 (Claude Code)",
        available_on_path: true,
      },
      installations: [{
        executable_path: "C:\\Users\\test\\.local\\bin\\claude.exe",
        install_dir: "C:\\Users\\test\\.local\\bin",
        install_method: "native",
        version: "2.1.207",
        version_output: "2.1.207 (Claude Code)",
        available_on_path: true,
      }],
    },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch,
  }),
}));

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

describe("OverviewAgentAccessCard", () => {
  it("shows the detected Claude Code version and keeps future agents disabled", () => {
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    expect(screen.getByRole("button", { name: "配置 Claude Code CLI" })).toBeEnabled();
    expect(screen.getByText("已安装 · 2.1.207")).toBeInTheDocument();

    const futureButtons = [
      screen.getByRole("button", { name: "OpenCode CLI 即将支持" }),
      screen.getByRole("button", { name: "ChatGPT Desktop 即将支持" }),
    ];
    futureButtons.forEach((button) => expect(button).toBeDisabled());
    expect(screen.getAllByText("即将支持")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "配置 Claude Code CLI" }));
    expect(screen.getByText("本机环境")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.local\\bin\\claude.exe")).toBeInTheDocument();
    expect(screen.getByText("原生安装")).toBeInTheDocument();
  });
});
