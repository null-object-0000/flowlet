// Candidate matching, round-robin, Files account binding and fallback rules.
// 逐段对照 `src-tauri/src/core/proxy_routing.rs`。
import {
  asArray,
  bool,
  isRecord,
  num,
  str,
  type JsonRow,
  type Protocol,
} from "./util.ts";

export interface ChannelRow {
  id: string;
  name: string;
  vendor: string;
  supported_protocols: Protocol[];
  openai_base_url: string;
  anthropic_base_url: string;
  openai_auth: "bearer" | "x_api_key";
  anthropic_auth: "bearer" | "x_api_key";
  timeout_seconds: number | null;
  supports_files_api: boolean;
  enabled: boolean;
}

export interface AccountRow {
  id: string;
  channel_id: string;
  name: string;
  api_key: string;
  enabled: boolean;
  priority: number;
  credential_status: string;
  created_at: string;
  last_error: string | null;
  use_upstream_proxy: boolean | null;
  base_url_override: string | null;
  anthropic_base_url_override: string | null;
  workspace_default_base_url: string | null;
  workspace_default_anthropic_base_url: string | null;
}

export interface RouteRow {
  id: string;
  virtual_model_id: string;
  channel_id: string;
  account_id: string;
  upstream_model: string;
  client_protocol: Protocol;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface RuleRow {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match_client_id: string | null;
  match_model: string | null;
  match_protocol: Protocol | null;
  target_channel_id: string;
  target_account_id: string;
  target_upstream_model: string;
}

export interface CandidateSelection {
  matched: RouteRow[];
  /** 模型/账号可用，但未声明当前请求协议的候选；仅当无匹配候选时才展示。 */
  protocol_skipped: RouteRow[];
}

export const ACCOUNT_CREDENTIAL_HEALTHY = "healthy";
export const ACCOUNT_CREDENTIAL_INVALID_KEY = "invalid_key";

const PROTOCOLS: Protocol[] = ["openai", "anthropic", "responses"];

/** 宽松把快照里的 JSON 行解析成强类型（缺失字段落 Rust serde 默认值）。 */
export function asChannel(raw: unknown): ChannelRow {
  const row = isRecord(raw) ? raw : {};
  const protocols = asArray<unknown>(row.supported_protocols).filter(
    (value): value is Protocol => typeof value === "string" && PROTOCOLS.includes(value as Protocol),
  );
  return {
    id: str(row.id) ?? "",
    name: str(row.name) ?? "",
    vendor: str(row.vendor) ?? "",
    supported_protocols: protocols,
    openai_base_url: str(row.openai_base_url) ?? "",
    anthropic_base_url: str(row.anthropic_base_url) ?? "",
    openai_auth: row.openai_auth === "x_api_key" ? "x_api_key" : "bearer",
    anthropic_auth: row.anthropic_auth === "x_api_key" ? "x_api_key" : "bearer",
    timeout_seconds: num(row.timeout_seconds) ?? null,
    supports_files_api: bool(row.supports_files_api) ?? false,
    enabled: bool(row.enabled) ?? true,
  };
}

export function asAccount(raw: unknown): AccountRow {
  const row = isRecord(raw) ? raw : {};
  return {
    id: str(row.id) ?? "",
    channel_id: str(row.channel_id) ?? "",
    name: str(row.name) ?? "",
    api_key: str(row.api_key) ?? "",
    enabled: bool(row.enabled) ?? false,
    priority: num(row.priority) ?? 0,
    credential_status: str(row.credential_status) ?? ACCOUNT_CREDENTIAL_HEALTHY,
    created_at: str(row.created_at) ?? "",
    last_error: str(row.last_error) ?? null,
    use_upstream_proxy:
      row.use_upstream_proxy === true ? true : row.use_upstream_proxy === false ? false : null,
    base_url_override: str(row.base_url_override) ?? null,
    anthropic_base_url_override: str(row.anthropic_base_url_override) ?? null,
    workspace_default_base_url: str(row.workspace_default_base_url) ?? null,
    workspace_default_anthropic_base_url: str(row.workspace_default_anthropic_base_url) ?? null,
  };
}

export function asRoute(raw: unknown): RouteRow {
  const row = isRecord(raw) ? raw : {};
  const protocol = str(row.client_protocol);
  return {
    id: str(row.id) ?? "",
    virtual_model_id: str(row.virtual_model_id) ?? "",
    channel_id: str(row.channel_id) ?? "",
    account_id: str(row.account_id) ?? "",
    upstream_model: str(row.upstream_model) ?? "",
    client_protocol:
      protocol === "anthropic" || protocol === "responses" ? protocol : "openai",
    priority: num(row.priority) ?? 0,
    enabled: bool(row.enabled) ?? true,
    created_at: str(row.created_at) ?? "",
    updated_at: str(row.updated_at) ?? "",
  };
}

export function asRule(raw: unknown): RuleRow {
  const row = isRecord(raw) ? raw : {};
  const protocol = str(row.match_protocol);
  return {
    id: str(row.id) ?? "",
    name: str(row.name) ?? "",
    enabled: bool(row.enabled) ?? true,
    priority: num(row.priority) ?? 0,
    match_client_id: str(row.match_client_id) ?? null,
    match_model: str(row.match_model) ?? null,
    match_protocol:
      protocol === "openai" || protocol === "anthropic" || protocol === "responses"
        ? protocol
        : null,
    target_channel_id: str(row.target_channel_id) ?? "",
    target_account_id: str(row.target_account_id) ?? "",
    target_upstream_model: str(row.target_upstream_model) ?? "",
  };
}

/** 账号是否可参与路由：启用、配了 API Key、且凭证健康。 */
export function accountIsRoutable(account: AccountRow): boolean {
  return (
    account.enabled &&
    account.api_key.trim() !== "" &&
    account.credential_status === ACCOUNT_CREDENTIAL_HEALTHY
  );
}

/** account_deactivated 属临时状态：每次新请求仍允许探测，成功即恢复 healthy。 */
export function isTransientDeactivatedAccount(account: AccountRow): boolean {
  if (account.credential_status !== ACCOUNT_CREDENTIAL_INVALID_KEY) return false;
  const error = (account.last_error ?? "").toLowerCase();
  return error.includes("account_deactivated") || error.includes("api key is disabled");
}

export function routeIdentityIsConsistent(
  route: RouteRow,
  canonicalKey: (model: string) => string,
): boolean {
  return canonicalKey(route.virtual_model_id) === canonicalKey(route.upstream_model);
}

function sortRouteCandidates(
  candidates: RouteRow[],
  accountById: Map<string, AccountRow>,
): void {
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.channel_id !== b.channel_id) return a.channel_id < b.channel_id ? -1 : 1;
    if (a.upstream_model !== b.upstream_model) return a.upstream_model < b.upstream_model ? -1 : 1;
    const accountA = accountById.get(a.account_id);
    const accountB = accountById.get(b.account_id);
    const priorityA = accountA?.priority;
    const priorityB = accountB?.priority;
    if (priorityA !== priorityB) {
      if (priorityA === undefined) return -1;
      if (priorityB === undefined) return 1;
      return priorityA - priorityB;
    }
    const createdA = accountA?.created_at;
    const createdB = accountB?.created_at;
    if (createdA === createdB) return 0;
    if (createdA === undefined) return -1;
    if (createdB === undefined) return 1;
    return createdA < createdB ? -1 : 1;
  });
}

export function findMatchingRule(
  rules: RuleRow[],
  clientId: string | null,
  model: string | null,
  protocol: Protocol,
  accounts: AccountRow[],
): RuleRow | null {
  const sorted = rules
    .filter((rule) => rule.enabled)
    .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.id < b.id ? -1 : 1));
  for (const rule of sorted) {
    if (rule.match_client_id !== null && clientId !== rule.match_client_id) continue;
    if (rule.match_model !== null && model !== rule.match_model) continue;
    if (rule.match_protocol !== null && rule.match_protocol !== protocol) continue;
    if (!accounts.some((account) => account.id === rule.target_account_id && account.enabled)) {
      continue;
    }
    return rule;
  }
  return null;
}

/**
 * 候选匹配。`publicModel` 必须已是规范模型 ID（调用方先做 `routingModelId` 归一），
 * 这里只做精确匹配，不解析别名。
 */
export function matchCandidates(
  routes: RouteRow[],
  rules: RuleRow[],
  accounts: AccountRow[],
  publicModel: string | null,
  protocol: Protocol,
  clientId: string | null,
  roundRobin: Map<string, number>,
  canonicalKey: (model: string) => string,
): CandidateSelection {
  const empty: CandidateSelection = { matched: [], protocol_skipped: [] };
  const model = publicModel?.trim() ?? "";
  if (model === "") return empty;
  if (isRetiredAggregateModelId(model)) return empty;

  const rule = findMatchingRule(rules, clientId, model, protocol, accounts);
  if (rule !== null) {
    return {
      matched: [
        {
          id: `rule-${rule.id}`,
          virtual_model_id: model,
          channel_id: rule.target_channel_id,
          account_id: rule.target_account_id,
          upstream_model: rule.target_upstream_model,
          client_protocol: protocol,
          priority: rule.priority,
          enabled: true,
          created_at: "",
          updated_at: "",
        },
      ],
      protocol_skipped: [],
    };
  }

  const accountById = new Map<string, AccountRow>();
  for (const account of accounts) {
    if (accountIsRoutable(account)) accountById.set(account.id, account);
  }

  const matched: RouteRow[] = [];
  const protocolSkipped: RouteRow[] = [];
  for (const route of routes) {
    if (!route.enabled || route.virtual_model_id !== model) continue;
    if (!routeIdentityIsConsistent(route, canonicalKey)) continue;
    if (!accountById.has(route.account_id)) continue;
    if (route.client_protocol !== protocol) {
      protocolSkipped.push(route);
      continue;
    }
    matched.push(route);
  }

  sortRouteCandidates(matched, accountById);
  sortRouteCandidates(protocolSkipped, accountById);

  // 每个「对外模型 + 协议 + 渠道 + 上游模型」的账号池独立轮询；
  // 池与池之间仍按 priority 固定 fallback。
  let cursor = 0;
  while (cursor < matched.length) {
    const groupPriority = matched[cursor].priority;
    const groupChannel = matched[cursor].channel_id;
    const groupModel = matched[cursor].upstream_model;
    let end = cursor + 1;
    while (
      end < matched.length &&
      matched[end].priority === groupPriority &&
      matched[end].channel_id === groupChannel &&
      matched[end].upstream_model === groupModel
    ) {
      end += 1;
    }
    const key = `${model}:${protocol}:${groupChannel}:${groupModel}`;
    const groupLength = end - cursor;
    const next = roundRobin.get(key) ?? 0;
    rotateLeft(matched, cursor, end, next % groupLength);
    roundRobin.set(key, (next + 1) % groupLength);
    cursor = end;
  }

  return { matched, protocol_skipped: protocolSkipped };
}

function rotateLeft(candidates: RouteRow[], start: number, end: number, by: number): void {
  if (by === 0) return;
  const group = candidates.splice(start, end - start);
  candidates.splice(start, 0, ...group.slice(by), ...group.slice(0, by));
}

export function isRetiredAggregateModelId(modelId: string): boolean {
  return modelId.trim().toLowerCase() === "flowlet-pro" || modelId.trim().toLowerCase() === "flowlet-flash";
}

/**
 * Anthropic Files API 的绑定账号：在声明 supports_files_api 且支持 Anthropic 的渠道里，
 * 按 `(渠道 id, 账号优先级, 创建时间, 账号 id)` 全序取第一个可路由账号。
 */
export function filesAccount(
  channels: ChannelRow[],
  accounts: AccountRow[],
): { channel: ChannelRow; account: AccountRow } | null {
  const candidates: { channel: ChannelRow; account: AccountRow }[] = [];
  for (const channel of channels) {
    if (
      !channel.enabled ||
      !channel.supports_files_api ||
      !channel.supported_protocols.includes("anthropic")
    ) {
      continue;
    }
    for (const account of accounts) {
      if (account.channel_id !== channel.id || !accountIsRoutable(account)) continue;
      candidates.push({ channel, account });
    }
  }
  candidates.sort((a, b) => {
    if (a.channel.id !== b.channel.id) return a.channel.id < b.channel.id ? -1 : 1;
    if (a.account.priority !== b.account.priority) return a.account.priority - b.account.priority;
    if (a.account.created_at !== b.account.created_at) {
      return a.account.created_at < b.account.created_at ? -1 : 1;
    }
    if (a.account.id === b.account.id) return 0;
    return a.account.id < b.account.id ? -1 : 1;
  });
  return candidates.length === 0 ? null : candidates[0];
}

// ─── Fallback rules ─────────────────────────────────────────────────────────

/** 429 / 5xx / (DeepSeek 402) 才按状态码降级。 */
export function shouldTryNextStatus(status: number, channelVendor: string): boolean {
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return channelVendor === "deepseek" && status === 402;
}

/** 400/402/403 才读取响应体做降级探测。 */
export function shouldInspectFallbackBody(status: number): boolean {
  return status === 400 || status === 402 || status === 403;
}

export function bodyContainsQuotaExceeded(body: Buffer): boolean {
  const text = body.toString("utf8").toLowerCase();
  return (
    text.includes("quota exceeded") ||
    text.includes("insufficient quota") ||
    text.includes("exceeded your current quota") ||
    text.includes("billing quota") ||
    text.includes("balance insufficient")
  );
}

export function bodyContainsProductNotActivated(body: Buffer): boolean {
  const parsed = safeJson(body);
  if (!isRecord(parsed)) return false;
  const error = isRecord(parsed.error) ? parsed.error : parsed;
  const code = str(error.code);
  const message = str(error.message);
  return (
    code !== undefined &&
    code.toLowerCase() === "invalid_parameter_error" &&
    message !== undefined &&
    message.toLowerCase().includes("product is not activated")
  );
}

export function bodyContainsAccountDeactivated(body: Buffer): boolean {
  const parsed = safeJson(body);
  if (isRecord(parsed)) {
    const error = isRecord(parsed.error) ? parsed.error : parsed;
    const code = str(error.code);
    if (code !== undefined && code.toLowerCase() === "account_deactivated") return true;
    const message = str(error.message);
    if (message !== undefined && message.toLowerCase().includes("api key is disabled")) {
      return true;
    }
  }
  return body.toString("utf8").toLowerCase().includes("api key is disabled");
}

function safeJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** 4xx/5xx 时补 `error_message`，并把 direct/auto 改成 upstream_error。 */
export function enrichUpstreamErrorLog(log: JsonRow, status: number): void {
  if (!(status >= 400 && status <= 599)) return;
  if (log.error_message === undefined || log.error_message === null) {
    log.error_message = `upstream status ${status}`;
  }
  if (log.route_reason === "direct" || log.route_reason === "auto") {
    log.route_reason = "upstream_error";
  }
}

/** 请求是否包含图片输入（`model_input_capabilities.rs::request_uses_image`）。 */
export function requestUsesImage(body: Buffer, protocol: Protocol): boolean {
  const parsed = safeJson(body);
  if (parsed === null) return false;
  const types =
    protocol === "openai"
      ? ["image_url", "input_image"]
      : protocol === "responses"
        ? ["input_image"]
        : ["image"];
  return containsContentType(parsed, types);
}

function containsContentType(value: unknown, imageTypes: string[]): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsContentType(item, imageTypes));
  }
  if (!isRecord(value)) return false;
  const type = str(value.type);
  if (type !== undefined && imageTypes.includes(type)) return true;
  for (const key of ["messages", "content", "input"]) {
    if (key in value && containsContentType(value[key], imageTypes)) return true;
  }
  return false;
}
