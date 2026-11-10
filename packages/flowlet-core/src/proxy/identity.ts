// Agent client / session identity extraction (proxy stage).
//
// 权威实现：`src-tauri/src/core/agent_identity_adapter*/adapters/*.rs` 与
// `agent_session_identity.rs`。代理只做识别并落日志；转发上游前由 http.ts
// 的 applyRequestHeaders 剥离 `x-flowlet-client` / `x-flowlet-session`，
// `x-deepseek-harness-session-id` 必须原样透传。
import { existsSync, readFileSync } from "node:fs";
import { getAllHeader, getHeader, type HeaderMapLike } from "./http.ts";
import { isRecord, asArray, str, type JsonRow } from "./util.ts";

export const AGENT_CLIENT_HEADER = "x-flowlet-client";
export const AGENT_SESSION_HEADER = "x-flowlet-session";
export const DSH_NATIVE_SESSION_HEADER = "x-deepseek-harness-session-id";

const MAX_AGENT_SESSION_ID_BYTES = 512;

export interface AgentSessionIdentity {
  agent_type: string;
  session_id: string;
  parent_session_id: string | null;
}

export interface UaClientRule {
  id: string;
  pattern: string;
  name: string;
  enabled: boolean;
}

/** `agent_plugin_bundle::identity_adapters()` 的 UA 规则与展示名（编译期常量）。 */
export const BUILTIN_UA_RULES: UaClientRule[] = [
  { id: "claude-code", pattern: "claude-cli/", name: "Claude Code", enabled: true },
  { id: "codex", pattern: "codex_cli_rs/", name: "Codex", enabled: true },
  { id: "codex-desktop", pattern: "Codex Desktop/", name: "Codex Desktop", enabled: true },
  { id: "deepseek-harness", pattern: "deepseek-harness/", name: "DeepSeek Harness", enabled: true },
  { id: "opencode", pattern: "opencode/", name: "OpenCode", enabled: true },
];

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "codex-desktop": "Codex Desktop",
  "deepseek-harness": "DeepSeek Harness",
  opencode: "OpenCode",
  pi: "Pi",
  hermes: "Hermes Agent",
};

function validHeaderValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "[redacted]" || trimmed.length > MAX_AGENT_SESSION_ID_BYTES) {
    return undefined;
  }
  return trimmed;
}

function sessionHeader(headers: HeaderMapLike, name: string): string | undefined {
  const raw = getHeader(headers, name);
  if (name.toLowerCase() === "x-codex-turn-metadata") {
    return raw !== undefined && raw.trim() !== "" ? raw.trim() : undefined;
  }
  return validHeaderValue(raw);
}

function userAgent(headers: HeaderMapLike): string {
  return (getHeader(headers, "user-agent") ?? "").toLowerCase();
}

/** 依次尝试 Identity Adapter registry，返回第一个命中的会话身份。 */
export function extractAgentSession(headers: HeaderMapLike): AgentSessionIdentity | null {
  // claude-code
  {
    const sessionId = sessionHeader(headers, "x-claude-code-session-id");
    if (sessionId !== undefined) {
      return { agent_type: "claude-code", session_id: sessionId, parent_session_id: null };
    }
  }
  // codex-desktop（UA 门控）
  if (userAgent(headers).includes("codex desktop/")) {
    const sessionId =
      sessionHeader(headers, "session-id") ??
      sessionHeader(headers, "x-session-id") ??
      codexTurnMetadataSessionId(headers);
    if (sessionId !== undefined) {
      return { agent_type: "codex-desktop", session_id: sessionId, parent_session_id: null };
    }
  }
  // deepseek-harness（UA 门控；x-flowlet-session 优先，回退 DSH 原生头）
  if (userAgent(headers).includes("deepseek-harness/")) {
    const sessionId =
      sessionHeader(headers, AGENT_SESSION_HEADER) ??
      sessionHeader(headers, DSH_NATIVE_SESSION_HEADER);
    if (sessionId !== undefined) {
      return { agent_type: "deepseek-harness", session_id: sessionId, parent_session_id: null };
    }
  }
  // opencode（UA 或原生头门控）
  {
    const nativeSession = sessionHeader(headers, "x-opencode-session");
    if (userAgent(headers).includes("opencode/") || nativeSession !== undefined) {
      const sessionId =
        nativeSession ??
        sessionHeader(headers, "x-session-id") ??
        sessionHeader(headers, "x-session-affinity");
      if (sessionId !== undefined) {
        return {
          agent_type: "opencode",
          session_id: sessionId,
          parent_session_id: sessionHeader(headers, "x-parent-session-id") ?? null,
        };
      }
    }
  }
  // hermes（标记头门控）
  if ((getHeader(headers, AGENT_CLIENT_HEADER) ?? "").trim().toLowerCase() === "hermes") {
    const sessionId = sessionHeader(headers, AGENT_SESSION_HEADER);
    if (sessionId !== undefined) {
      return { agent_type: "hermes", session_id: sessionId, parent_session_id: null };
    }
  }
  // pi（标记头门控）
  if ((getHeader(headers, AGENT_CLIENT_HEADER) ?? "").trim().toLowerCase() === "pi") {
    const sessionId = sessionHeader(headers, AGENT_SESSION_HEADER);
    if (sessionId !== undefined) {
      return { agent_type: "pi", session_id: sessionId, parent_session_id: null };
    }
  }
  return null;
}

function codexTurnMetadataSessionId(headers: HeaderMapLike): string | undefined {
  const raw = getHeader(headers, "x-codex-turn-metadata");
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return undefined;
    return validHeaderValue(str(parsed.session_id));
  } catch {
    return undefined;
  }
}

/** 从 config.json 读取 UA 规则；缺失/损坏时返回内置规则（Rust `load_config_ua_rules`）。 */
export function loadUaRules(configPath: string | undefined): UaClientRule[] {
  let rules: UaClientRule[] = [];
  if (configPath !== undefined && existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      const rawRules = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed)
          ? asArray(parsed.ua_rules)
          : [];
      for (const raw of rawRules) {
        if (!isRecord(raw)) continue;
        rules.push({
          id: str(raw.id) ?? "",
          pattern: str(raw.pattern) ?? "",
          name: str(raw.name) ?? "",
          enabled: raw.enabled !== false,
        });
      }
    } catch {
      rules = [];
    }
  }
  const existing = new Set(rules.map((rule) => rule.id));
  for (const rule of BUILTIN_UA_RULES) {
    if (!existing.has(rule.id)) rules.push(rule);
  }
  return rules;
}

/** 客户端归属：`x-flowlet-client` 优先，再按 UA 子串规则（Rust `identify_client_agent`）。 */
export function identifyClientAgent(
  headers: HeaderMapLike,
  rules: UaClientRule[],
): { id: string; name: string } | null {
  const marker = (getHeader(headers, AGENT_CLIENT_HEADER) ?? "").trim();
  if (marker !== "") {
    const id = marker.toLowerCase();
    return { id, name: AGENT_DISPLAY_NAMES[id] ?? marker };
  }
  const ua = getAllHeader(headers, "user-agent").join(" ");
  if (ua === "") return null;
  for (const rule of rules) {
    if (rule.enabled && rule.pattern !== "" && ua.includes(rule.pattern)) {
      return { id: rule.id, name: rule.name };
    }
  }
  return null;
}

export function identifyClientFromHeaders(
  headers: HeaderMapLike,
  configPath: string | undefined,
): { id: string | null; name: string } {
  const identity = identifyClientAgent(headers, loadUaRules(configPath));
  if (identity === null) return { id: null, name: "未知" };
  return { id: identity.id, name: identity.name };
}

/** 历史日志 Header JSON → 小写 HeaderMap（供修复路径复用同一套识别逻辑）。 */
export function headerMapFromJson(headersJson: string): HeaderMapLike | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(headersJson) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const headers: HeaderMapLike = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
  }
  return headers;
}

export function identifyClientFromJson(
  headersJson: string,
  rules: UaClientRule[],
): { id: string; name: string } | null {
  const headers = headerMapFromJson(headersJson);
  return headers === null ? null : identifyClientAgent(headers, rules);
}

/** 兼容导出给需要直接判断的调用方。 */
export function hasFlowletMarker(headers: HeaderMapLike): boolean {
  return getHeader(headers, AGENT_CLIENT_HEADER) !== undefined;
}

export type { JsonRow };
