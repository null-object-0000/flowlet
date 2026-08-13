export type AgentSessionType = "opencode" | "claude-code" | "codex-desktop" | "codex-cli" | "pi";
export type AgentSessionRuntimeStatus = "idle" | "running" | "waiting_user" | "unknown";

export type AgentSessionFilter = {
  page: number;
  pageSize: number;
  search: string;
  agentType: "" | AgentSessionType;
  runtimeStatus: "" | AgentSessionRuntimeStatus;
  projectPath?: string;
};

export type AgentSessionRow = {
  agentType: AgentSessionType;
  sessionId: string;
  runtimeStatus: AgentSessionRuntimeStatus;
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
  estimatedInputUncachedCost: number;
  estimatedInputCachedCost: number;
  estimatedInputCacheWriteCost: number;
  estimatedOutputCost: number;
  nativeSummary?: AgentSessionNativeSummary | null;
  nativeSyncedAt?: string | null;
};

export type AgentSessionClient = { id: string; name: string };

/** 单个 Agent 会话的 Flowlet 观测用量与预估费用（人民币，来自 `usage_records` 聚合）。
 *  任务看板进行中 / 待审核卡片据此展示「1.8k tokens ≈¥0.03」。 */
export type AgentSessionFlowletUsage = { totalTokens: number; estimatedCost: number };

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
  runtimeStatus: "",
  projectPath: "",
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
};

export type AgentSessionInteractionEventKind =
  | "turn"
  | "user-message"
  | "assistant-message"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "error";

export type AgentSessionInteractionEvent = {
  id: string;
  kind: AgentSessionInteractionEventKind;
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

export type AgentSessionLastInteraction = {
  sourceAvailable: boolean;
  truncated: false;
  turnCount: number;
  usage: AgentSessionNativeUsage | null;
  models: string[];
  events: AgentSessionInteractionEvent[];
};

/** Agent 原生会话完整时间线（全部交互轮次），供任务抽屉「会话」Tab 展示完整对话。 */
export type AgentSessionTimeline = {
  sourceAvailable: boolean;
  truncated: boolean;
  turnCount: number;
  usage: AgentSessionNativeUsage | null;
  models: string[];
  events: AgentSessionInteractionEvent[];
};

export type AgentSessionCostEstimate = {
  amount: number | null;
  inputUncachedAmount?: number | null;
  inputCachedAmount?: number | null;
  inputCacheWriteAmount?: number | null;
  outputAmount?: number | null;
  currency: string | null;
  sourceUrl: string | null;
  priceVersion: string | null;
  pricedTurnCount: number;
  unpricedTurnCount: number;
};

export type AgentSessionNativeSummary = {
  sourceAvailable: boolean;
  truncated: boolean;
  turnCount: number;
  usage: AgentSessionNativeUsage | null;
  models: string[];
};

export type OpenCodePermissionRequest = {
  id: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  metadata: unknown;
  always: string[];
  tool: { messageId: string; callId: string } | null;
};

export type OpenCodePermissionReport = {
  available: boolean;
  serverUrl: string;
  permissions: OpenCodePermissionRequest[];
  error: string | null;
};

export type OpenCodePermissionDecision = "allow_once" | "reject";
