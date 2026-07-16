export type AgentSessionFilter = {
  page: number;
  pageSize: number;
  search: string;
};

export type AgentSessionRow = {
  agentType: "opencode";
  sessionId: string;
  parentSessionId: string | null;
  startedAt: string;
  updatedAt: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  knownTokens: number;
  estimatedCost: number;
  latestModel: string | null;
};

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
};
