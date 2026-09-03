export type AgentInstallMethod =
  | "native"
  | "winget"
  | "npm"
  | "npx"
  | "bun"
  | "legacy_npm"
  | "homebrew"
  | "system_package"
  | "desktop"
  | "unknown";

export type AgentSurface = "cli" | "desktop" | "web";

export type AgentSessionCapability = {
  id: string;
  name: string;
  clientId: string;
};

export type AgentTaskCapability = {
  profile: string;
  sessionType: string;
  requiredSurface: AgentSurface;
  supportsResume: boolean;
  resumeUnsupportedMessage: string;
};

export type AgentConfigCapability = {
  id: string;
  name: string;
  /** boolean = 布尔开关；list = 受管列表（当前仅 DeepSeek Harness 的 MCP 服务器）。 */
  kind: "boolean" | "list";
  defaultEnabled: boolean;
  requiresRestart: boolean;
};

export type AgentCapability = {
  id: string;
  name: string;
  surfaces: AgentSurface[];
  sessionTypes: AgentSessionCapability[];
  task: AgentTaskCapability;
  configCapabilities: AgentConfigCapability[];
};

export type AgentCapabilitiesReport = { agents: AgentCapability[] };

export type AgentInstallation = {
  surface?: AgentSurface;
  executable_path: string;
  install_dir: string;
  install_method: AgentInstallMethod;
  version?: string | null;
  version_output?: string | null;
  available_on_path: boolean;
  /** 不经 PATH 即可由任务 Runner 直接调用的执行入口（如 npx 缓存包的 bin JS）。 */
  runner_executable?: string | null;
  error?: string | null;
};

export type AgentEnvironmentReport = {
  agent_id: string;
  agent_name: string;
  installed: boolean;
  /** 仅 Web 等需要常驻本机运行时的 Surface 返回；普通 CLI/Desktop 省略。 */
  runtime_running?: boolean | null;
  /** Web Runtime 是否由当前 Flowlet 启动并可安全停止。 */
  runtime_managed?: boolean | null;
  /** 当前安装方式对应的可读启动命令。 */
  runtime_command?: string | null;
  primary?: AgentInstallation | null;
  installations: AgentInstallation[];
};

export type CodexUsageWindow = {
  used_percent: number;
  window_duration_mins: number;
  resets_at: number;
};

export type CodexCredits = {
  has_credits: boolean;
  unlimited: boolean;
  balance?: string | null;
};

export type CodexRateLimitResetCredit = {
  id: string;
  reset_type?: string | null;
  status?: string | null;
  granted_at?: number | null;
  expires_at?: number | null;
  title?: string | null;
  description?: string | null;
};

export type CodexRateLimitResetCredits = {
  available_count: number;
  credits?: CodexRateLimitResetCredit[] | null;
};

export type CodexAccountReport = {
  account_id: string;
  signed_in: boolean;
  auth_mode?: string | null;
  email?: string | null;
  plan_type?: string | null;
  primary?: CodexUsageWindow | null;
  secondary?: CodexUsageWindow | null;
  credits?: CodexCredits | null;
  rate_limit_reset_credits?: CodexRateLimitResetCredits | null;
  rate_limit_reached_type?: string | null;
  source: "oauth" | "app_server";
  updated_at: string;
  stale: boolean;
  error?: string | null;
};

export type CodexAccountsReport = {
  accounts: CodexAccountReport[];
};

/** 删除 Codex 账号的返回结果：被删除账号的身份信息（供 Toast 展示）。 */
export type CodexAccountDeletionResult = {
  account_id: string;
  email?: string | null;
};

/** DeepSeek Harness 受管 MCP 服务器配置（与 Rust `McpServerSpec` 一致，字段 camelCase）。 */
export type McpServerSpec = {
  /** Flowlet 内部稳定 id，同时决定 DSH 插件条目 id `mcp-<id>`。 */
  id: string;
  /** DSH 工具命名空间 `[A-Za-z0-9_-]{1,32}`，公开工具名为 mcp__<serverName>__<rawName>。 */
  serverName: string;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  /** 额外环境变量；Flowlet 只写普通字符串值。 */
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
};

export type AgentGlobalConfigState =
  | "not_configured"
  | "flowlet"
  | "other_gateway"
  | "partial"
  | "invalid";

export type AgentGlobalConfigReport = {
  agent_id: string;
  settings_path: string;
  credentials_path?: string | null;
  settings_exists: boolean;
  state: AgentGlobalConfigState;
  base_url?: string | null;
  auth_token_configured: boolean;
  api_key_configured: boolean;
  primary_model?: string | null;
  fast_model?: string | null;
  subagent_model?: string | null;
  /** 仅 Codex：config.toml 中 `model_catalog_json` 的当前值。 */
  model_catalog_path?: string | null;
  /** 仅 Codex：`model_catalog_json` 指向 Flowlet 生成的模型目录且文件在位。 */
  model_catalog_configured?: boolean;
  /** 仅 Claude Code：主模型组是否已写入 `[1m]` 长上下文后缀。 */
  primary_long_context?: boolean;
  /** 仅 Claude Code：快速模型与子 Agent 模型组是否已写入 `[1m]` 后缀。 */
  fast_long_context?: boolean;
  /** @deprecated 兼容旧版；仅当两个模型组都开启 1M 时为 true。 */
  long_context?: boolean;
  backup_available: boolean;
  external_environment_overrides: string[];
  error?: string | null;
  /** Pi / DeepSeek Harness：可选的 Flowlet 会话扩展是否在位。 */
  session_extension?: boolean;
  /** 支持模型能力声明的 Agent：受管模型条目是否已声明聚合模型规格。 */
  model_specs?: boolean;
  /** 从当前受管配置解析出的 flowlet-pro / flowlet-flash 输入模态。 */
  model_input_modalities?: Record<string, string[]>;
  /** 仅 DeepSeek Harness：Flowlet 交互确认桥（approval bridge）是否在位。 */
  approval_bridge?: boolean;
  /** 仅 DeepSeek Harness：从各 base Profile 受管块回读的 MCP 服务器列表。 */
  mcp_servers?: McpServerSpec[];
  /** 仅 OpenCode：用于发现 CLI/Desktop 进程内权限事件的全局插件是否在位。 */
  opencode_permission_bridge?: boolean;
};

/** 一键写入 Agent 全局配置的可选参数；某 Agent 不支持的选项会被忽略。 */
export type AgentGlobalConfigOptions = {
  /** @deprecated 兼容旧版；未提供独立选项时同时控制两个模型组。 */
  longContext?: boolean;
  /** 仅 Claude Code：主模型环境变量附加 `[1m]` 后缀。 */
  primaryLongContext?: boolean;
  /** 仅 Claude Code：快速模型和子 Agent 模型环境变量附加 `[1m]` 后缀。 */
  fastLongContext?: boolean;
  /** Pi / DeepSeek Harness：是否安装可选会话扩展。安装后可按会话归并请求。 */
  sessionExtension?: boolean;
  /** 是否按 Agent 官方格式声明聚合模型规格与输入模态。 */
  modelSpecs?: boolean;
  /** 仅 DeepSeek Harness：是否部署受管交互确认桥（approval bridge）。 */
  approvalBridge?: boolean;
  /** 仅 DeepSeek Harness：受管 MCP 服务器列表；空数组移除全部受管 MCP 块。 */
  mcpServers?: McpServerSpec[];
  /** 仅 Hermes Agent：默认模型（`flowlet-pro` / `flowlet-flash`）。 */
  primaryModel?: string;
};

/** Agent 最新版本查询结果（来自 npm registry，仅提示用，不执行升级）。 */
export type AgentLatestVersionReport = {
  agent_id: string;
  /** npm 包名；不支持的 agent_id 为空字符串。 */
  package: string;
  /** 最新发布版本（如 2.1.221）；查询失败时为 null。 */
  latest_version: string | null;
  /** 本次检查的 Unix 时间戳（秒）。 */
  checked_at: number;
  /** 该 Agent 查询失败的原因；成功时为 null/undefined。 */
  error?: string | null;
};

export type AgentLatestVersionsReport = {
  agents: AgentLatestVersionReport[];
};
