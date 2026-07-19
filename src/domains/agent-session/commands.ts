import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AgentSessionClient, AgentSessionFilter, AgentSessionNativeSummary, AgentSessionRow, AgentSessionTimeline, AgentSessionsPage } from "./types";

export const agentSessionCommands = {
  list: (filter: AgentSessionFilter): Promise<AgentSessionsPage> =>
    invokeCommand<AgentSessionsPage>("list_agent_sessions", {
      filter: {
        page: filter.page,
        page_size: filter.pageSize,
        search: filter.search,
        agent_type: filter.agentType,
        flowlet_status: filter.flowletStatus,
      },
    }).catch((error: unknown) => {
      throw toAppError(error, "agent_session_list_failed");
    }),
  children: (agentType: AgentSessionRow["agentType"], parentSessionId: string): Promise<AgentSessionRow[]> =>
    invokeCommand<AgentSessionRow[]>("list_agent_session_children", { agentType, parentSessionId }).catch((error: unknown) => {
      throw toAppError(error, "agent_session_children_failed");
    }),
  timeline: (agentType: AgentSessionRow["agentType"], sessionId: string): Promise<AgentSessionTimeline> =>
    invokeCommand<AgentSessionTimeline>("get_agent_session_timeline", { agentType, sessionId }).catch((error: unknown) => {
      throw toAppError(error, "agent_session_timeline_failed");
    }),
  nativeSummary: (agentType: AgentSessionRow["agentType"], sessionId: string): Promise<AgentSessionNativeSummary> =>
    invokeCommand<AgentSessionNativeSummary>("get_agent_session_native_summary", { agentType, sessionId }).catch((error: unknown) => {
      throw toAppError(error, "agent_session_native_summary_failed");
    }),
  clients: (): Promise<AgentSessionClient[]> =>
    invokeCommand<AgentSessionClient[]>("list_agent_session_clients").catch((error: unknown) => {
      throw toAppError(error, "agent_session_clients_failed");
    }),
};
