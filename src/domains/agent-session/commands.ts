import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AgentSessionClient, AgentSessionFilter, AgentSessionsPage } from "./types";

export const agentSessionCommands = {
  list: (filter: AgentSessionFilter): Promise<AgentSessionsPage> =>
    invokeCommand<AgentSessionsPage>("list_agent_sessions", {
      filter: {
        page: filter.page,
        page_size: filter.pageSize,
        search: filter.search,
        client_id: filter.clientId,
      },
    }).catch((error: unknown) => {
      throw toAppError(error, "agent_session_list_failed");
    }),
  clients: (): Promise<AgentSessionClient[]> =>
    invokeCommand<AgentSessionClient[]>("list_agent_session_clients").catch((error: unknown) => {
      throw toAppError(error, "agent_session_clients_failed");
    }),
};
