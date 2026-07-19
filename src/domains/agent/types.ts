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
  backup_available: boolean;
  external_environment_overrides: string[];
  error?: string | null;
};
