import { describe, expect, it } from "vitest";
import { AGENT_PLUGINS, AGENT_SESSION_OPTIONS, AGENT_TASK_PROFILE_OPTIONS, CHANNEL_PLUGIN_IDS, agentPlugin, agentTaskSessionType } from "./registry";

describe("plugin registry", () => {
  it("registers builtin channels in stable display order", () => {
    expect(CHANNEL_PLUGIN_IDS).toEqual([
      "longcat", "deepseek", "kimi", "qwen", "custom", "zhipu", "openrouter",
    ]);
  });

  it("registers each agent identity and integration metadata once", () => {
    expect(AGENT_PLUGINS.map((agent) => agent.id)).toEqual(["claude-code", "opencode", "pi", "codex", "deepseek-harness"]);
    expect(agentPlugin("claude-code").endpointSuffix).toBe("/anthropic");
    expect(agentPlugin("codex").environmentAdapterId).toBe("chatgpt-desktop");
    expect(agentPlugin("codex").globalConfigAdapterId).toBe("codex");
    expect(agentPlugin("codex").sessionAdapterId).toBe("codex");
    expect(agentPlugin("codex").identityAdapterId).toBe("codex");
    expect(agentPlugin("codex").runnerAdapterId).toBe("codex");
    expect(agentPlugin("opencode").surfaces).toEqual(["cli", "desktop"]);
    expect(agentPlugin("deepseek-harness").surfaces).toEqual(["web"]);
    expect(agentPlugin("deepseek-harness").supportsManagedConfig).toBe(true);
    expect(agentPlugin("deepseek-harness").configCapabilities).toEqual([
      expect.objectContaining({ id: "session-extension", defaultEnabled: false, requiresRestart: true }),
      expect.objectContaining({ id: "model-specs", defaultEnabled: false, requiresRestart: false }),
    ]);
    expect(agentPlugin("pi").configCapabilities).toEqual([
      expect.objectContaining({ id: "session-extension", defaultEnabled: false, requiresRestart: true }),
    ]);
    expect(AGENT_SESSION_OPTIONS.map((session) => session.id)).toEqual([
      "claude-code", "opencode", "pi", "codex-desktop", "codex-cli", "deepseek-harness",
    ]);
    expect(AGENT_SESSION_OPTIONS.find((session) => session.id === "codex-cli")?.clientId).toBe("codex");
    expect(AGENT_TASK_PROFILE_OPTIONS.map((profile) => profile.value)).toEqual([
      "Claude Code", "OpenCode", "Pi", "Codex", "DeepSeek Harness",
    ]);
    expect(agentTaskSessionType("DeepSeek Harness")).toBe("deepseek-harness");
  });
});
