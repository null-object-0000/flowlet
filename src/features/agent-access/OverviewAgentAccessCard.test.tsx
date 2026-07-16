import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OverviewAgentAccessCard } from "./OverviewAgentAccessCard";

const refetch = vi.fn();
const mutateAsync = vi.fn();

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
  useOpenCodeEnvironment: () => ({
    data: {
      agent_id: "opencode",
      agent_name: "OpenCode",
      installed: true,
      primary: {
        surface: "cli",
        executable_path: "C:\\Users\\test\\.opencode\\bin\\opencode.exe",
        install_dir: "C:\\Users\\test\\.opencode\\bin",
        install_method: "native",
        version: "1.17.18",
        version_output: "1.17.18",
        available_on_path: true,
      },
      installations: [{
        surface: "cli",
        executable_path: "C:\\Users\\test\\.opencode\\bin\\opencode.exe",
        install_dir: "C:\\Users\\test\\.opencode\\bin",
        install_method: "native",
        version: "1.17.18",
        version_output: "1.17.18",
        available_on_path: true,
      }, {
        surface: "desktop",
        executable_path: "C:\\Users\\test\\AppData\\Local\\Programs\\@opencode-aidesktop\\OpenCode.exe",
        install_dir: "C:\\Users\\test\\AppData\\Local\\Programs\\@opencode-aidesktop",
        install_method: "desktop",
        version: null,
        version_output: null,
        available_on_path: false,
      }],
    },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch,
  }),
  useClaudeCodeGlobalConfig: () => ({
    query: {
      data: {
        agent_id: "claude-code",
        settings_path: "C:\\Users\\test\\.claude\\settings.json",
        settings_exists: true,
        state: "flowlet",
        base_url: "http://127.0.0.1:18640/anthropic",
        auth_token_configured: true,
        api_key_configured: false,
        primary_model: "flowlet-pro",
        fast_model: "flowlet-flash",
        subagent_model: "flowlet-flash",
        backup_available: true,
        external_environment_overrides: [],
      },
      error: null,
      isLoading: false,
      refetch,
    },
    apply: { isPending: false, mutateAsync },
    restore: { isPending: false, mutateAsync },
  }),
  useOpenCodeGlobalConfig: () => ({
    query: {
      data: {
        agent_id: "opencode",
        settings_path: "C:\\Users\\test\\.config\\opencode\\opencode.jsonc",
        credentials_path: "C:\\Users\\test\\.local\\share\\opencode\\auth.json",
        settings_exists: true,
        state: "flowlet",
        base_url: "http://127.0.0.1:18640/v1",
        auth_token_configured: true,
        api_key_configured: true,
        primary_model: "flowlet/flowlet-pro",
        fast_model: "flowlet/flowlet-flash",
        backup_available: true,
        external_environment_overrides: [],
      },
      error: null,
      isLoading: false,
      refetch,
    },
    apply: { isPending: false, mutateAsync },
    restore: { isPending: false, mutateAsync },
  }),
}));

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

describe("OverviewAgentAccessCard", () => {
  it("shows the detected Claude Code version and keeps unsupported agents disabled", () => {
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    expect(screen.getByRole("button", { name: "配置 Claude Code CLI" })).toBeEnabled();
    expect(screen.getByText("已安装 · 2.1.207")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "配置 OpenCode" })).toBeEnabled();
    expect(screen.getByText("已安装 · 1.17.18")).toBeInTheDocument();
    const futureButtons = [screen.getByRole("button", { name: "ChatGPT Desktop 即将支持" })];
    futureButtons.forEach((button) => expect(button).toBeDisabled());
    expect(screen.getAllByText("即将支持")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "配置 Claude Code CLI" }));
    expect(screen.getByText("本机环境")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.local\\bin\\claude.exe")).toBeInTheDocument();
    expect(screen.getByText("原生安装")).toBeInTheDocument();
    expect(screen.getByText("全局配置")).toBeInTheDocument();
    expect(screen.getByText("已接入 Flowlet")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.claude\\settings.json")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新写入 Flowlet 配置" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "恢复接入前配置" })).toBeEnabled();
    expect(screen.queryByText("token")).not.toBeInTheDocument();
    expect(screen.getAllByText("••••••••••••••••••••").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "查看 Client Token" }));
    expect(screen.getAllByText("token").length).toBeGreaterThan(0);
  });

  it("opens the shared OpenCode CLI and Desktop global configuration", () => {
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    fireEvent.click(screen.getByRole("button", { name: "配置 OpenCode" }));
    expect(screen.getByText("OpenCode CLI 1.17.18")).toBeInTheDocument();
    expect(screen.getByText("OpenCode Desktop 安装")).toBeInTheDocument();
    expect(screen.queryByText("额外安装")).not.toBeInTheDocument();
    expect(screen.getByText("OpenCode CLI 与 Desktop 共用此全局配置")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.config\\opencode\\opencode.jsonc")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.local\\share\\opencode\\auth.json")).toBeInTheDocument();
    expect(screen.getByText("flowlet/flowlet-pro")).toBeInTheDocument();
    expect(screen.getByText("flowlet/flowlet-flash")).toBeInTheDocument();
  });
});
