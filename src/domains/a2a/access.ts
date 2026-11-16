import type { A2aAgent } from "./types";

export function agentGatewayUrl(agent: A2aAgent, origin: string): string {
  return agent.gatewayUrl ?? new URL(agent.gatewayPath, origin).href;
}
export function agentAccessConfig(
  agent: A2aAgent,
  origin: string,
  clientToken = "<Flowlet Client Token>",
) {
  // Encode separators so two distinct Agent IDs never share a credential prefix.
  const profile =
    "AGENT_" +
    agent.id
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        (char) => "_" + char.charCodeAt(0).toString(16).toUpperCase(),
      );
  const prefix = "FLOWLET_A2A_" + profile;
  // CLI prefixes are capped at 64 characters. Long IDs use the common prefix in
  // per-provider environment, isolated by each launched bridge process.
  const effectivePrefix = prefix.length <= 64 ? prefix : "FLOWLET_A2A";
  const args = ["acp", "--prefix=" + effectivePrefix, "--ignore-client-mcp"];
  const url = agentGatewayUrl(agent, origin);
  const env = {
    [effectivePrefix + "_URL"]: url,
    [effectivePrefix + "_TOKEN"]: clientToken,
  };
  return {
    url,
    cardUrl: url + "/.well-known/agent-card.json",
    command: "flowlet",
    args,
    env,
    paseo: {
      agents: {
        providers: {
          ["flowlet-" +
          agent.id.replace(
            /[-_]/g,
            (char) => "-" + char.charCodeAt(0).toString(16) + "-",
          )]: {
            extends: "acp",
            label: agent.name,
            command: ["flowlet", ...args],
            env,
            options: {
              supportsMcpServers: false,
              clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
              },
            },
          },
        },
      },
    },
  };
}
