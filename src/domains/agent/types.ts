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
