import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { agentSessionCommands } from "../../domains/agent-session/commands";
import type { AgentSessionFilter } from "../../domains/agent-session/types";
import { queryKeys } from "../../shared/query-keys";

export function useAgentSessions(filter: AgentSessionFilter) {
  return useQuery({
    queryKey: queryKeys.agentSession.list(filter),
    queryFn: () => agentSessionCommands.list(filter),
    placeholderData: keepPreviousData,
    refetchInterval: 5_000,
  });
}
