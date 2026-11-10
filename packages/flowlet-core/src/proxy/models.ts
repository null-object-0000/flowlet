// `/models` 列表与 `/v1/models/{id}` 详情响应。
//
// 权威实现：`src-tauri/src/core/proxy_http.rs`（build_model_list_response /
// build_model_detail_response / collect_model_entries / 价格选择）。
import type { ModelIdentityIndex } from "./catalog.ts";
import type { AccountRow, ChannelRow, RouteRow } from "./routing.ts";
import { accountIsRoutable, isRetiredAggregateModelId } from "./routing.ts";
import { asArray, isRecord, num, parseUnixSeconds, str, type JsonRow, type Protocol } from "./util.ts";

export interface ModelEntry {
  id: string;
  owned_by: string;
  created_at: string;
}

export interface HttpResponseSpec {
  status: number;
  contentType: string;
  body: string;
}

function jsonResponse(value: unknown): HttpResponseSpec {
  return { status: 200, contentType: "application/json", body: JSON.stringify(value) };
}

function vendorByChannel(channels: ChannelRow[]): Map<string, string> {
  return new Map(channels.map((channel) => [channel.id, channel.vendor]));
}

/**
 * 对外模型 = 路由的规范模型 ID；只暴露 enabled 路由 + 健康账号 + 协议匹配 +
 * 规范身份一致 + 非退役聚合名，同一 virtual_model_id 只出现一次，按名字典序。
 */
export function collectModelEntries(
  routes: RouteRow[],
  accounts: AccountRow[],
  channels: ChannelRow[],
  protocol: Protocol,
  identity: ModelIdentityIndex,
): ModelEntry[] {
  const healthy = new Set(
    accounts.filter(accountIsRoutable).map((account) => account.id),
  );
  const vendors = vendorByChannel(channels);
  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    if (!route.enabled || route.client_protocol !== protocol) continue;
    if (!healthy.has(route.account_id)) continue;
    if (isRetiredAggregateModelId(route.virtual_model_id)) continue;
    if (
      identity.canonicalKey(route.virtual_model_id) !== identity.canonicalKey(route.upstream_model)
    ) {
      continue;
    }
    const id = route.virtual_model_id.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      owned_by: vendors.get(route.channel_id) ?? "flowlet",
      created_at: route.created_at,
    });
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries;
}

export function buildModelListResponse(
  routes: RouteRow[],
  accounts: AccountRow[],
  channels: ChannelRow[],
  protocol: Protocol,
  identity: ModelIdentityIndex,
): HttpResponseSpec {
  const entries = collectModelEntries(routes, accounts, channels, protocol, identity);
  if (protocol === "anthropic") {
    const data = entries.map((entry) => ({
      id: entry.id,
      type: "model",
      display_name: entry.id,
      created_at: entry.created_at === "" ? "1970-01-01T00:00:00Z" : entry.created_at,
    }));
    return jsonResponse({
      data,
      has_more: false,
      first_id: data.length === 0 ? "" : data[0].id,
      last_id: data.length === 0 ? "" : data[data.length - 1].id,
    });
  }
  const data = entries.map((entry) => ({
    id: entry.id,
    object: "model",
    created: parseUnixSeconds(entry.created_at),
    owned_by: entry.owned_by,
  }));
  return jsonResponse({ object: "list", data });
}

export interface ChannelModelRow {
  channel_id: string;
  model: string;
  context_window: number | null;
  max_output_tokens: number | null;
  pricing: JsonRow | null;
}

export function asChannelModel(raw: unknown): ChannelModelRow {
  const row = isRecord(raw) ? raw : {};
  return {
    channel_id: str(row.channel_id) ?? "",
    model: str(row.model) ?? "",
    context_window: num(row.context_window) ?? null,
    max_output_tokens: num(row.max_output_tokens) ?? null,
    pricing: isRecord(row.pricing) ? row.pricing : null,
  };
}

function usableModelRoutes(
  modelId: string,
  routes: RouteRow[],
  accounts: AccountRow[],
  channels: ChannelRow[],
): RouteRow[] {
  const healthy = new Set(accounts.filter(accountIsRoutable).map((account) => account.id));
  const enabledChannels = new Set(channels.filter((channel) => channel.enabled).map((c) => c.id));
  return routes.filter(
    (route) =>
      route.enabled &&
      route.client_protocol === "openai" &&
      route.virtual_model_id === modelId &&
      healthy.has(route.account_id) &&
      enabledChannels.has(route.channel_id),
  );
}

function modelNotFoundResponse(modelId: string): HttpResponseSpec {
  return {
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({
      error: {
        message: `The model '${modelId}' does not exist or is not exposed`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    }),
  };
}

/** `/v1/models/{id}`：单一规范模型的规格与价格。 */
export function buildModelDetailResponse(
  requestedId: string,
  routes: RouteRow[],
  accounts: AccountRow[],
  channels: ChannelRow[],
  channelModels: ChannelModelRow[],
  identity: ModelIdentityIndex,
): HttpResponseSpec {
  const entries = collectModelEntries(routes, accounts, channels, "openai", identity);
  const entry = entries.find((candidate) => candidate.id === requestedId);
  if (!entry) return modelNotFoundResponse(requestedId);

  const usableRoutes = usableModelRoutes(requestedId, routes, accounts, channels);
  const route = usableRoutes[0];
  const detail = route === undefined ? null : resolveCandidateDetail(route, channelModels, identity);

  return jsonResponse({
    id: entry.id,
    object: "model",
    created: parseUnixSeconds(entry.created_at),
    owned_by: entry.owned_by,
    context_window: detail?.contextWindow ?? null,
    max_input_tokens: null,
    max_output_tokens: detail?.maxOutputTokens ?? null,
    specification_source: detail?.specificationSource ?? "unavailable",
    pricing: detail?.pricing ?? [],
  });
}

interface CandidateDetail {
  contextWindow: number | null;
  maxOutputTokens: number | null;
  specificationSource: string;
  pricing: JsonRow[];
}

function resolveCandidateDetail(
  route: RouteRow,
  channelModels: ChannelModelRow[],
  identity: ModelIdentityIndex,
): CandidateDetail {
  const upstream = channelModels.find(
    (model) =>
      model.channel_id === route.channel_id &&
      identity.canonicalKey(model.model) === identity.canonicalKey(route.upstream_model),
  );
  const catalogMatch = identity.findModelsCnModel(route.upstream_model);
  const catalogModel = catalogMatch?.model ?? null;
  const catalogContext = num(catalogModel?.limits?.contextTokens) ?? null;
  const catalogOutput = num(catalogModel?.limits?.maxOutputTokens) ?? null;
  const upstreamContext = upstream?.context_window ?? null;
  const upstreamOutput = upstream?.max_output_tokens ?? null;

  let specificationSource = "unavailable";
  if (upstreamContext !== null || upstreamOutput !== null) {
    specificationSource =
      (upstreamContext === null && catalogContext !== null) ||
      (upstreamOutput === null && catalogOutput !== null)
        ? "upstream+models-cn"
        : "upstream";
  } else if (catalogContext !== null || catalogOutput !== null) {
    specificationSource = "models-cn";
  }

  let pricing: JsonRow[] = [];
  if (upstream?.pricing) {
    pricing = [
      {
        channel_id: route.channel_id,
        upstream_model: route.upstream_model,
        source: "upstream",
        raw: upstream.pricing,
      },
    ];
  } else if (catalogModel) {
    const price = selectModelsCnPrice(catalogModel);
    if (price) pricing = [pricingJson(route, price, catalogMatch?.retrievedAt ?? null)];
  }

  return {
    contextWindow: upstreamContext ?? catalogContext,
    maxOutputTokens: upstreamOutput ?? catalogOutput,
    specificationSource,
    pricing,
  };
}

function parseBound(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function priceAppliesAt(price: JsonRow, at: number): boolean {
  const from = parseBound(price.effectiveFrom);
  if (from !== undefined) {
    if (from === null || at < from) return false;
  }
  const to = parseBound(price.effectiveTo);
  if (to !== undefined) {
    if (to === null || at >= to) return false;
  }
  const range = price.dailyTimeRange;
  if (range === undefined || range === null) return true;
  if (!isRecord(range)) return false;
  const intervals = asArray(range.intervals).filter(isRecord);
  if (intervals.length === 0) return true;
  const timeZone = str(range.timeZone) ?? "UTC";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    }).formatToParts(new Date(at));
  } catch {
    return false;
  }
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value.toLowerCase() ?? "";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const weekday = get("weekday").slice(0, 3);
  const minutes = hour * 60 + minute;
  const parseTime = (value: unknown, allowEndOfDay: boolean): number | null => {
    if (typeof value !== "string") return null;
    if (allowEndOfDay && value === "24:00") return 24 * 60;
    const match = /^(\d{1,2}):(\d{2})$/.exec(value);
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    return h < 24 && m < 60 ? h * 60 + m : null;
  };
  return intervals.some((interval) => {
    const start = parseTime(interval.start, false);
    const end = parseTime(interval.end, true);
    if (start === null || end === null) return false;
    if (minutes < start || minutes >= end) return false;
    const days = asArray<unknown>(interval.days)
      .filter((day): day is string => typeof day === "string")
      .map((day) => day.trim().toLowerCase());
    return days.length === 0 || days.includes(weekday);
  });
}

function selectModelsCnPrice(model: JsonRow): JsonRow | null {
  const at = Date.now();
  let best: JsonRow | null = null;
  let bestScore = -1;
  for (const price of asArray(model.prices).filter(isRecord)) {
    if (!priceAppliesAt(price, at)) continue;
    const score =
      (str(price.market) === "china" ? 4 : 0) +
      (str(price.currency) === "CNY" ? 2 : 0) +
      (str(price.rateType) === "promotional" ? 1 : 0);
    if (score > bestScore) {
      best = price;
      bestScore = score;
    }
  }
  return best;
}

function pricingJson(route: RouteRow, price: JsonRow, retrievedAt: string | null): JsonRow {
  const input = isRecord(price.input) ? price.input : {};
  return {
    channel_id: route.channel_id,
    upstream_model: route.upstream_model,
    market: price.market ?? null,
    currency: price.currency ?? null,
    unit: price.unit ?? null,
    rate_type: price.rateType ?? null,
    daily_time_range: price.dailyTimeRange ?? null,
    effective_from: price.effectiveFrom ?? null,
    effective_to: price.effectiveTo ?? null,
    input: {
      standard: input.standard ?? null,
      cache_hit: input.cacheHit ?? null,
      explicit_cache_creation: input.explicitCacheCreation ?? null,
      explicit_cache_hit: input.explicitCacheHit ?? null,
    },
    output: price.output ?? null,
    source_url: price.sourceUrl ?? null,
    retrieved_at: retrievedAt,
    source: "models-cn",
  };
}