import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AgentSessionFilter, AgentSessionsPage } from "./types";

export const agentSessionCommands = {
  list: (filter: AgentSessionFilter): Promise<AgentSessionsPage> =>
    invokeCommand<AgentSessionsPage>("list_agent_sessions", {
      filter: {
        page: filter.page,
        page_size: filter.pageSize,
        search: filter.search,
      },
    }).catch((error: unknown) => {
      throw toAppError(error, "agent_session_list_failed");
    }),
};
