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
  model: {
    all: ["model"] as const,
    channelModels: () => [...queryKeys.model.all, "channel-models"] as const,
    virtualModels: () => [...queryKeys.model.all, "virtual-models"] as const,
    candidates: () => [...queryKeys.model.all, "candidates"] as const,
    exposureMode: () => [...queryKeys.model.all, "exposure-mode"] as const,
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
    timeline: (agentType: string, sessionId: string) => [...queryKeys.agentSession.all, "timeline", agentType, sessionId] as const,
    nativeSummary: (agentType: string, sessionId: string) => [...queryKeys.agentSession.all, "native-summary", agentType, sessionId] as const,
    clients: () => [...queryKeys.agentSession.all, "clients"] as const,
  },
  backgroundTask: {
    all: ["background-task"] as const,
    list: (filter?: unknown) => [...queryKeys.backgroundTask.all, "list", filter] as const,
    detail: (jobId: string) => [...queryKeys.backgroundTask.all, "detail", jobId] as const,
    agentSyncStatus: () => [...queryKeys.backgroundTask.all, "agent-sync-status"] as const,
  },
  agent: {
    all: ["agent"] as const,
    environment: (agentId: string) => [...queryKeys.agent.all, "environment", agentId] as const,
    globalConfig: (agentId: string) => [...queryKeys.agent.all, "global-config", agentId] as const,
    codexAccount: () => [...queryKeys.agent.all, "codex-accounts"] as const,
  },
  usage: {
    all: ["usage"] as const,
    summary: () => [...queryKeys.usage.all, "summary"] as const,
    accountStats: () => [...queryKeys.usage.all, "account-stats"] as const,
    latestBalanceSnapshots: () => [...queryKeys.usage.all, "latest-balance-snapshots"] as const,
  },
  settings: {
    all: ["settings"] as const,
    autostart: () => [...queryKeys.settings.all, "autostart"] as const,
    logCapture: () => [...queryKeys.settings.all, "log-capture"] as const,
    dbStats: () => [...queryKeys.settings.all, "db-stats"] as const,
    storageUsage: () => [...queryKeys.settings.all, "storage-usage"] as const,
    modelPriceCurrencies: () => [...queryKeys.settings.all, "model-price-currencies"] as const,
    appMeta: (key: string) => [...queryKeys.settings.all, "app-meta", key] as const,
  },
} as const;
