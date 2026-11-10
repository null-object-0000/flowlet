// Runtime configuration + channel presets. Owner: node-storage.
//
// Rust 等价实现：core/config.rs、core/channels_config.rs、core/presets.rs、
// core/runtime_config.rs、core/services.rs（FlowletServices::open / load_runtime_snapshot）。
//
// 规则：外部 config.json 优先；缺失/解析失败时回退内置默认；首次启动把内置默认写到磁盘。
// 渠道预设写入 SQLite（幂等），账号/路由/模型快照供 web 与 proxy 共用。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { modelCatalog } from "../catalog/index.ts";
import type { JsonRow } from "../types.ts";

/** 内置默认配置路径（镜像内 /app/config.json，开发时仓库根 config.json）。 */
export const DEFAULT_BUILTIN_CONFIG = fileURLToPath(new URL("../../../../config.json", import.meta.url));

/** 上游代理配置在 app_meta 中的键（与 Rust `UPSTREAM_PROXY_META_KEY` 一致）。 */
export const UPSTREAM_PROXY_META_KEY = "upstream_proxy_config";

export function readJsonFile(file: string): JsonRow | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as JsonRow;
  } catch {
    return null;
  }
}

export function loadOrCreateConfig(configPath: string, builtinPath = DEFAULT_BUILTIN_CONFIG): JsonRow {
  if (!existsSync(configPath)) {
    const builtin = readFileSync(builtinPath, "utf8");
    writeFileSync(configPath, builtin, { mode: 0o644 });
    return JSON.parse(builtin) as JsonRow;
  }
  const parsed = readJsonFile(configPath);
  if (parsed) return parsed;
  return JSON.parse(readFileSync(builtinPath, "utf8")) as JsonRow;
}

// ─── Channel presets（Rust ChannelsConfig::from_config_json） ─────────────────

export interface ChannelsConfig {
  /** ChannelPreset[]（snake_case，与 Rust serde 输出一致）。 */
  presets: JsonRow[];
  prices: JsonRow[];
  default_exposed_models: Record<string, string[]>;
  endpoints: Record<string, Record<string, string>>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseProtocols(raw: unknown): string[] {
  return asStringArray(raw).map((protocol) =>
    protocol === "anthropic" ? "anthropic" : protocol === "responses" ? "responses" : "openai",
  );
}

function parseAuthStrategy(raw: unknown): string {
  return raw === "x_api_key" ? "x_api_key" : "bearer";
}

/** 把 config.json 的 `channels_config` 解析成 Rust ChannelsConfig 的等价视图。 */
export function parseChannelsConfig(configJson: JsonRow): ChannelsConfig {
  const section = configJson?.channels_config as JsonRow | undefined;
  if (!section) throw new Error("config.json 中缺少 channels_config 字段");
  const channels = Array.isArray(section.channels) ? (section.channels as JsonRow[]) : [];
  const now = new Date().toISOString();
  const presets: JsonRow[] = channels.map((channel) => ({
    id: asString(channel.id),
    name: asString(channel.name),
    vendor: asString(channel.vendor),
    supported_protocols: parseProtocols(channel.supported_protocols),
    openai_base_url: asString(channel.openai_base_url),
    anthropic_base_url: asString(channel.anthropic_base_url),
    openai_auth: parseAuthStrategy(channel.openai_auth),
    anthropic_auth: parseAuthStrategy(channel.anthropic_auth),
    default_model: asString(channel.default_model),
    small_model: typeof channel.small_model === "string" ? channel.small_model : null,
    timeout_seconds: null,
    supports_model_list: Boolean(channel.supports_model_list),
    supports_model_detail: Boolean(channel.supports_model_detail),
    supports_balance_query: Boolean(channel.supports_balance_query),
    supports_quota_query: Boolean(channel.supports_quota_query),
    supports_usage_query: Boolean(channel.supports_usage_query),
    supports_scrape_balance: Boolean(channel.supports_scrape_balance),
    supports_files_api: Boolean(channel.supports_files_api),
    platform_url: typeof channel.platform_url === "string" ? channel.platform_url : null,
    enabled: true,
    created_at: now,
    updated_at: now,
  }));
  const endpoints: Record<string, Record<string, string>> = {};
  for (const channel of channels) {
    const id = asString(channel.id);
    const raw = channel.endpoints;
    if (!raw || typeof raw !== "object") continue;
    const overrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") overrides[key] = value;
    }
    endpoints[id] = overrides;
  }
  const prices = (Array.isArray(section.model_prices) ? section.model_prices : []).map(
    (price: JsonRow) => ({
      id: `price-${asString(price.channel_id)}-${asString(price.upstream_model)}`,
      channel_id: asString(price.channel_id),
      upstream_model: asString(price.upstream_model),
      input_uncached_price: Number(price.input_uncached_price) || 0,
      input_cached_price: Number(price.input_cached_price) || 0,
      input_cache_write_price:
        typeof price.input_cache_write_price === "number" ? price.input_cache_write_price : null,
      output_price: Number(price.output_price) || 0,
      tiers: Array.isArray(price.tiers) ? price.tiers : [],
      schedules: [],
      currency: asString(price.currency),
      unit: asString(price.unit),
      source_url: typeof price.source_url === "string" ? price.source_url : null,
      price_version: typeof price.price_version === "string" ? price.price_version : null,
      created_at: now,
      updated_at: now,
    }),
  );
  const defaultExposed = section.default_exposed_models;
  const default_exposed_models: Record<string, string[]> = {};
  if (defaultExposed && typeof defaultExposed === "object") {
    for (const [channelId, models] of Object.entries(defaultExposed as Record<string, unknown>)) {
      default_exposed_models[channelId] = asStringArray(models);
    }
  }
  return { presets, prices, default_exposed_models, endpoints };
}

/** 用内置默认配置补齐外部配置缺失的渠道 / 价格 / 端点 / 默认开放模型（merge_builtin_config）。 */
export function mergeBuiltinConfig(external: ChannelsConfig, builtin: ChannelsConfig): ChannelsConfig {
  for (const preset of builtin.presets) {
    if (!external.presets.some((current) => current.id === preset.id)) {
      external.presets.push(preset);
    }
  }
  const openaiPreset = external.presets.find((preset) => preset.id === "openai-api");
  if (openaiPreset) openaiPreset.supports_scrape_balance = false;
  for (const price of builtin.prices) {
    if (
      !external.prices.some(
        (current) =>
          current.channel_id === price.channel_id && current.upstream_model === price.upstream_model,
      )
    ) {
      external.prices.push(price);
    }
  }
  for (const [channelId, endpoints] of Object.entries(builtin.endpoints)) {
    if (!external.endpoints[channelId]) external.endpoints[channelId] = endpoints;
  }
  for (const [channelId, models] of Object.entries(builtin.default_exposed_models)) {
    if (!external.default_exposed_models[channelId]) {
      external.default_exposed_models[channelId] = models;
    }
  }
  return external;
}

/**
 * 加载渠道配置：外部 config.json 解析失败时回退内置默认（与 Rust
 * `load_channels_config_from` + `merge_builtin_config` 一致）。
 */
export function loadChannelsConfig(configJson: JsonRow, builtinJson?: JsonRow): ChannelsConfig {
  let external: ChannelsConfig;
  try {
    external = parseChannelsConfig(configJson);
  } catch {
    const builtin = builtinJson ?? readJsonFile(DEFAULT_BUILTIN_CONFIG);
    if (!builtin) throw new Error("config.json 中缺少 channels_config 字段");
    return parseChannelsConfig(builtin);
  }
  const builtin = builtinJson ?? readJsonFile(DEFAULT_BUILTIN_CONFIG);
  if (!builtin) return external;
  try {
    return mergeBuiltinConfig(external, parseChannelsConfig(builtin));
  } catch {
    return external;
  }
}

// ─── merge_default_routes（Rust ChannelsConfig::merge_default_routes） ────────

function effectiveOpenaiBaseUrl(account: JsonRow): string {
  for (const value of [account.base_url_override, account.workspace_default_base_url]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function effectiveAnthropicBaseUrl(account: JsonRow): string {
  for (const value of [
    account.anthropic_base_url_override,
    account.workspace_default_anthropic_base_url,
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isQwenTokenPlanAccount(account: JsonRow): boolean {
  return account.channel_id === "qwen" && account.resource_mode === "token_plan";
}

function routeSignature(route: JsonRow): string {
  return [
    route.virtual_model_id,
    route.channel_id,
    route.account_id,
    route.upstream_model,
    route.client_protocol,
  ].join("\0");
}

/**
 * 为现有账号补齐「用户已勾选开放」的直连模型路由（只追加，不覆盖已有状态）。
 *
 * 候选 = exposed_models ∩ synced_models ∩ 全局支持模型（按规范 ID 判断）。
 * `exposed_models` 为 null/缺省 → 不生成路由（老账号升级保持现状）。
 */
export function mergeDefaultRoutes(
  existing: JsonRow[],
  accounts: JsonRow[],
  presets: JsonRow[],
  now = new Date().toISOString(),
): JsonRow[] {
  const merged = existing.slice();
  const signatures = new Set(existing.map(routeSignature));
  const whitelist = modelCatalog().supportedModels();
  const canonicalByKey = new Map(whitelist.map((model) => [model.trim().toLowerCase(), model]));
  const firstAccountId = accounts
    .slice()
    .sort((left, right) => {
      const byCreated = String(left.created_at ?? "").trim().localeCompare(String(right.created_at ?? "").trim());
      return byCreated !== 0 ? byCreated : String(left.id).localeCompare(String(right.id));
    })[0]?.id as string | undefined;

  for (const preset of presets) {
    const protocols = Array.isArray(preset.supported_protocols)
      ? (preset.supported_protocols as string[])
      : ["openai"];
    for (const protocol of protocols) {
      const matching = accounts.filter(
        (account) =>
          account.channel_id === preset.id &&
          Boolean(account.enabled) &&
          (String(account.api_key ?? "").trim() !== "" || isQwenTokenPlanAccount(account)),
      );
      matching.forEach((account, accountIndex) => {
        const protocolHasEndpoint =
          preset.vendor !== "custom"
            ? true
            : protocol === "anthropic"
              ? effectiveAnthropicBaseUrl(account) !== ""
              : effectiveOpenaiBaseUrl(account) !== "";
        if (!protocolHasEndpoint) return;

        const exposed = Array.isArray(account.exposed_models) ? (account.exposed_models as string[]) : [];
        const syncedRaw = (Array.isArray(account.synced_models) ? (account.synced_models as string[]) : [])
          .map((model) => String(model).trim())
          .filter((model) => model !== "");
        const syncedById = new Map(syncedRaw.map((model) => [model.toLowerCase(), model]));
        const chosen: Array<[string, string]> = [];
        const seenUpstream = new Set<string>();
        for (const selected of exposed) {
          const selectedRaw = String(selected).trim();
          if (!selectedRaw) continue;
          const selectedKey = selectedRaw.toLowerCase();
          const canonicalKey = modelCatalog().canonicalKey(selectedRaw);
          const canonical = canonicalByKey.get(canonicalKey);
          if (!canonical) continue;
          let upstream = syncedById.get(selectedKey);
          if (!upstream && selectedKey === canonicalKey) {
            upstream = syncedRaw.find((model) => modelCatalog().canonicalKey(model) === canonicalKey);
          }
          if (!upstream) continue;
          if (seenUpstream.has(upstream.toLowerCase())) continue;
          seenUpstream.add(upstream.toLowerCase());
          chosen.push([canonical, upstream]);
        }
        chosen.forEach(([canonicalModel, upstreamModel], modelIndex) => {
          const route: JsonRow = {
            id: `route-${account.id}-${upstreamModel}-${protocol}-${modelIndex}-${accountIndex}`,
            virtual_model_id: canonicalModel,
            channel_id: preset.id,
            account_id: account.id,
            upstream_model: upstreamModel,
            client_protocol: protocol,
            priority: accountIndex,
            enabled: firstAccountId === account.id,
            created_at: now,
            updated_at: now,
          };
          const signature = routeSignature(route);
          if (signatures.has(signature)) return;
          signatures.add(signature);
          merged.push(route);
        });
      });
    }
  }
  return merged;
}

// ─── RuntimeConfig（Rust RuntimeConfigStore） ────────────────────────────────

/**
 * 代理与管理面共享的运行时快照。
 *
 * 形状对齐 Rust `RuntimeConfigSnapshot`：`{ channels, accounts, routes, rules,
 * virtual_models }`；`revision` 参与对象但非 Rust serde 输出字段（仅进程内使用）。
 */
export class RuntimeConfig {
  #snapshot: JsonRow;
  #revision = 1;

  constructor(snapshot: JsonRow = {}) {
    this.#snapshot = {
      channels: [],
      accounts: [],
      routes: [],
      rules: [],
      virtual_models: [],
      ...snapshot,
    };
  }

  snapshot(): JsonRow {
    return this.#snapshot;
  }

  /** 当前 revision（每次 update/replace 递增，供 proxy 判断快照是否变化）。 */
  revision(): number {
    return this.#revision;
  }

  replace(snapshot: JsonRow, options: { keepMissing?: boolean } = {}): number {
    const next: JsonRow = options.keepMissing
      ? { ...this.#snapshot, ...snapshot }
      : {
          channels: snapshot.channels ?? [],
          accounts: snapshot.accounts ?? [],
          routes: snapshot.routes ?? [],
          rules: snapshot.rules ?? [],
          virtual_models: snapshot.virtual_models ?? [],
        };
    this.#snapshot = next;
    this.#revision = this.#revision + 1;
    return this.#revision;
  }

  /** 基于最新 revision 修改并发布完整快照（clone → mutate → revision+1）。 */
  update(mutate: (draft: JsonRow) => void): number {
    const draft: JsonRow = {
      channels: (this.#snapshot.channels as JsonRow[]).slice(),
      accounts: (this.#snapshot.accounts as JsonRow[]).slice(),
      routes: (this.#snapshot.routes as JsonRow[]).slice(),
      rules: (this.#snapshot.rules as JsonRow[]).slice(),
      virtual_models: (this.#snapshot.virtual_models as JsonRow[]).slice(),
    };
    mutate(draft);
    this.#snapshot = draft;
    this.#revision = this.#revision + 1;
    return this.#revision;
  }

  /** 先持久化，成功后才发布下一版快照（Rust update_after）。 */
  updateAfter<T>(operation: () => T, mutate: (draft: JsonRow, value: T) => void): T {
    const value = operation();
    this.update((draft) => mutate(draft, value));
    return value;
  }
}

// ─── Storage 的结构化接口（避免 config ↔ storage 运行期循环导入） ─────────────

export interface PresetStorage {
  listChannelPresets(): JsonRow[];
  saveChannelPresets(presets: JsonRow[]): void;
  listChannelAccounts(): JsonRow[];
  saveChannelAccounts(accounts: JsonRow[]): JsonRow[];
  listRouteCandidates(): JsonRow[];
  saveRouteCandidates(routes: JsonRow[]): void;
  listVirtualModels(): JsonRow[];
  saveVirtualModels(models: JsonRow[]): void;
  listRouteRules(): JsonRow[];
  listChannelModels(): JsonRow[];
  saveChannelModels(models: JsonRow[]): void;
  getAppMeta(key: string): string | null;
  setAppMeta(key: string, value: string): void;
  setPrices?(prices: JsonRow[]): void;
  ensurePresetPlatformUrls(presets: JsonRow[]): void;
  ensureMissingPresets(presets: JsonRow[]): void;
  syncPresetMaintainedConfig(presets: JsonRow[]): void;
  ensurePresetBalanceQuery(presets: JsonRow[]): void;
  ensurePresetScrapeBalance(presets: JsonRow[]): void;
  ensurePresetFilesApi(presets: JsonRow[]): void;
}

/** Rust services.rs::initialize_channel_presets 的等价步骤（幂等）。 */
export function initializeChannelPresets(
  storage: PresetStorage,
  channelsConfig: ChannelsConfig,
  builtinPresets: JsonRow[] = readBuiltinPresets(),
): void {
  storage.ensurePresetPlatformUrls(channelsConfig.presets);
  const migrationPresets = channelsConfig.presets.slice();
  for (const preset of builtinPresets) {
    if (!migrationPresets.some((current) => current.id === preset.id)) {
      migrationPresets.push(preset);
    }
  }
  storage.ensureMissingPresets(migrationPresets);
  storage.syncPresetMaintainedConfig(migrationPresets);
  storage.ensurePresetBalanceQuery(migrationPresets);
  storage.ensurePresetScrapeBalance(migrationPresets);
  storage.ensurePresetFilesApi(migrationPresets);
}

function readBuiltinPresets(): JsonRow[] {
  const builtin = readJsonFile(DEFAULT_BUILTIN_CONFIG);
  if (!builtin) return [];
  try {
    return parseChannelsConfig(builtin).presets;
  } catch {
    return [];
  }
}

/** 渠道声明「模型转发默认走全局上游代理」的适配器（当前仅 ChatGPT API）。 */
const CHANNELS_USING_UPSTREAM_PROXY_FOR_MODELS = new Set(["openai-api"]);

/**
 * Rust services.rs::load_runtime_snapshot 的等价步骤：读四类集合、清理无效行、
 * 补齐默认路由并回写 SQLite，返回进程级 RuntimeConfig。
 */
export function loadRuntimeSnapshot(
  storage: PresetStorage,
  channelsConfig: ChannelsConfig,
  options: { upstreamProxyActive?: boolean } = {},
): RuntimeConfig {
  // 与 Rust FlowletServices::open 顺序一致：先幂等初始化渠道预设，再读取快照。
  initializeChannelPresets(storage, channelsConfig);
  storage.setPrices?.(channelsConfig.prices);
  let channels = storage.listChannelPresets();
  if (channels.length === 0) {
    channels = channelsConfig.presets.slice();
    storage.saveChannelPresets(channels);
  }

  let accounts = storage.listChannelAccounts();
  const originalCount = accounts.length;
  accounts = accounts.filter(
    (account) =>
      !(account.id === "account-default" && String(account.api_key ?? "").trim() === ""),
  );
  let accountsChanged = accounts.length !== originalCount;
  const proxyActive = options.upstreamProxyActive ?? false;
  for (const account of accounts) {
    if (account.use_upstream_proxy === null || account.use_upstream_proxy === undefined) {
      account.use_upstream_proxy =
        proxyActive && CHANNELS_USING_UPSTREAM_PROXY_FOR_MODELS.has(String(account.channel_id));
      accountsChanged = true;
    }
  }
  if (accountsChanged) storage.saveChannelAccounts(accounts);

  const virtualModels = storage.listVirtualModels();
  storage.saveVirtualModels(virtualModels);

  const routes = storage.listRouteCandidates();
  const cleanedRoutes = routes.filter((route) => {
    if (route.id === "route-auto-default" || route.account_id === "account-default") return false;
    if (!route.enabled) return true;
    if (String(route.upstream_model ?? "").trim() === "") return false;
    if (!channels.some((channel) => channel.id === route.channel_id)) return false;
    return accounts.some(
      (account) =>
        account.id === route.account_id &&
        account.channel_id === route.channel_id &&
        Boolean(account.enabled) &&
        String(account.api_key ?? "").trim() !== "",
    );
  });
  const mergedRoutes = mergeDefaultRoutes(cleanedRoutes, accounts, channels);
  storage.saveRouteCandidates(mergedRoutes);

  const rules = storage.listRouteRules();
  return new RuntimeConfig({
    channels,
    accounts,
    routes: mergedRoutes,
    rules,
    virtual_models: virtualModels,
  });
}

// ─── 进程级配置读取（log_capture / upstream_proxy / bind） ────────────────────

/** 默认 LogCaptureConfig（Rust LogCaptureConfig::default，config.json 无 log_capture 段时）。 */
export function defaultLogCaptureConfig(): JsonRow {
  return {
    capture_req_headers: true,
    capture_req_body: true,
    capture_res_headers: true,
    capture_res_body: true,
    max_body_bytes: 1024 * 1024,
    redact_sensitive_headers: false,
    body_retention_days: 7,
    body_max_size_mb: 1024,
    body_prune_ratio: 0.1,
  };
}

/**
 * Rust proxy_http.rs::extract_log_capture 的等价实现。
 *
 * 注意：`log_capture` 段存在但字段缺失时，Rust 回退值是 retention=3 / max=512（不是
 * `LogCaptureConfig::default` 的 7 / 1024），必须逐字段保持。
 */
export function extractLogCapture(configJson: JsonRow): JsonRow {
  const section = configJson?.log_capture;
  if (!section || typeof section !== "object") return defaultLogCaptureConfig();
  const lc = section as JsonRow;
  const num = (key: string, fallback: number): number =>
    typeof lc[key] === "number" ? (lc[key] as number) : fallback;
  return {
    capture_req_headers: typeof lc.capture_req_headers === "boolean" ? lc.capture_req_headers : true,
    capture_req_body: typeof lc.capture_req_body === "boolean" ? lc.capture_req_body : true,
    capture_res_headers: typeof lc.capture_res_headers === "boolean" ? lc.capture_res_headers : true,
    capture_res_body: typeof lc.capture_res_body === "boolean" ? lc.capture_res_body : true,
    max_body_bytes: num("max_body_bytes", 1024 * 1024),
    redact_sensitive_headers:
      typeof lc.redact_sensitive_headers === "boolean" ? lc.redact_sensitive_headers : false,
    body_retention_days: num("body_retention_days", 3),
    body_max_size_mb: num("body_max_size_mb", 512),
    body_prune_ratio: num("body_prune_ratio", 0.1),
  };
}

/**
 * 进程级日志捕获配置：app_meta.log_capture_config 优先，缺失时回退 config.json 的
 * `log_capture`（Rust FlowletServices::open 语义）。每次调用都直读 SQLite，不缓存。
 */
export function loadLogCaptureConfig(storage: Pick<PresetStorage, "getAppMeta">, configJson: JsonRow): JsonRow {
  const stored = storage.getAppMeta("log_capture_config");
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as JsonRow;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* 解析失败回退 config.json */
    }
  }
  return extractLogCapture(configJson);
}

export interface UpstreamProxyConfig {
  enabled: boolean;
  url: string;
}

export function normalizeUpstreamProxyConfig(config: Partial<UpstreamProxyConfig>): UpstreamProxyConfig {
  const url = String(config.url ?? "").trim();
  return { enabled: url === "" ? false : Boolean(config.enabled), url };
}

export function validateUpstreamProxyConfig(config: UpstreamProxyConfig): void {
  if (!config.enabled) return;
  const url = config.url.trim();
  if (!url) throw new Error("上游代理地址不能为空");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`上游代理地址无效：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https 上游代理（不支持 socks 代理）");
  }
}

export function upstreamProxyIsActive(config: UpstreamProxyConfig): boolean {
  return config.enabled && config.url.trim() !== "";
}

/**
 * 进程级上游代理配置：app_meta 优先，缺失时回退 config.json 的 `network.upstream_proxy`。
 */
export function loadUpstreamProxyConfig(
  storage: Pick<PresetStorage, "getAppMeta">,
  configJson: JsonRow,
): UpstreamProxyConfig {
  const stored = storage.getAppMeta(UPSTREAM_PROXY_META_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<UpstreamProxyConfig>;
      if (parsed && typeof parsed === "object") return normalizeUpstreamProxyConfig(parsed);
    } catch {
      /* 解析失败回退 config.json */
    }
  }
  const section = (configJson?.network as JsonRow | undefined)?.upstream_proxy as
    | Partial<UpstreamProxyConfig>
    | undefined;
  return normalizeUpstreamProxyConfig(section ?? {});
}

/** config.json 的 `bind` 段（Rust services.rs::parse_bind_config）。 */
export function parseBindConfig(configJson: JsonRow): JsonRow {
  const bind = configJson?.bind;
  if (!bind || typeof bind !== "object") return {};
  const host = typeof (bind as JsonRow).host === "string" ? (bind as JsonRow).host : "127.0.0.1";
  const port = typeof (bind as JsonRow).port === "number" ? (bind as JsonRow).port : 18640;
  const defaultClientToken =
    typeof (bind as JsonRow).default_client_token === "string"
      ? (bind as JsonRow).default_client_token
      : "flowlet-local-token";
  return { host, port, allow_lan: host === "0.0.0.0", default_client_token: defaultClientToken };
}