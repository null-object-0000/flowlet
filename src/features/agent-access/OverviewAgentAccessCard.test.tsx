import { fireEvent, render, screen, within } from "@testing-library/react";
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
        version: "1.18.2",
        version_output: "1.18.2",
        available_on_path: true,
      },
      installations: [{
        surface: "cli",
        executable_path: "C:\\Users\\test\\.opencode\\bin\\opencode.exe",
        install_dir: "C:\\Users\\test\\.opencode\\bin",
        install_method: "native",
        version: "1.18.2",
        version_output: "1.18.2",
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
  usePiEnvironment: () => ({
    data: {
      agent_id: "pi",
      agent_name: "Pi",
      installed: true,
      primary: {
        surface: "cli",
        executable_path: "C:\\Users\\test\\AppData\\Roaming\\npm\\pi.cmd",
        install_dir: "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent",
        install_method: "npm",
        version: "0.42.1",
        version_output: "0.42.1",
        available_on_path: true,
      },
      installations: [{
        surface: "cli",
        executable_path: "C:\\Users\\test\\AppData\\Roaming\\npm\\pi.cmd",
        install_dir: "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent",
        install_method: "npm",
        version: "0.42.1",
        version_output: "0.42.1",
        available_on_path: true,
      }],
    },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch,
  }),
  useChatGptDesktopEnvironment: () => ({
    data: {
      agent_id: "chatgpt-desktop",
      agent_name: "ChatGPT (Codex)",
      installed: true,
      primary: {
        surface: "cli",
        executable_path: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
        install_dir: "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex",
        install_method: "npm",
        version: "0.142.5",
        available_on_path: true,
      },
      installations: [{
        surface: "cli",
        executable_path: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
        install_dir: "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex",
        install_method: "npm",
        version: "0.142.5",
        available_on_path: true,
      }, {
        surface: "desktop",
        executable_path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
        install_dir: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0",
        install_method: "desktop",
        version: "26.707.12708.0",
        available_on_path: false,
      }],
    },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch,
  }),
  useCodexAccounts: () => ({
    data: {
      current_account_id: "account-1",
      accounts: [{
        account_id: "account-1",
        signed_in: true,
        is_current: true,
        auth_mode: "chatgpt",
        email: "user@example.com",
        plan_type: "plus",
        primary: { used_percent: 25, window_duration_mins: 300, resets_at: 1779459394 },
        secondary: { used_percent: 18, window_duration_mins: 10080, resets_at: 1779826837 },
        credits: { has_credits: true, unlimited: false, balance: "12.50" },
        rate_limit_reset_credits: {
          available_count: 2,
          credits: [{
            id: "RateLimitResetCredit_1",
            reset_type: "codexRateLimits",
            status: "available",
            granted_at: 1781654400,
            expires_at: 1784246400,
            title: "Full reset",
          }, {
            id: "RateLimitResetCredit_2",
            reset_type: "codexRateLimits",
            status: "available",
            granted_at: 1781654400,
            expires_at: 1786924800,
            title: "Weekly reset",
          }],
        },
        source: "app_server",
        updated_at: "2026-07-18T10:00:00Z",
        stale: false,
      }, {
        account_id: "account-2",
        signed_in: true,
        is_current: false,
        auth_mode: "chatgpt",
        email: "count-only@example.com",
        plan_type: "free",
        rate_limit_reset_credits: {
          available_count: 1,
          credits: null,
        },
        source: "oauth",
        updated_at: "2026-07-18T09:00:00Z",
        stale: false,
      }],
    },
    error: null,
    isFetching: false,
    refetch,
  }),
  useCodexAccountAuthorization: () => ({
    isPending: false,
    mutateAsync,
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
  usePiGlobalConfig: () => ({
    query: {
      data: {
        agent_id: "pi",
        settings_path: "C:\\Users\\test\\.pi\\agent\\models.json",
        credentials_path: "C:\\Users\\test\\.pi\\agent\\auth.json",
        settings_exists: true,
        state: "flowlet",
        base_url: "http://127.0.0.1:18640/v1",
        auth_token_configured: true,
        api_key_configured: true,
        primary_model: "flowlet-pro",
        fast_model: null,
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
  it("shows detected versions for the supported Agent surfaces", () => {
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    expect(screen.getByRole("button", { name: "配置 Claude Code" })).toBeEnabled();
    expect(screen.getByText("2.1.207")).toBeInTheDocument();
    expect(screen.queryByText("暂不支持")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "配置 Pi" })).toBeEnabled();
    expect(screen.getByText("0.42.1")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "配置 OpenCode" })).toBeEnabled();
    expect(screen.getByText("1.18.2")).toBeInTheDocument();
    expect(screen.getAllByText("已安装")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "配置 ChatGPT (Codex)" })).toBeEnabled();
    expect(screen.getByText("0.142.5")).toBeInTheDocument();
    expect(screen.getByText("26.707.12708.0")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "配置 Claude Code" }));
    expect(screen.getByRole("tab", { name: "Claude Code CLI 接入" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Claude Code Desktop 接入" })).not.toBeInTheDocument();
    expect(screen.queryByText("Anthropic-compatible")).not.toBeInTheDocument();
    expect(screen.queryByText("通过 Anthropic-compatible 协议将 Claude Code 接入 Flowlet。")).not.toBeInTheDocument();
    expect(screen.getByText("本机环境")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.local\\bin\\claude.exe")).toBeInTheDocument();
    expect(screen.getByText("原生安装")).toBeInTheDocument();
    fireEvent.click(screen.getAllByText("可执行文件")[0]);
    fireEvent.click(screen.getByText("安装目录"));
    expect(screen.getByText("C:\\Users\\test\\.local\\bin")).toBeInTheDocument();
    expect(screen.getByText("全局配置")).toBeInTheDocument();
    expect(screen.getByText("已接入 Flowlet")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.claude\\settings.json")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新写入 Flowlet 配置" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "恢复接入前配置" })).toBeEnabled();
    expect(screen.queryByText("接入参数")).not.toBeInTheDocument();
    expect(screen.queryByText("token")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看 Client Token" })).not.toBeInTheDocument();
  });

  it("switches between the supported ChatGPT Codex Desktop and CLI tabs", () => {
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    fireEvent.click(screen.getByRole("button", { name: "配置 ChatGPT (Codex)" }));
    expect(screen.getByRole("tab", { name: "ChatGPT (Codex) Desktop 接入" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("检测新版 ChatGPT Desktop 的安装版本和位置。")).not.toBeInTheDocument();
    expect(screen.getByText("ChatGPT Desktop 26.707.12708.0")).toBeInTheDocument();
    expect(screen.getByText("仅识别统一后的新版 ChatGPT Desktop")).toBeInTheDocument();
    expect(screen.getByText("C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe")).toBeInTheDocument();
    expect(screen.queryByText("全局配置")).not.toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByText("当前账号")).toBeInTheDocument();
    expect(screen.getByText("Plus")).toBeInTheDocument();
    expect(screen.getByText("5 小时用量")).toBeInTheDocument();
    expect(screen.getByText("每周用量")).toBeInTheDocument();
    expect(screen.getByText("剩余 75%")).toBeInTheDocument();
    expect(screen.getByText("重置机会")).toBeInTheDocument();
    expect(screen.getByText("可用 2 次")).toBeInTheDocument();
    expect(screen.getByText("Full reset")).toBeInTheDocument();
    expect(screen.getByText("Weekly reset")).toBeInTheDocument();
    expect(screen.getAllByText(/将于 .* 到期/)).toHaveLength(2);
    const countOnlyCard = screen.getByText("count-only@example.com").parentElement?.parentElement;
    expect(countOnlyCard).not.toBeNull();
    expect(within(countOnlyCard as HTMLElement).getByText("重置 1 次")).toBeInTheDocument();
    expect(within(countOnlyCard as HTMLElement).queryByText("重置机会")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加 / 重新授权账号" })).toBeEnabled();
    const sideSheetBody = document.querySelector<HTMLElement>(".semi-sidesheet-body");
    expect(sideSheetBody).not.toBeNull();
    if (sideSheetBody) sideSheetBody.scrollTop = 240;
    fireEvent.click(screen.getByRole("tab", { name: "ChatGPT (Codex) CLI 接入" }));
    expect(sideSheetBody?.scrollTop).toBe(0);
    expect(screen.getByRole("tab", { name: "ChatGPT (Codex) CLI 接入" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("检测 Codex CLI 的安装版本和位置。")).not.toBeInTheDocument();
    expect(screen.getByText("Codex CLI 0.142.5")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd")).toBeInTheDocument();
    expect(screen.queryByText("ChatGPT Desktop 26.707.12708.0")).not.toBeInTheDocument();
  });
  it("opens the shared OpenCode CLI and Desktop global configuration", () => {
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    fireEvent.click(screen.getByRole("button", { name: "配置 OpenCode" }));
    expect(screen.queryByText("OpenAI-compatible")).not.toBeInTheDocument();
    expect(screen.queryByText("通过 OpenAI-compatible 协议将 OpenCode 接入 Flowlet。")).not.toBeInTheDocument();
    expect(screen.getByText("OpenCode CLI 1.18.2")).toBeInTheDocument();
    expect(screen.queryByText("OpenCode Desktop 安装")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "OpenCode CLI 接入" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "OpenCode Desktop 接入" }));
    expect(screen.getByText("OpenCode Desktop 安装")).toBeInTheDocument();
    expect(screen.queryByText("OpenCode CLI 1.18.2")).not.toBeInTheDocument();
    expect(screen.queryByText("额外安装")).not.toBeInTheDocument();
    expect(screen.getByText("OpenCode CLI 与 Desktop 共用此全局配置")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.config\\opencode\\opencode.jsonc")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.local\\share\\opencode\\auth.json")).toBeInTheDocument();
    expect(screen.getByText("flowlet/flowlet-pro")).toBeInTheDocument();
    expect(screen.getByText("flowlet/flowlet-flash")).toBeInTheDocument();
    expect(screen.queryByText("接入参数")).not.toBeInTheDocument();
  });

  it("opens the Pi CLI global configuration backed by models.json and auth.json", () => {
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    fireEvent.click(screen.getByRole("button", { name: "配置 Pi" }));
    expect(screen.getByRole("tab", { name: "Pi CLI 接入" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Pi Desktop 接入" })).not.toBeInTheDocument();
    expect(screen.getByText("Pi CLI 0.42.1")).toBeInTheDocument();
    expect(screen.getByText("npm 全局安装")).toBeInTheDocument();
    expect(screen.getByText("Pi 的 Provider 定义在 models.json，凭据在 auth.json，默认模型在 settings.json")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.pi\\agent\\models.json")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.pi\\agent\\auth.json")).toBeInTheDocument();
    expect(screen.getByText("已接入 Flowlet")).toBeInTheDocument();
    expect(screen.getAllByText("flowlet-pro").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "重新写入 Flowlet 配置" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "恢复接入前配置" })).toBeEnabled();
    expect(screen.getByText("models.json Provider 片段")).toBeInTheDocument();
    expect(screen.getByText("settings.json 默认模型片段")).toBeInTheDocument();
  });
});
