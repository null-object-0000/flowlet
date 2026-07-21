export type AgentInstallMethod =
  | "native"
  | "winget"
  | "npm"
  | "bun"
  | "legacy_npm"
  | "homebrew"
  | "system_package"
  | "desktop"
  | "unknown";

export type AgentSurface = "cli" | "desktop";

export type AgentInstallation = {
  surface?: AgentSurface;
  executable_path: string;
  install_dir: string;
  install_method: AgentInstallMethod;
  version?: string | null;
  version_output?: string | null;
  available_on_path: boolean;
  error?: string | null;
};

export type AgentEnvironmentReport = {
  agent_id: string;
  agent_name: string;
  installed: boolean;
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
  is_current: boolean;
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
  current_account_id?: string | null;
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
  /** Claude Code 主模型是否已写入 `[1m]` 长上下文后缀；其他 Agent 恒为 false。 */
  long_context?: boolean;
  backup_available: boolean;
  external_environment_overrides: string[];
  error?: string | null;
  /** 仅 Pi：Flowlet 会话扩展（`~/.pi/agent/extensions/flowlet.ts`）是否在位。 */
  session_extension?: boolean;
};

/** 一键写入 Agent 全局配置的可选参数；某 Agent 不支持的选项会被忽略。 */
export type AgentGlobalConfigOptions = {
  /** 仅 Claude Code：主模型环境变量附加 `[1m]` 后缀，启用百万级上下文窗口预算。 */
  longContext?: boolean;
  /** 仅 Pi：是否安装会话扩展（`~/.pi/agent/extensions/flowlet.ts`）。安装后可按会话归并请求。 */
  sessionExtension?: boolean;
};
