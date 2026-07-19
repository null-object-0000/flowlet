export interface CostLedgerSourceIdentity {
  id: string;
  sourceType: string;
  adapter: string;
  displayName: string;
}

export interface CostLedgerEvidence {
  sourceKind: string;
  locator: string;
  rawRecordId?: string;
  schemaFingerprint: string;
  observedAt: string;
}

export interface CostLedgerSessionObservation {
  source: CostLedgerSourceIdentity;
  agentType: string;
  sessionId: string;
  parentSessionId?: string;
  projectPath?: string;
  startedAt?: string;
  updatedAt?: string;
  evidence: CostLedgerEvidence;
}

export interface CostLedgerTokenObservation {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  uncachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface CostLedgerUsageObservation {
  source: CostLedgerSourceIdentity;
  sourceEventId: string;
  granularity: "request" | "session" | "turn" | string;
  /** Rollups overlap their child observations and must never be added to them. */
  isRollup: boolean;
  agentType?: string;
  sessionId?: string;
  parentSessionId?: string;
  requestId?: string;
  clientId?: string;
  accountId?: string;
  projectPath?: string;
  repository?: string;
  gitBranch?: string;
  model?: string;
  occurredAt?: string;
  tokens: CostLedgerTokenObservation;
  cost?: number;
  costCurrency?: string;
  credits?: number;
  operationCount?: number;
  status?: string;
  confidence: string;
  evidence: CostLedgerEvidence;
}

export interface CostLedgerAccountEntitlement {
  source: CostLedgerSourceIdentity;
  accountId?: string;
  plan?: string;
  quotaScope?: string;
  validUntil?: string;
  confidence: string;
  evidence: CostLedgerEvidence;
}

export interface CostLedgerBalanceObservation {
  source: CostLedgerSourceIdentity;
  accountId?: string;
  balance?: number;
  currency?: string;
  creditsRemaining?: number;
  observedAt: string;
  confidence: string;
  evidence: CostLedgerEvidence;
}

export interface CostLedgerSourceProbeReport {
  source: CostLedgerSourceIdentity;
  available: boolean;
  authorized: boolean;
  requiresAuthorization: boolean;
  recordCount: number;
  timeRangeStart?: string;
  timeRangeEnd?: string;
  granularities: string[];
  capabilities: string[];
  missingFields: string[];
  dedupeKey: string;
  incrementalCursor: string;
  incrementalSyncSupported: boolean;
  schemaFingerprint: string;
  confidence: string;
  sampledSessionCount: number;
  sampledUsageCount: number;
  errors: string[];
}

export interface CostLedgerSourceProbeResult {
  generatedAt: string;
  reports: CostLedgerSourceProbeReport[];
  sessions: CostLedgerSessionObservation[];
  usage: CostLedgerUsageObservation[];
  entitlements: CostLedgerAccountEntitlement[];
  balances: CostLedgerBalanceObservation[];
}
