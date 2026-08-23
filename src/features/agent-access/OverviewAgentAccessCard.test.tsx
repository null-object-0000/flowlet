import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewAgentAccessCard } from "./OverviewAgentAccessCard";

const refetch = vi.fn();
const mutateAsync = vi.fn();
const runtimeMutateAsync = vi.fn();
const agentMocks = vi.hoisted(() => ({
  codexEnvironment: null as unknown,
  deepseekRuntimeRunning: true,
}));

vi.mock("./useAgentEnvironment", () => ({
  useAgentEnvironments: vi.fn(() => new Map([
    ["claude-code", { data: { agent_id: "claude-code", agent_name: "Claude Code CLI", installed: true, primary: { surface: "cli", executable_path: "C:\\Users\\test\\.local\\bin\\claude.exe", install_dir: "C:\\Users\\test\\.local\\bin", install_method: "native", version: "2.1.207", version_output: "2.1.207 (Claude Code)", available_on_path: true }, installations: [{ surface: "cli", executable_path: "C:\\Users\\test\\.local\\bin\\claude.exe", install_dir: "C:\\Users\\test\\.local\\bin", install_method: "native", version: "2.1.207", version_output: "2.1.207 (Claude Code)", available_on_path: true }] }, error: null, isError: false, isFetching: false, isLoading: false, refetch }],
    ["opencode", { data: { agent_id: "opencode", agent_name: "OpenCode", installed: true, primary: { surface: "cli", executable_path: "C:\\Users\\test\\.opencode\\bin\\opencode.exe", install_dir: "C:\\Users\\test\\.opencode\\bin", install_method: "native", version: "1.18.2", available_on_path: true }, installations: [{ surface: "cli", executable_path: "C:\\Users\\test\\.opencode\\bin\\opencode.exe", install_dir: "C:\\Users\\test\\.opencode\\bin", install_method: "native", version: "1.18.2", available_on_path: true }, { surface: "desktop", executable_path: "C:\\Users\\test\\AppData\\Local\\Programs\\@opencode-aidesktop\\OpenCode.exe", install_dir: "C:\\Users\\test\\AppData\\Local\\Programs\\@opencode-aidesktop", install_method: "desktop", version: null, available_on_path: false }] }, error: null, isError: false, isFetching: false, isLoading: false, refetch }],
    ["pi", { data: { agent_id: "pi", agent_name: "Pi", installed: true, primary: { surface: "cli", executable_path: "C:\\Users\\test\\AppData\\Roaming\\npm\\pi.cmd", install_dir: "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent", install_method: "npm", version: "0.42.1", available_on_path: true }, installations: [{ surface: "cli", executable_path: "C:\\Users\\test\\AppData\\Roaming\\npm\\pi.cmd", install_dir: "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent", install_method: "npm", version: "0.42.1", available_on_path: true }] }, error: null, isError: false, isFetching: false, isLoading: false, refetch }],
    ["codex", { data: agentMocks.codexEnvironment ?? { agent_id: "chatgpt-desktop", agent_name: "ChatGPT (Codex)", installed: true, primary: { surface: "cli", executable_path: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd", install_dir: "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex", install_method: "npm", version: "0.142.5", available_on_path: true }, installations: [{ surface: "cli", executable_path: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd", install_dir: "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex", install_method: "npm", version: "0.142.5", available_on_path: true }, { surface: "desktop", executable_path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe", install_dir: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0", install_method: "desktop", version: "26.707.12708.0", available_on_path: false }] }, error: null, isError: false, isFetching: false, isLoading: false, refetch }],
    ["deepseek-harness", { data: { agent_id: "deepseek-harness", agent_name: "DeepSeek Harness", installed: true, runtime_running: agentMocks.deepseekRuntimeRunning, runtime_managed: agentMocks.deepseekRuntimeRunning, runtime_command: "npx @deepseek-ai/dsh web --no-open", primary: { surface: "web", executable_path: "C:\\Users\\test\\AppData\\Local\\npm-cache\\_npx\\hash\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js", install_dir: "C:\\Users\\test\\AppData\\Local\\npm-cache\\_npx\\hash\\node_modules\\@deepseek-ai\\dsh", install_method: "npx", version: "0.1.0-rc.6", available_on_path: false, runner_executable: "C:\\Users\\test\\AppData\\Local\\npm-cache\\_npx\\hash\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" }, installations: [{ surface: "web", executable_path: "C:\\Users\\test\\AppData\\Local\\npm-cache\\_npx\\hash\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js", install_dir: "C:\\Users\\test\\AppData\\Local\\npm-cache\\_npx\\hash\\node_modules\\@deepseek-ai\\dsh", install_method: "npx", version: "0.1.0-rc.6", available_on_path: false, runner_executable: "C:\\Users\\test\\AppData\\Local\\npm-cache\\_npx\\hash\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" }] }, error: null, isError: false, isFetching: false, isLoading: false, refetch }],
  ])),
  useAgentGlobalConfig: (agentId: string | null) => ({
    query: { data: agentId ? { agent_id: agentId, settings_path: agentId === "claude-code" ? "C:\\Users\\test\\.claude\\settings.json" : agentId === "opencode" ? "C:\\Users\\test\\.config\\opencode\\opencode.jsonc" : agentId === "pi" ? "C:\\Users\\test\\.pi\\agent\\models.json" : agentId === "deepseek-harness" ? "C:\\Users\\test\\.dsh\\settings.yaml" : "C:\\Users\\test\\.codex\\config.toml", credentials_path: agentId === "pi" ? "C:\\Users\\test\\.pi\\agent\\auth.json" : agentId === "opencode" ? "C:\\Users\\test\\.local\\share\\opencode\\auth.json" : agentId === "codex" ? "C:\\Users\\test\\.codex\\auth.json" : agentId === "deepseek-harness" ? "C:\\Users\\test\\.dsh\\.credentials.yaml" : null, settings_exists: true, state: "flowlet", base_url: agentId === "claude-code" ? "http://127.0.0.1:18640/anthropic" : "http://127.0.0.1:18640/v1", auth_token_configured: true, api_key_configured: agentId !== "claude-code", primary_model: agentId === "opencode" ? "flowlet/flowlet-pro" : "flowlet-pro", fast_model: agentId === "claude-code" ? "flowlet-flash" : agentId === "opencode" ? "flowlet/flowlet-flash" : null, subagent_model: agentId === "claude-code" ? "flowlet-flash" : null, model_catalog_path: agentId === "codex" ? "~/.codex/model-catalog.flowlet.json" : null, model_catalog_configured: agentId === "codex", opencode_permission_bridge: agentId === "opencode", backup_available: true, external_environment_overrides: [] } : undefined, error: null, isLoading: false, refetch },
    apply: { isPending: false, mutateAsync },
    restore: { isPending: false, mutateAsync },
  }),
  useAgentRuntimeActions: () => ({
    start: { isPending: false, error: null, mutateAsync: runtimeMutateAsync },
    stop: { isPending: false, error: null, mutateAsync: runtimeMutateAsync },
  }),
  useAgentLatestVersions: () => ({
    data: {
      agents: [
        { agent_id: "claude-code", package: "@anthropic-ai/claude-code", latest_version: "2.1.221", checked_at: 0, error: null },
        { agent_id: "opencode", package: "opencode-ai", latest_version: "1.18.13", checked_at: 0, error: null },
        { agent_id: "pi", package: "@earendil-works/pi-coding-agent", latest_version: "0.83.0", checked_at: 0, error: null },
        { agent_id: "codex", package: "@openai/codex", latest_version: "0.146.0", checked_at: 0, error: null },
        { agent_id: "deepseek-harness", package: "@deepseek-ai/dsh", latest_version: "0.1.0-rc.6", checked_at: 0, error: null },
      ],
    },
    isFetching: false,
    isError: false,
    error: null,
    refetch,
  }),
}));

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

describe("OverviewAgentAccessCard", () => {
  beforeEach(() => {
    mutateAsync.mockClear();
    runtimeMutateAsync.mockClear();
    agentMocks.codexEnvironment = null;
    agentMocks.deepseekRuntimeRunning = true;
  });
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

  it("controls Claude Code 1M context independently for pro and flash models", () => {
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    fireEvent.click(screen.getByRole("button", { name: "配置 Claude Code" }));
    // 可选能力统一收纳在折叠的「高级配置」区，需先展开。
    fireEvent.click(screen.getByRole("button", { name: "高级配置（可选能力）" }));
    const primarySwitch = screen.getByRole("switch", { name: "flowlet-pro 1M 长上下文" });
    const fastSwitch = screen.getByRole("switch", { name: "flowlet-flash 1M 长上下文" });
    expect(primarySwitch).not.toBeChecked();
    expect(fastSwitch).not.toBeChecked();

    fireEvent.click(primarySwitch);
    expect(mutateAsync).toHaveBeenLastCalledWith({
      primaryLongContext: true,
      fastLongContext: false,
    });

    fireEvent.click(fastSwitch);
    expect(mutateAsync).toHaveBeenLastCalledWith({
      primaryLongContext: false,
      fastLongContext: true,
    });
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

  it("offers managed DeepSeek Harness configuration through the Web surface", () => {
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    fireEvent.click(screen.getByRole("button", { name: "配置 DeepSeek Harness" }));
    expect(screen.getByRole("tab", { name: "DeepSeek Harness Web 接入" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("npx 缓存")).toBeInTheDocument();
    expect(screen.getByText("Flowlet 直接写入 Provider、默认模型与 Client Token")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.dsh\\settings.yaml")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\test\\.dsh\\.credentials.yaml")).toBeInTheDocument();
    expect(screen.getByText("npx @deepseek-ai/dsh web --no-open")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止服务" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "停止服务" }));
    expect(runtimeMutateAsync).toHaveBeenCalledTimes(1);
    // 三项增强能力只在高级配置中展示，避免与全局配置状态重复。
    expect(screen.getByText("均未启用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "高级配置（可选能力）" }));
    const sessionSwitch = screen.getByRole("switch", { name: "精确会话关联" });
    expect(sessionSwitch).not.toBeChecked();
    fireEvent.click(sessionSwitch);
    expect(mutateAsync).toHaveBeenLastCalledWith({
      sessionExtension: true,
      modelSpecs: false,
      approvalBridge: false,
      mcpServers: [],
    });
    const specsSwitch = screen.getByRole("switch", { name: "聚合模型规格" });
    expect(specsSwitch).not.toBeChecked();
    fireEvent.click(specsSwitch);
    expect(mutateAsync).toHaveBeenLastCalledWith({
      sessionExtension: false,
      modelSpecs: true,
      approvalBridge: false,
      mcpServers: [],
    });
    expect(screen.getByRole("button", { name: "重新写入 Flowlet 配置" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "恢复接入前配置" })).toBeEnabled();
  });

  it("manages DeepSeek Harness MCP servers from the dedicated tab", () => {
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    fireEvent.click(screen.getByRole("button", { name: "配置 DeepSeek Harness" }));
    // 独立 Tab 承载 MCP 服务器管理，高级配置区不重复渲染。
    fireEvent.click(screen.getByRole("tab", { name: "MCP 服务器" }));
    expect(screen.getByText("尚未添加 MCP 服务器。从下方预设开始，或填写自定义配置。")).toBeInTheDocument();
    expect(screen.queryByText("精确会话关联")).not.toBeInTheDocument();

    // 从预设添加 Chrome DevTools（默认无头 + 隔离临时 Profile），再整块写回。
    fireEvent.click(screen.getByRole("button", { name: "Chrome DevTools" }));
    // Semi 带图标按钮的可访问名包含图标 label，用正则匹配文本部分。
    fireEvent.click(screen.getByRole("button", { name: /添加/ }));
    expect(screen.getByText("chrome")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "写回 Flowlet" }));
    expect(mutateAsync).toHaveBeenLastCalledWith({
      sessionExtension: false,
      modelSpecs: false,
      approvalBridge: false,
      mcpServers: [
        {
          id: "chrome",
          serverName: "chrome",
          transport: "stdio",
          command: "npx",
          args: ["-y", "chrome-devtools-mcp@latest", "--headless", "--isolated"],
        },
      ],
    });
  });

  it("allows managed DeepSeek Harness writes while DSH Web is stopped", () => {
    agentMocks.deepseekRuntimeRunning = false;
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    fireEvent.click(screen.getByRole("button", { name: "配置 DeepSeek Harness" }));
    expect(screen.getByRole("button", { name: "启动服务" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "启动服务" }));
    expect(runtimeMutateAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "重新写入 Flowlet 配置" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "恢复接入前配置" })).toBeEnabled();
  });

  it("shows a new-version badge on the logo and version details in the drawer", () => {
    const { container } = render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    // 已安装且存在更新版本的 Agent：Logo 上带 Badge dot，按钮带标题提示。
    const claudeButton = screen.getByRole("button", { name: "配置 Claude Code" });
    expect(claudeButton.title).toBe("检测到新版本，点击查看详情");
    expect(container.querySelector(".semi-badge-dot")).not.toBeNull();

    fireEvent.click(claudeButton);
    // 抽屉内通过更新提示条展示新旧版本号，不再单独列出已安装/最新版本模块。
    expect(screen.getByText(/检测到新版本：2.1.207 → 2.1.221/)).toBeInTheDocument();
    const updateLink = screen.getByRole("link", { name: "前往官网查看更新说明" });
    expect(updateLink).toHaveAttribute("href", "https://code.claude.com/docs/en/whats-new");
    expect(screen.queryByText("已安装版本")).not.toBeInTheDocument();
    expect(screen.queryByText("最新版本")).not.toBeInTheDocument();
  });

  it("bases the Codex update badge only on the CLI version, ignoring the desktop version", () => {
    // 桌面版本远小于 npm latest，但 ChatGPT Desktop 使用独立版本体系，不应触发更新提示。
    agentMocks.codexEnvironment = {
        agent_id: "chatgpt-desktop",
        agent_name: "ChatGPT (Codex)",
        installed: true,
        primary: {
          surface: "desktop",
          executable_path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
          install_dir: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0",
          install_method: "desktop",
          version: "0.9.0",
          available_on_path: false,
        },
        installations: [
          {
            surface: "desktop",
            executable_path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
            install_dir: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0",
            install_method: "desktop",
            version: "0.9.0",
            available_on_path: false,
          },
          {
            surface: "cli",
            executable_path: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
            install_dir: "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex",
            install_method: "npm",
            version: "0.146.0",
            available_on_path: true,
          },
        ],
    };
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    // CLI 0.146.0 与 npm latest 0.146.0 一致 → 无新版本提示（title 为空）。
    const codexButton = screen.getByRole("button", { name: "配置 Codex" });
    expect(codexButton.title).toBe("");
  });

  it("shows the official install guide on the Codex CLI tab when only ChatGPT Desktop is installed", () => {
    // 回归场景：环境整体 installed 为 true（探测到 ChatGPT Desktop），但 CLI 标签页
    // 没有任何 CLI 安装。此时必须照常展示"前往官网安装"引导，不能只显示纯文本。
    // 用 mockImplementation 而非 mockReturnValueOnce：点击打开抽屉会触发第二次渲染，
    // 组件会再次调用该 hook；一次性的 Once 只覆盖首次调用，重渲染会回落默认 mock。
    agentMocks.codexEnvironment = {
        agent_id: "chatgpt-desktop",
        agent_name: "ChatGPT (Codex)",
        installed: true,
        primary: {
          surface: "desktop",
          executable_path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
          install_dir: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0",
          install_method: "desktop",
          version: "26.707.12708.0",
          available_on_path: false,
        },
        installations: [{
          surface: "desktop",
          executable_path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
          install_dir: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0",
          install_method: "desktop",
          version: "26.707.12708.0",
          available_on_path: false,
        }],
    };
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" clientToken="token" />);

    fireEvent.click(screen.getByRole("button", { name: "配置 Codex" }));
    // 默认 CLI 标签页：无 CLI 安装 → 显示引导文案与官网安装入口。
    expect(screen.getByText("未检测到 CLI 安装。")).toBeInTheDocument();
    const installLink = screen.getByRole("link", { name: "前往官网安装" });
    expect(installLink).toHaveAttribute("href", "https://learn.chatgpt.com/docs/codex/cli");

    // Desktop 标签页：探测到了 ChatGPT Desktop，不再展示安装引导。
    fireEvent.click(screen.getByRole("tab", { name: "Codex Desktop 接入" }));
    expect(screen.getByText("ChatGPT Desktop 26.707.12708.0")).toBeInTheDocument();
    expect(screen.queryByText("前往官网安装")).not.toBeInTheDocument();
  });
});
