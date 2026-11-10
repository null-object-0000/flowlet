// Agent 全局配置报告的结构与默认值。
//
// 权威实现：`src-tauri/src/core/agent_global_config.rs::AgentGlobalConfigReport`
// （snake_case；所有字段都会序列化，缺省值由各 Adapter 填充）。
import type { JsonRow } from "../types.ts";
import type { McpServerSpecInput } from "./models.ts";

export type AgentGlobalConfigState =
  | "not_configured"
  | "flowlet"
  | "other_gateway"
  | "partial"
  | "invalid";

export interface AgentGlobalConfigReport {
  agent_id: string;
  settings_path: string;
  credentials_path: string | null;
  settings_exists: boolean;
  state: AgentGlobalConfigState;
  base_url: string | null;
  auth_token_configured: boolean;
  api_key_configured: boolean;
  primary_model: string | null;
  fast_model: string | null;
  subagent_model: string | null;
  model_catalog_path: string | null;
  model_catalog_configured: boolean;
  backup_available: boolean;
  external_environment_overrides: string[];
  error: string | null;
  session_extension: boolean;
  mcp_servers: McpServerSpecInput[];
  opencode_permission_bridge: boolean;
}

export type ReportDefaults = Partial<AgentGlobalConfigReport> &
  Pick<AgentGlobalConfigReport, "agent_id" | "settings_path">;

/** 构造完整报告：未指定字段使用 Rust `Default`/None 等价值。 */
export function buildReport(defaults: ReportDefaults): AgentGlobalConfigReport {
  return {
    credentials_path: null,
    settings_exists: false,
    state: "not_configured",
    base_url: null,
    auth_token_configured: false,
    api_key_configured: false,
    primary_model: null,
    fast_model: null,
    subagent_model: null,
    model_catalog_path: null,
    model_catalog_configured: false,
    backup_available: false,
    external_environment_overrides: [],
    error: null,
    session_extension: false,
    mcp_servers: [],
    opencode_permission_bridge: false,
    ...defaults,
  };
}

/** `BackedUpValue`（Rust 备份结构中的可空字段快照）。 */
export interface BackedUpValue {
  present: boolean;
  value: unknown;
}

export function backedUpValue(value: unknown): BackedUpValue {
  return { present: value !== undefined, value: value === undefined ? null : value };
}

/** 报告的运行时 JSON 形状（与 frontend `AgentGlobalConfigReport` 对齐）。 */
export function reportToRow(report: AgentGlobalConfigReport): JsonRow {
  return { ...report } as JsonRow;
}