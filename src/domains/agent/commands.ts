import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AgentEnvironmentReport } from "./types";

export function detectAgentEnvironment(agentId: string): Promise<AgentEnvironmentReport> {
  return invokeCommand<AgentEnvironmentReport>("detect_agent_environment", { agentId }, 10_000).catch((error) => {
    throw toAppError(error, "agent_environment_detection_failed");
  });
}

export function detectClaudeCodeEnvironment(): Promise<AgentEnvironmentReport> {
  return detectAgentEnvironment("claude-code");
}
