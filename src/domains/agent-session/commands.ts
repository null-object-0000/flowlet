import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AgentSessionClient, AgentSessionFilter, AgentSessionFlowletUsage, AgentSessionLastInteraction, AgentSessionNativeSummary, AgentSessionRow, AgentSessionsPage, AgentSessionTimeline, DshApprovalDecision, DshApprovalReport, OpenCodePermissionDecision, OpenCodePermissionReport } from "./types";

export type AgentSessionTimelineRange = {
  startedAt: string;
  endedAt: string | null;
};

export const agentSessionCommands = {
  list: (filter: AgentSessionFilter): Promise<AgentSessionsPage> =>
    invokeCommand<AgentSessionsPage>("list_agent_sessions", {
      filter: {
        page: filter.page,
        page_size: filter.pageSize,
        search: filter.search,
        agent_type: filter.agentType,
        runtime_status: filter.runtimeStatus,
        ...(filter.projectPath ? { project_path: filter.projectPath } : {}),
      },
    }).catch((error: unknown) => {
      throw toAppError(error, "agent_session_list_failed");
    }),
  children: (agentType: AgentSessionRow["agentType"], parentSessionId: string): Promise<AgentSessionRow[]> =>
    invokeCommand<AgentSessionRow[]>("list_agent_session_children", { agentType, parentSessionId }).catch((error: unknown) => {
      throw toAppError(error, "agent_session_children_failed");
    }),
  nativeSummary: (agentType: AgentSessionRow["agentType"], sessionId: string): Promise<AgentSessionNativeSummary> =>
    invokeCommand<AgentSessionNativeSummary>("get_agent_session_native_summary", { agentType, sessionId }).catch((error: unknown) => {
      throw toAppError(error, "agent_session_native_summary_failed");
    }),
  lastInteraction: (agentType: AgentSessionRow["agentType"], sessionId: string): Promise<AgentSessionLastInteraction | null> =>
    invokeCommand<AgentSessionLastInteraction | null>("get_agent_session_last_interaction", { agentType, sessionId }).catch((error: unknown) => {
      throw toAppError(error, "agent_session_last_interaction_failed");
    }),
  timeline: (agentType: AgentSessionRow["agentType"], sessionId: string, range?: AgentSessionTimelineRange): Promise<AgentSessionTimeline> =>
    invokeCommand<AgentSessionTimeline>("get_agent_session_timeline", {
      agentType,
      sessionId,
      startedAt: range?.startedAt ?? null,
      endedAt: range?.endedAt ?? null,
    }).catch((error: unknown) => {
      throw toAppError(error, "agent_session_timeline_failed");
    }),
  flowletUsage: (agentType: AgentSessionRow["agentType"], sessionId: string): Promise<AgentSessionFlowletUsage | null> =>
    invokeCommand<AgentSessionFlowletUsage | null>("get_agent_session_flowlet_usage", { agentType, sessionId }).catch((error: unknown) => {
      throw toAppError(error, "agent_session_flowlet_usage_failed");
    }),
  openCodePermissions: (sessionId: string): Promise<OpenCodePermissionReport> =>
    invokeCommand<OpenCodePermissionReport>("list_opencode_session_permissions", { sessionId }).catch((error: unknown) => {
      throw toAppError(error, "opencode_permission_list_failed");
    }),
  replyOpenCodePermission: (permissionId: string, decision: OpenCodePermissionDecision): Promise<void> =>
    invokeCommand<void>("reply_opencode_permission", { permissionId, decision }).catch((error: unknown) => {
      throw toAppError(error, "opencode_permission_reply_failed");
    }),
  dshPermissions: (sessionId: string): Promise<DshApprovalReport> =>
    invokeCommand<DshApprovalReport>("list_dsh_session_permissions", { sessionId }).catch((error: unknown) => {
      throw toAppError(error, "dsh_permission_list_failed");
    }),
  replyDshPermission: (permissionId: string, decision: DshApprovalDecision): Promise<void> =>
    invokeCommand<void>("reply_dsh_permission", { permissionId, decision }).catch((error: unknown) => {
      throw toAppError(error, "dsh_permission_reply_failed");
    }),
  clients: (): Promise<AgentSessionClient[]> =>
    invokeCommand<AgentSessionClient[]>("list_agent_session_clients").catch((error: unknown) => {
      throw toAppError(error, "agent_session_clients_failed");
    }),
};
