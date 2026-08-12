import { describe, expect, it } from "vitest";
import { AGENT_PLUGINS, CHANNEL_PLUGIN_IDS, agentPlugin } from "./registry";

describe("plugin registry", () => {
  it("registers builtin channels in stable display order", () => {
    expect(CHANNEL_PLUGIN_IDS).toEqual([
      "longcat", "deepseek", "kimi", "qwen", "custom", "zhipu", "openrouter",
    ]);
  });

  it("registers each agent identity and integration metadata once", () => {
    expect(AGENT_PLUGINS.map((agent) => agent.id)).toEqual(["claude-code", "opencode", "pi", "codex"]);
    expect(agentPlugin("claude-code").endpointSuffix).toBe("/anthropic");
    expect(agentPlugin("codex").environmentId).toBe("chatgpt-desktop");
    expect(agentPlugin("opencode").surfaces).toEqual(["cli", "desktop"]);
  });
});
