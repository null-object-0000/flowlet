import { registeredAgentSessionLabel } from "../pluginRegistry";

export type AgentSessionType = "opencode" | "claude-code" | "codex-desktop" | "codex-cli" | "pi" | "deepseek-harness" | "hermes";
export type AgentSessionRuntimeStatus = "idle" | "running" | "waiting_user" | "unknown";

/** 未登记的新类型显示原始 id，禁止静默回退成另一个 Agent。 */
export function agentSessionLabel(agentType: AgentSessionType | string) {
  return registeredAgentSessionLabel(agentType) ?? agentType;
}

/** 把 Hermes `sessions.source`（cli/feishu/cron 等）映射为可读标签；未知来源原样展示。 */
export function hermesSourceLabel(source: string | null | undefined, t: TranslateFn): string | undefined {
  if (!source) return undefined;
  switch (source) {
    case "cli": return t("CLI");
    case "feishu": return t("飞书");
    case "cron": return t("定时任务");
    default: return source;
  }
}

/** Hermes 会话的入口来源描述：`入口来源 · Profile`（如 `飞书 · myvault`）。
 *  仅 Hermes Agent 的会话返回；其余 Agent / 无来源时返回 undefined。 */
export function hermesSessionOrigin(row: Pick<AgentSessionRow, "agentType" | "nativeSource" | "nativeProfile">, t: TranslateFn): string | undefined {
  if (row.agentType !== "hermes") return undefined;
  const parts: string[] = [];
  const source = hermesSourceLabel(row.nativeSource, t);
  if (source) parts.push(source);
  if (row.nativeProfile) parts.push(row.nativeProfile === "default" ? t("默认 Profile") : row.nativeProfile);
  return parts.length ? parts.join(" · ") : undefined;
}

type TranslateFn = (source: string, values?: Record<string, string | number>) => string;

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
  /** 仅 Hermes Agent：原生会话的入口来源（cli / feishu / cron 等）。 */
  nativeSource?: string | null;
  /** 仅 Hermes Agent：原生会话所属命名 Profile（default / myvault / workvault 等）。 */
  nativeProfile?: string | null;
  /** 有经过 Flowlet 的请求记录，但请求未携带会话标识、无法按会话关联（如 Hermes
   *  未启用会话桥时）。为 true 时 UI 展示「经过 Flowlet（未关联会话）」。 */
  hasFlowletRequests?: boolean;
  /** 远端设备会话：来自设备同步快照（`list_shared_device_sessions`），
   *  本地没有原生会话文件与 Flowlet 请求日志，只能展示快照内的轻量数据。 */
  remoteDeviceId?: string;
  remoteDeviceName?: string;
  /** 远端设备快照携带的最近一次交互事件（`SharedAgentSession.lastInteraction`），
   *  映射为本地图表可渲染的交互事件，供会话详情「对话 / 轨迹」Tab 展示。 */
  remoteEvents?: AgentSessionInteractionEvent[];
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
  | "request"
  | "context"
  | "compacted"
  | "model-retry"
  | "approval"
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
  trace?: AgentSessionTrace | null;
};

/** Stable, normalized trace coordinates. DSH v0 supplies the complete set;
 * other Agent adapters can progressively opt in without leaking raw logs. */
export type AgentSessionTrace = {
  sequence: number;
  eventType: string;
  turn: number | null;
  step: number | null;
  callId: string | null;
  parentCallId: string | null;
  provider: string | null;
  requestReason: string | null;
  input: string | null;
  output: string | null;
  systemPrompt: string | null;
  tools: string | null;
  /** 消息来源分类原始值（user / plugin / model / tool / agent-instructions 等）。 */
  sourceKind?: string | null;
  /** ContextForm：instructions / catalog / snapshot / notice / relay / recall。 */
  sourceForm?: string | null;
  /** 生产者名：instructions → 文件路径列表；plugin → 插件名。 */
  producer?: string | null;
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

export type DshApprovalRequest = {
  approvalId: string;
  sessionId: string;
  toolName: string;
  callId: string | null;
  reason: string | null;
  requestedAt: number;
  heartbeatAt: number;
  bridgeVersion: number;
};

export type DshApprovalReport = {
  available: boolean;
  permissions: DshApprovalRequest[];
  error: string | null;
};

export type DshApprovalDecision = "allow_once" | "reject";
