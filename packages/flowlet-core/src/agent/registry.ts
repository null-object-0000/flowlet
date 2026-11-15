// Node Host Agent descriptors, aligned with the product declarations in plugin-registry.json.
// Global config dispatch lives in adapters/index.ts, environment detection in environment.ts,
// sessions in sessions/, and request identity in proxy/identity.ts.
// New Agents must update the declaration, descriptor, implementations and contract tests.
import type { JsonRow } from "../types.ts";

export interface AgentSessionTypeDescriptor {
  id: string;
  name: string;
  clientId: string;
}

export interface AgentConfigCapabilityDescriptor {
  id: string;
  name: string;
  kind: "boolean" | "list";
  defaultEnabled: boolean;
  requiresRestart: boolean;
}

export interface AgentDescriptor {
  id: string;
  name: string;
  environmentAdapterId: string;
  globalConfigAdapterId: string;
  endpointSuffix: string;
  npmPackage: string;
  surfaces: string[];
  sessionTypes: AgentSessionTypeDescriptor[];
  configCapabilities: AgentConfigCapabilityDescriptor[];
}

/** 与 `packages/flowlet-core/src/agent/registry.ts()` 相同的顺序。 */
export const AGENTS: ReadonlyArray<AgentDescriptor> = [
  {
    id: "claude-code",
    name: "Claude Code",
    environmentAdapterId: "claude-code",
    globalConfigAdapterId: "claude-code",
    endpointSuffix: "/anthropic",
    npmPackage: "@anthropic-ai/claude-code",
    surfaces: ["cli"],
    sessionTypes: [{ id: "claude-code", name: "Claude Code", clientId: "claude-code" }],
    configCapabilities: [],
  },
  {
    id: "opencode",
    name: "OpenCode",
    environmentAdapterId: "opencode",
    globalConfigAdapterId: "opencode",
    endpointSuffix: "/v1",
    npmPackage: "opencode-ai",
    surfaces: ["cli", "desktop"],
    sessionTypes: [{ id: "opencode", name: "OpenCode", clientId: "opencode" }],
    configCapabilities: [],
  },
  {
    id: "pi",
    name: "Pi",
    environmentAdapterId: "pi",
    globalConfigAdapterId: "pi",
    endpointSuffix: "/v1",
    npmPackage: "@earendil-works/pi-coding-agent",
    surfaces: ["cli"],
    sessionTypes: [{ id: "pi", name: "Pi", clientId: "pi" }],
    configCapabilities: [
      {
        id: "session-extension",
        name: "精确会话关联",
        kind: "boolean",
        defaultEnabled: false,
        requiresRestart: true,
      },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    environmentAdapterId: "chatgpt-desktop",
    globalConfigAdapterId: "codex",
    endpointSuffix: "/v1",
    npmPackage: "@openai/codex",
    surfaces: ["cli", "desktop"],
    sessionTypes: [
      { id: "codex-desktop", name: "Codex Desktop", clientId: "codex-desktop" },
      { id: "codex-cli", name: "Codex CLI", clientId: "codex" },
    ],
    configCapabilities: [],
  },
  {
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    environmentAdapterId: "deepseek-harness",
    globalConfigAdapterId: "deepseek-harness",
    endpointSuffix: "/v1",
    npmPackage: "@deepseek-ai/dsh",
    surfaces: ["web"],
    sessionTypes: [
      { id: "deepseek-harness", name: "DeepSeek Harness", clientId: "deepseek-harness" },
    ],
    configCapabilities: [
      {
        id: "session-extension",
        name: "精确会话关联",
        kind: "boolean",
        defaultEnabled: false,
        requiresRestart: true,
      },
      {
        id: "mcp-servers",
        name: "MCP 服务器",
        kind: "list",
        defaultEnabled: false,
        requiresRestart: false,
      },
    ],
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    environmentAdapterId: "hermes",
    globalConfigAdapterId: "hermes",
    endpointSuffix: "/v1",
    npmPackage: "hermes-agent",
    surfaces: ["cli"],
    sessionTypes: [{ id: "hermes", name: "Hermes Agent", clientId: "hermes" }],
    configCapabilities: [
      {
        id: "session-extension",
        name: "精确会话关联",
        kind: "boolean",
        defaultEnabled: false,
        requiresRestart: true,
      },
    ],
  },
];

export function agentDescriptor(agentId: string): AgentDescriptor | undefined {
  return AGENTS.find((agent) => agent.id === agentId);
}

/** `list_agent_capabilities` 的返回（camelCase，与 既有 `AgentCapabilitiesReport` 一致）。 */
export function capabilitiesReport(): JsonRow {
  return {
    agents: AGENTS.map((agent) => ({
      id: agent.id,
      name: agent.name,
      surfaces: [...agent.surfaces],
      sessionTypes: agent.sessionTypes.map((session) => ({
        id: session.id,
        name: session.name,
        clientId: session.clientId,
      })),
      configCapabilities: agent.configCapabilities.map((capability) => ({
        id: capability.id,
        name: capability.name,
        kind: capability.kind,
        defaultEnabled: capability.defaultEnabled,
        requiresRestart: capability.requiresRestart,
      })),
    })),
  };
}