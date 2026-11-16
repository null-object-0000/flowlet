import { describe, expect, it } from "vitest";
import { agentAccessConfig } from "./access";
import type { A2aAgent } from "./types";

const agent = (id: string) =>
  ({ id, name: "测试 Agent", gatewayPath: `/a2a/${id}` }) as A2aAgent;
describe("Agent client access configuration", () => {
  it("uses remote gateway URLs and isolated paired credentials", () => {
    const config = agentAccessConfig(
      {
        ...agent("bai-xiao_sheng"),
        gatewayUrl: "https://remote.example/a2a/bai-xiao_sheng",
      },
      "http://localhost:1234",
    );
    expect(config.url).toBe("https://remote.example/a2a/bai-xiao_sheng");
    expect(config.args[0]).toBe("acp");
    const prefix = config.args[1].slice("--prefix=".length);
    expect(config.env[prefix + "_URL"]).toBe(config.url);
    expect(config.env[prefix + "_TOKEN"]).toContain("调用密钥");
    const provider = Object.values(config.paseo.agents.providers)[0];
    expect(provider.options.supportsMcpServers).toBe(false);
    expect(provider.options.clientCapabilities.terminal).toBe(false);
  });
  it("bounds CLI prefixes and avoids provider ID collisions", () => {
    const long = agentAccessConfig(
      agent("a".repeat(64)),
      "https://host.example",
    );
    expect(long.args[1]).toBe("--prefix=FLOWLET_A2A");
    const ids = ["a_b", "a-5f-b", "a-b", "a-2d-b"].map(
      (id) =>
        Object.keys(
          agentAccessConfig(agent(id), "https://host.example").paseo.agents
            .providers,
        )[0],
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});
