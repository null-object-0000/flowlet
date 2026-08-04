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
  useCodexGlobalConfig: () => ({
    query: {
      data: {
        agent_id: "codex",
        settings_path: "C:\\Users\\test\\.codex\\config.toml",
        credentials_path: "C:\\Users\\test\\.codex\\auth.json",
        settings_exists: true,
        state: "flowlet",
        base_url: "http://127.0.0.1:18640/v1",
        auth_token_configured: true,
        api_key_configured: true,
        primary_model: "flowlet-pro",
        fast_model: null,
        subagent_model: null,
        model_catalog_path: "~/.codex/model-catalog.flowlet.json",
        model_catalog_configured: true,
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
        opencode_permission_bridge: true,
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
    expect(screen.getByRole("button", { name: "配置 Codex" })).toBeEnabled();
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

  it("opens the standard Codex agent sheet with CLI and Desktop surfaces", () => {
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    fireEvent.click(screen.getByRole("button", { name: "配置 Codex" }));
    // 标准 Agent 抽屉：CLI/Desktop 双标签页，默认选中 CLI。
    expect(screen.getByRole("tab", { name: "Codex CLI 接入" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Codex CLI 0.142.5")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd")).toBeInTheDocument();
    // 一键接入 Flowlet 全局配置区。
    expect(screen.getByText("全局配置")).toBeInTheDocument();
    expect(screen.getByText("Codex CLI、ChatGPT 桌面端与 VS Code 插件共用此全局配置")).toBeInTheDocument();
    expect(screen.getByText("已接入 Flowlet")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.codex\\config.toml")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.codex\\auth.json")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新写入 Flowlet 配置" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "恢复接入前配置" })).toBeEnabled();
    // 手动配置片段：config.toml + auth.json + 模型目录。
    expect(screen.getByText("config.toml 配置片段")).toBeInTheDocument();
    expect(screen.getByText("auth.json 凭据片段")).toBeInTheDocument();
    expect(screen.getByText("模型目录片段（保存为 ~/.codex/model-catalog.flowlet.json）")).toBeInTheDocument();
    // config.toml 片段应包含 Responses 协议与模型目录配置（文本在 code 块内被拆分，用正则模糊匹配）。
    expect(screen.getByText(/wire_api\s*=\s*"responses"/, { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText(/model_catalog_json\s*=\s*"~\/.codex\/model-catalog.flowlet.json"/, { selector: "code" })).toBeInTheDocument();
    // 全局配置区展示模型目录状态。
    expect(screen.getByText("模型目录")).toBeInTheDocument();
    expect(screen.getByText("已配置")).toBeInTheDocument();

    // 切到 Desktop 标签页：探测到的是 ChatGPT 桌面应用。
    fireEvent.click(screen.getByRole("tab", { name: "Codex Desktop 接入" }));
    expect(screen.getByRole("tab", { name: "Codex Desktop 接入" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("ChatGPT Desktop 26.707.12708.0")).toBeInTheDocument();
    expect(screen.getByText("C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe")).toBeInTheDocument();
    expect(screen.queryByText("Codex CLI 0.142.5")).not.toBeInTheDocument();
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
    const permissionPluginRow = screen.getByText("权限插件").closest("div");
    expect(permissionPluginRow).not.toBeNull();
    expect(within(permissionPluginRow!).getByText("已安装")).toBeInTheDocument();
    expect(screen.queryByText("接入参数")).not.toBeInTheDocument();
  });

  it("opens the Pi CLI global configuration backed by models.json and auth.json", () => {
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    fireEvent.click(screen.getByRole("button", { name: "配置 Pi" }));
    expect(screen.getByRole("tab", { name: "Pi CLI 接入" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Pi Desktop 接入" })).not.toBeInTheDocument();
    expect(screen.queryByText("快速模型")).not.toBeInTheDocument();
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
