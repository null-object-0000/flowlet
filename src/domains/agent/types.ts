export type AgentInstallMethod =
  | "native"
  | "winget"
  | "npm"
  | "legacy_npm"
  | "homebrew"
  | "system_package"
  | "unknown";

export type AgentInstallation = {
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
