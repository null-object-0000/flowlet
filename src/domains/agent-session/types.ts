export type AgentSessionType = "opencode" | "claude-code" | "codex-desktop" | "codex-cli";
export type AgentSessionFlowletStatus = "" | "observed" | "native";

export type AgentSessionFilter = {
  page: number;
  pageSize: number;
  search: string;
  agentType: "" | AgentSessionType;
  flowletStatus: AgentSessionFlowletStatus;
};

export type AgentSessionRow = {
  agentType: AgentSessionType;
  sessionId: string;
  title: string | null;
  projectPath: string | null;
  parentSessionId: string | null;
  clientId: string | null;
  clientName: string | null;
  nativeStartedAt: string | null;
  nativeUpdatedAt: string | null;
  activityAt: string;
  flowletObserved: boolean;
  startedAt: string;
  updatedAt: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  knownTokens: number;
  inputTokens: number;
  inputCachedTokens: number;
  inputUncachedTokens: number;
  cacheMeasuredInputTokens: number;
  outputTokens: number;
  unknownUsageCount: number;
  estimatedCost: number;
  nativeSummary?: AgentSessionNativeSummary | null;
  nativeSyncedAt?: string | null;
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
  pageSize: 8,
  search: "",
  agentType: "",
  flowletStatus: "",
};

export type AgentSessionTimelineEventKind =
  | "turn"
  | "user-message"
  | "assistant-message"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "error";

export type AgentSessionTimelineEvent = {
  id: string;
  kind: AgentSessionTimelineEventKind;
  source: "agent-native";
  timestamp: string | null;
  title: string | null;
  content: string | null;
  model: string | null;
  status: string | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  usage: AgentSessionNativeUsage | null;
};

export type AgentSessionNativeUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number | null;
  costCurrency: string | null;
  apiEquivalent?: AgentSessionCostEstimate | null;
  planConsumption?: AgentSessionCostEstimate | null;
};

export type AgentSessionCostEstimate = {
  amount: number | null;
  currency: string | null;
  sourceUrl: string | null;
  priceVersion: string | null;
  pricedTurnCount: number;
  unpricedTurnCount: number;
};

export type AgentSessionTimeline = {
  sourceAvailable: boolean;
  truncated: boolean;
  turnCount: number;
  usage: AgentSessionNativeUsage | null;
  models: string[];
  events: AgentSessionTimelineEvent[];
};

export type AgentSessionNativeSummary = {
  sourceAvailable: boolean;
  truncated: boolean;
  turnCount: number;
  usage: AgentSessionNativeUsage | null;
  models: string[];
};
