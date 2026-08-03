export type DailyUsageTotal = {
  date: string;
  requestCount: number;
  knownTokens: number;
  inputTokens: number;
  inputCachedTokens: number;
  inputUncachedTokens: number;
  cacheMeasuredInputTokens: number;
  outputTokens: number;
  unknownCount: number;
  /** 经过 Flowlet 代理且已成功计价的请求费用；旧快照缺省为 0。 */
  estimatedCost?: number;
  /** 未经过 Flowlet 代理的 Agent 原生会话用量（快照 schema v6 起；旧快照缺省为 0）。 */
  nativeEventCount?: number;
  nativeInputTokens?: number;
  nativeCachedInputTokens?: number;
  nativeCacheWriteInputTokens?: number;
  nativeOutputTokens?: number;
  nativeReasoningTokens?: number;
  nativeTotalTokens?: number;
};

export type HourlyUsageTotal = {
  hour: string;
  requestCount: number;
  knownTokens: number;
  inputTokens?: number;
  inputCachedTokens?: number;
  cacheMeasuredInputTokens?: number;
  outputTokens?: number;
  /** 当前小时内尚未识别 Token 的代理请求数；旧快照缺省为 0。 */
  unknownCount?: number;
  estimatedCost?: number;
  nativeEventCount?: number;
  nativeInputTokens?: number;
  nativeCachedInputTokens?: number;
  nativeCacheWriteInputTokens?: number;
  nativeOutputTokens?: number;
  nativeReasoningTokens?: number;
  nativeTotalTokens?: number;
};

export type SyncedAgentSession = {
  agentType: "opencode" | "claude-code" | "codex-desktop" | "codex-cli" | "pi" | string;
  sessionId: string;
  parentSessionId: string | null;
  runtimeStatus: "idle" | "running" | "waiting_user" | "unknown";
  title: string | null;
  clientName: string | null;
  activityAt: string;
  flowletObserved: boolean;
  requestCount: number;
  errorCount: number;
  knownTokens: number;
  nativeTurnCount?: number | null;
  nativeTotalTokens?: number | null;
  nativeTruncated?: boolean;
  lastInteraction: SyncedAgentInteraction | null;
};

export type SyncedAgentInteractionEvent = {
  id: string;
  kind: string;
  timestamp: string | null;
  title: string | null;
  content: string | null;
  model: string | null;
  status: string | null;
};

export type SyncedAgentInteraction = {
  events: SyncedAgentInteractionEvent[];
};

export type SharedAgentSession = SyncedAgentSession & {
  deviceId: string;
  deviceDisplayName: string;
  devicePlatform: string;
};

export type SyncedAgentInstallation = {
  surface: "cli" | "desktop";
  installMethod: string;
  version: string | null;
};

export type SyncedAgentProfile = {
  agentId: "claude-code" | "opencode" | "pi" | "chatgpt-desktop" | string;
  agentName: string;
  installed: boolean;
  installations: SyncedAgentInstallation[];
  flowletConfigState: "not_configured" | "flowlet" | "other_gateway" | "partial" | "invalid" | null;
  flowletObserved: boolean;
};

export type DeviceUsageSnapshot = {
  schemaVersion: number;
  deviceId: string;
  deviceCreatedAt: string;
  displayName: string;
  platform: string;
  appVersion: string;
  generatedAt: string;
  timezoneOffsetMinutes: number;
  days: DailyUsageTotal[];
  hours: HourlyUsageTotal[];
  sessions: SyncedAgentSession[];
  agents: SyncedAgentProfile[];
  lanPeer: {
    protocolVersion: number;
    endpoints: string[];
    authKey: string;
    capabilities: string[];
    startedAt: string;
    expiresAt: string;
  } | null;
};

export type KnownDevice = {
  deviceId: string;
  deviceCreatedAt: string;
  displayName: string;
  platform: string;
  appVersion: string;
  isCurrent: boolean;
  timezoneOffsetMinutes: number;
  firstUsageDate: string | null;
  lastUsageDate: string | null;
  dayCount: number;
  requestCount: number;
  knownTokens: number;
  lastSeenAt: string;
};

export type DeviceUsageImportPreview = {
  deviceId: string;
  deviceCreatedAt: string;
  displayName: string;
  platform: string;
  appVersion: string;
  generatedAt: string;
  timezoneOffsetMinutes: number;
  firstDate: string | null;
  lastDate: string | null;
  dayCount: number;
  newDays: number;
  updatedDays: number;
  unchangedDays: number;
  sameAsCurrentDevice: boolean;
};

export type DeviceUsageImportResult = {
  deviceId: string;
  importedDays: number;
  unchangedDays: number;
};

export type S3SyncConfigInput = {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string | null;
  pathStyle: boolean;
};

export type S3SyncConfigView = Omit<S3SyncConfigInput, "secretAccessKey"> & {
  secretConfigured: boolean;
};

export type S3SyncStatus = {
  status: "never" | "running" | "success" | "partial" | "failed";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  message: string;
  remoteDevices: number;
  importedDevices: number;
  importedDays: number;
  failedObjects: number;
  failureDetails?: string[];
};

export type S3SyncSettings = {
  config: S3SyncConfigView | null;
  status: S3SyncStatus;
};

export type S3ConnectionTestResult = {
  message: string;
};

export type S3DeviceSyncResult = {
  remoteDevices: number;
  importedDevices: number;
  importedDays: number;
  unchangedDays: number;
  failedObjects: number;
  uploadedKey: string;
};

export type S3DevicePullResult = {
  remoteDevices: number;
  importedDevices: number;
  importedDays: number;
  unchangedDays: number;
  failedObjects: number;
  failureDetails?: string[];
};

export type DeviceRefreshResult = {
  source: "lan" | "s3";
  refreshedDevices: number;
};

export type LanInboundEvent = {
  remoteAddr: string;
  path: string;
  at: string;
};

export type LanServerStatus = {
  running: boolean;
  endpoints: string[];
  startedAt: string | null;
  error: string | null;
};

export type LanServerReport = {
  status: LanServerStatus;
  inbound: LanInboundEvent[];
};

export type LanProbeErrorKind = "unreachable" | "unauthorized" | "outdated" | "invalid";

export type LanPeerProbe = {
  deviceId: string;
  lanPublished: boolean;
  reachable: boolean;
  latencyMs: number | null;
  protocolVersion: number | null;
  errorKind: LanProbeErrorKind | null;
  error: string | null;
};

export type MobileSyncUpdate = {
  completedAt: string;
  s3ImportedDevices: number;
  s3FailedObjects: number;
  s3Error: string | null;
  lanProbeCount: number;
};
