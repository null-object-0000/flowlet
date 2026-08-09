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
  /** 标准化后的未缓存输入；Codex 原始输入中的缓存部分已扣除。 */
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
  /** 标准化后的未缓存输入；Codex 原始输入中的缓存部分已扣除。 */
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

/** 设备快照携带的轻量项目任务（移动端只读查看状态）。 */
export type SyncedProjectTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  /** 已开始的执行轮次数（execution_history 长度）；旧快照缺失时按 0 处理。 */
  executionCount?: number;
  updatedAt: string;
};

/** 共享设备项目目录：移动端据此发现「哪台设备能执行哪个项目」并提交任务。 */
export type SharedDeviceProject = {
  deviceId: string;
  deviceDisplayName: string;
  devicePlatform: string;
  /** 工作区项目 id（提交任务时使用）。 */
  projectId: string;
  projectName: string;
  hasLocalBinding: boolean;
  /** 最近一次项目更新（含任务变更）。 */
  updatedAt: string;
  tasks: SyncedProjectTask[];
};

/** 移动端 LAN 提交任务入参。 */
export type TaskSubmitInput = {
  projectId: string;
  title: string;
  description?: string;
  taskType?: "code" | "readonly";
  priority?: "p0" | "p1" | "p2";
  agentProfile?: string;
};

/** LAN 提交任务返回。 */
export type TaskSubmitResult = {
  taskId: string;
  status: string;
};

/** 移动端 LAN 直连变更任务状态入参（提交 / 撤回，草稿 ↔ 已提交）。 */
export type TaskStatusInput = {
  taskId: string;
  status: "draft" | "submitted";
};

/** 移动端 LAN 直连编辑草稿任务内容入参。
 *  设备快照不携带描述 / 任务类型 / Agent Profile，因此这些字段可选：不传时
 *  目标设备保留数据库原值；移动端目前只编辑标题。 */
export type TaskEditInput = {
  taskId: string;
  title: string;
  description?: string;
  taskType?: "code" | "readonly";
  agentProfile?: string;
};

/** 移动端 LAN 直连删除草稿任务入参（与编辑一致，只允许删除草稿状态任务）。 */
export type TaskDeleteInput = {
  taskId: string;
};
