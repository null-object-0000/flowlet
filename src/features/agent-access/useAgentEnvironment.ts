import { useQuery } from "@tanstack/react-query";
import { detectClaudeCodeEnvironment } from "../../domains/agent/commands";
import { queryKeys } from "../../shared/query-keys";

export function useClaudeCodeEnvironment() {
  return useQuery({
    queryKey: queryKeys.agent.environment("claude-code"),
    queryFn: detectClaudeCodeEnvironment,
    staleTime: 60_000,
    retry: 1,
  });
}
