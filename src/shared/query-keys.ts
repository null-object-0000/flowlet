/**
 * Centralized TanStack Query key factory. Each domain owns a `queryKeys`
 * object whose functions return stable, serializable key arrays. Mutation
 * invalidation imports the matching `queryKeys` and calls
 * `invalidateQueries({ queryKey: queryKeys.<domain>.all })` or a narrower
 * variant — never a global refreshAll.
 *
 * Convention: keys are arrays of strings/numbers/plain objects. Keep them
 * JSON-serializable so they can be structurally compared by Query.
 */

export const queryKeys = {
  proxy: {
    all: ["proxy"] as const,
    status: () => [...queryKeys.proxy.all, "status"] as const,
    bindConfig: () => [...queryKeys.proxy.all, "bind-config"] as const,
  },
  channel: {
    all: ["channel"] as const,
    presets: () => [...queryKeys.channel.all, "presets"] as const,
  },
  account: {
    all: ["account"] as const,
    list: () => [...queryKeys.account.all, "list"] as const,
    balance: (accountId: string) => [...queryKeys.account.all, "balance", accountId] as const,
  },
  accountWorkspace: {
    all: ["account-workspace"] as const,
    status: () => [...queryKeys.accountWorkspace.all, "status"] as const,
  },
  model: {
    all: ["model"] as const,
    channelModels: () => [...queryKeys.model.all, "channel-models"] as const,
    virtualModels: () => [...queryKeys.model.all, "virtual-models"] as const,
    candidates: () => [...queryKeys.model.all, "candidates"] as const,
    exposureMode: () => [...queryKeys.model.all, "exposure-mode"] as const,
  },
  modelCatalog: {
    all: ["model-catalog"] as const,
    catalog: () => [...queryKeys.modelCatalog.all, "models-cn"] as const,
    modelsDevCatalog: () => [...queryKeys.modelCatalog.all, "models-dev"] as const,
    currencies: () => [...queryKeys.modelCatalog.all, "currencies"] as const,
  },
  route: {
    all: ["route"] as const,
    candidates: () => [...queryKeys.route.all, "candidates"] as const,
    rules: () => [...queryKeys.route.all, "rules"] as const,
  },
  exposedModel: {
    all: ["exposed-model"] as const,
    routes: () => [...queryKeys.exposedModel.all, "routes"] as const,
  },
  requestLog: {
    all: ["request-log"] as const,
    list: (filter: unknown) => [...queryKeys.requestLog.all, "list", filter] as const,
    clients: () => [...queryKeys.requestLog.all, "clients"] as const,
    models: () => [...queryKeys.requestLog.all, "models"] as const,
    detail: (requestId: string) => [...queryKeys.requestLog.all, "detail", requestId] as const,
  },
  agentSession: {
    all: ["agent-session"] as const,
    list: (filter: unknown) => [...queryKeys.agentSession.all, "list", filter] as const,
    children: (agentType: string, sessionId: string) => [...queryKeys.agentSession.all, "children", agentType, sessionId] as const,
    openCodePermissions: (sessionId: string) => [...queryKeys.agentSession.all, "opencode-permissions", sessionId] as const,
    dshPermissions: (sessionId: string) => [...queryKeys.agentSession.all, "dsh-permissions", sessionId] as const,
    nativeSummary: (agentType: string, sessionId: string) => [...queryKeys.agentSession.all, "native-summary", agentType, sessionId] as const,
    flowletUsage: (agentType: string, sessionId: string) => [...queryKeys.agentSession.all, "flowlet-usage", agentType, sessionId] as const,
    lastInteraction: (agentType: string, sessionId: string) => [...queryKeys.agentSession.all, "last-interaction", agentType, sessionId] as const,
    timeline: (agentType: string, sessionId: string, range?: { startedAt: string; endedAt: string | null }) => range
      ? [...queryKeys.agentSession.all, "timeline", agentType, sessionId, range.startedAt, range.endedAt] as const
      : [...queryKeys.agentSession.all, "timeline", agentType, sessionId] as const,
    clients: () => [...queryKeys.agentSession.all, "clients"] as const,
  },
  project: {
    all: ["project"] as const,
    list: () => [...queryKeys.project.all, "list"] as const,
    detail: (projectId: string) => [...queryKeys.project.all, "detail", projectId] as const,
    tasks: (projectId: string) => [...queryKeys.project.all, "tasks", projectId] as const,
    recurringTasks: (projectId: string) => [...queryKeys.project.all, "recurring-tasks", projectId] as const,
    recurringRuns: (taskId: string) => [...queryKeys.project.all, "recurring-runs", taskId] as const,
  },
  projectTaskRunner: {
    all: ["project", "task-runner"] as const,
    state: () => [...queryKeys.projectTaskRunner.all, "state"] as const,
    queued: () => [...queryKeys.projectTaskRunner.all, "queued"] as const,
  },
  backgroundTask: {
    all: ["background-task"] as const,
    list: (filter?: unknown) => [...queryKeys.backgroundTask.all, "list", filter] as const,
    detail: (jobId: string) => [...queryKeys.backgroundTask.all, "detail", jobId] as const,
    agentSyncStatus: () => [...queryKeys.backgroundTask.all, "agent-sync-status"] as const,
  },
  agent: {
    all: ["agent"] as const,
    capabilities: () => [...queryKeys.agent.all, "capabilities"] as const,
    environment: (agentId: string) => [...queryKeys.agent.all, "environment", agentId] as const,
    globalConfig: (agentId: string) => [...queryKeys.agent.all, "global-config", agentId] as const,
    codexAccount: () => [...queryKeys.agent.all, "codex-accounts"] as const,
    latestVersions: () => [...queryKeys.agent.all, "latest-versions"] as const,
  },
  usage: {
    all: ["usage"] as const,
    summary: (filter: unknown) => [...queryKeys.usage.all, "summary", filter] as const,
    nativeSummary: () => [...queryKeys.usage.all, "native-summary"] as const,
    todayTokens: () => [...queryKeys.usage.all, "today-tokens"] as const,
    accountStats: () => [...queryKeys.usage.all, "account-stats"] as const,
    latestBalanceSnapshots: () => [...queryKeys.usage.all, "latest-balance-snapshots"] as const,
  },
  deviceSync: {
    all: ["device-sync"] as const,
    devices: () => [...queryKeys.deviceSync.all, "devices"] as const,
    projects: (deviceId: string | null) => [...queryKeys.deviceSync.all, "projects", deviceId ?? "all"] as const,
    dailyUsage: (deviceId: string | null) => [...queryKeys.deviceSync.all, "daily-usage", deviceId ?? "all"] as const,
    hourlyUsage: (deviceId: string | null) => [...queryKeys.deviceSync.all, "hourly-usage", deviceId ?? "all"] as const,
    sharedSessions: (deviceId: string | null) => [...queryKeys.deviceSync.all, "shared-sessions", deviceId ?? "all"] as const,
    s3Settings: () => [...queryKeys.deviceSync.all, "s3-settings"] as const,
    lanServerStatus: () => [...queryKeys.deviceSync.all, "lan-server-status"] as const,
    lanProbes: () => [...queryKeys.deviceSync.all, "lan-probes"] as const,
  },
  mobileDeviceSync: {
    all: ["mobile-device-sync"] as const,
    devices: () => [...queryKeys.mobileDeviceSync.all, "devices"] as const,
    accountResources: () => [...queryKeys.mobileDeviceSync.all, "account-resources"] as const,
    agents: (deviceId: string) => [...queryKeys.mobileDeviceSync.all, "agents", deviceId] as const,
    dailyUsage: (deviceId: string | null) => [...queryKeys.mobileDeviceSync.all, "daily-usage", deviceId ?? "all"] as const,
    hourlyUsage: (deviceId: string | null) => [...queryKeys.mobileDeviceSync.all, "hourly-usage", deviceId ?? "all"] as const,
    sessions: (deviceId: string | null) => [...queryKeys.mobileDeviceSync.all, "sessions", deviceId ?? "all"] as const,
    permissions: (deviceId: string, sessionId: string) => [...queryKeys.mobileDeviceSync.all, "permissions", deviceId, sessionId] as const,
    s3Settings: () => [...queryKeys.mobileDeviceSync.all, "s3-settings"] as const,
    lanProbes: () => [...queryKeys.mobileDeviceSync.all, "lan-probes"] as const,
    projects: (deviceId: string | null) => [...queryKeys.mobileDeviceSync.all, "projects", deviceId ?? "all"] as const,
  },
  settings: {
    all: ["settings"] as const,
    autostart: () => [...queryKeys.settings.all, "autostart"] as const,
    taskReviewNotification: () => [...queryKeys.settings.all, "task-review-notification"] as const,
    logCapture: () => [...queryKeys.settings.all, "log-capture"] as const,
    usageCostDisplay: () => [...queryKeys.settings.all, "usage-cost-display"] as const,
    dbStats: () => [...queryKeys.settings.all, "db-stats"] as const,
    storageUsage: () => [...queryKeys.settings.all, "storage-usage"] as const,
    modelPriceCurrencies: () => [...queryKeys.settings.all, "model-price-currencies"] as const,
    modelPrices: () => [...queryKeys.settings.all, "model-prices"] as const,
    appMeta: (key: string) => [...queryKeys.settings.all, "app-meta", key] as const,
  },
} as const;
