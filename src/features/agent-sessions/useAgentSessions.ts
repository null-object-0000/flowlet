import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { agentSessionCommands } from "../../domains/agent-session/commands";
import type { AgentSessionFilter, AgentSessionRow } from "../../domains/agent-session/types";
import { queryKeys } from "../../shared/query-keys";

export function useAgentSessions(filter: AgentSessionFilter) {
  return useQuery({
    queryKey: queryKeys.agentSession.list(filter),
    queryFn: () => agentSessionCommands.list(filter),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
}

export function useAgentSessionClients() {
  return useQuery({
    queryKey: queryKeys.agentSession.clients(),
    queryFn: agentSessionCommands.clients,
    staleTime: 5 * 60_000,
  });
}

export function useAgentSessionChildren(session: AgentSessionRow) {
  return useQuery({
    queryKey: queryKeys.agentSession.children(session.agentType, session.sessionId),
    queryFn: () => agentSessionCommands.children(session.agentType, session.sessionId),
    refetchInterval: 15_000,
  });
}

export function useAgentSessionTimeline(session: AgentSessionRow, enabled = true) {
  return useQuery({
    queryKey: queryKeys.agentSession.timeline(session.agentType, session.sessionId),
    queryFn: () => agentSessionCommands.timeline(session.agentType, session.sessionId),
    enabled,
    staleTime: 30_000,
  });
}

export function useAgentSessionNativeSummary(session: AgentSessionRow) {
  return useQuery({
    queryKey: queryKeys.agentSession.nativeSummary(session.agentType, session.sessionId),
    queryFn: () => agentSessionCommands.nativeSummary(session.agentType, session.sessionId),
    enabled: !session.flowletObserved && !session.nativeSummary,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    retry: 1,
  });
}
