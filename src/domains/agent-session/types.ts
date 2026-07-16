export type AgentSessionFilter = {
  page: number;
  pageSize: number;
  search: string;
  clientId: string;
};

export type AgentSessionRow = {
  agentType: "opencode";
  sessionId: string;
  parentSessionId: string | null;
  clientId: string | null;
  clientName: string | null;
  startedAt: string;
  updatedAt: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  knownTokens: number;
  estimatedCost: number;
};

export type AgentSessionClient = { id: string; name: string };

export type AgentSessionsPage = {
  rows: AgentSessionRow[];
  total: number;
  page: number;
  pageSize: number;
};

export const DEFAULT_AGENT_SESSION_FILTER: AgentSessionFilter = {
  page: 1,
  pageSize: 10,
  search: "",
  clientId: "",
};
