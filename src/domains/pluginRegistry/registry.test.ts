import { describe, expect, it } from "vitest";
import { AGENT_PLUGINS, AGENT_SESSION_OPTIONS, CHANNEL_PLUGIN_IDS, agentPlugin } from "./registry";

describe("plugin registry", () => {
  it("registers builtin channels in stable display order", () => {
    expect(CHANNEL_PLUGIN_IDS).toEqual([
      "openai-api", "longcat", "deepseek", "kimi", "qwen", "custom", "zhipu", "openrouter", "vibetoken",
    ]);
  });

  it("registers each agent identity and integration metadata once", () => {
    expect(AGENT_PLUGINS.map((agent) => agent.id)).toEqual(["claude-code", "opencode", "pi", "codex", "deepseek-harness", "hermes"]);
    expect(agentPlugin("claude-code").endpointSuffix).toBe("/anthropic");
    expect(agentPlugin("codex").environmentAdapterId).toBe("chatgpt-desktop");
    expect(agentPlugin("codex").globalConfigAdapterId).toBe("codex");
    expect(agentPlugin("codex").sessionAdapterId).toBe("codex");
    expect(agentPlugin("codex").identityAdapterId).toBe("codex");
    expect(agentPlugin("opencode").surfaces).toEqual(["cli", "desktop"]);
    expect(agentPlugin("deepseek-harness").surfaces).toEqual(["web"]);
    expect(agentPlugin("deepseek-harness").supportsManagedConfig).toBe(true);
    expect(agentPlugin("deepseek-harness").configCapabilities).toEqual([
      expect.objectContaining({ id: "session-extension", defaultEnabled: false, requiresRestart: true }),
      expect.objectContaining({ id: "mcp-servers", kind: "list", defaultEnabled: false, requiresRestart: false }),
    ]);
    expect(agentPlugin("pi").configCapabilities).toEqual([
      expect.objectContaining({ id: "session-extension", defaultEnabled: false, requiresRestart: true }),
    ]);
    // 聚合模型移除后，OpenCode / Claude Code / Codex 不再有模型规格或长上下文开关。
    expect(agentPlugin("opencode").configCapabilities).toEqual([]);
    expect(agentPlugin("claude-code").configCapabilities).toEqual([]);
    expect(agentPlugin("hermes").endpointSuffix).toBe("/v1");
    expect(agentPlugin("hermes").surfaces).toEqual(["cli"]);
    expect(agentPlugin("hermes").configCapabilities).toEqual([
      expect.objectContaining({ id: "session-extension", defaultEnabled: false, requiresRestart: true }),
    ]);
    expect(agentPlugin("hermes").supportsManagedConfig).toBe(true);
    expect(AGENT_SESSION_OPTIONS.map((session) => session.id)).toEqual([
      "claude-code", "opencode", "pi", "codex-desktop", "codex-cli", "deepseek-harness", "hermes",
    ]);
    expect(AGENT_SESSION_OPTIONS.find((session) => session.id === "codex-cli")?.clientId).toBe("codex");
  });
});
