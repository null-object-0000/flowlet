/** models-cn 价格选取与费用估算的纯函数。
 *  无副作用、无网络请求、无全局时钟，便于单元测试。
 *  规则见 docs/agent-integration-prompt.md。*/

import type {
  ModelsCnModel,
  ModelsCnPrice,
  ModelsCnProvider,
  ResolvedModel,
  ResolvedModelCapabilities,
  ResolvedModelLimits,
  ResolvedPrice,
} from "./types";

/** 价格选取优先级评分。分数越高越优先。
 *  规则：china > international，CNY > USD，promotional > standard。
 *  promotional 优先：厂商当前生效的是促销价（如 LongCat-2.0 的
 *  输入 2 / 缓存命中 0.04 / 输出 8），standard 仅作兜底参考。 */
function priceScore(price: ModelsCnPrice): number {
  let score = 0;
  if (price.market === "china") score += 4;
  if (price.currency === "CNY") score += 2;
  if (price.rateType === "promotional") score += 1;
  return score;
}

function parsedBound(value: string | undefined): number | null {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** 厂商公告的绝对生效窗口，采用 [effectiveFrom, effectiveTo)。 */
export function isPriceEffectiveAt(price: ModelsCnPrice, at: Date): boolean {
  const timestamp = at.getTime();
  const from = parsedBound(price.effectiveFrom);
  const to = parsedBound(price.effectiveTo);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  return (from == null || timestamp >= from) && (to == null || timestamp < to);
}

function parseClockMinute(value: string, allowEndOfDay: boolean): number | null {
  if (allowEndOfDay && value === "24:00") return 24 * 60;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

/** 将 UTC 时刻投影到价格声明的 IANA 时区，判断是否位于任一 [start, end) 区间。 */
export function isDailyTimeRangeActiveAt(
  range: NonNullable<ModelsCnPrice["dailyTimeRange"]>,
  at: Date,
): boolean {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: range.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
  } catch {
    return false;
  }
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const current = hour * 60 + minute;
  return range.intervals.some((interval) => {
    const start = parseClockMinute(interval.start, false);
    const end = parseClockMinute(interval.end, true);
    if (start == null || end == null) return false;
    return end > start
      ? current >= start && current < end
      : current >= start || current < end;
  });
}

/** 当前时刻真正可用于计价的一条价格，绝对生效窗口与每日时段必须同时命中。 */
export function isPriceActiveAt(price: ModelsCnPrice, at: Date): boolean {
  return isPriceEffectiveAt(price, at)
    && (price.dailyTimeRange == null || isDailyTimeRangeActiveAt(price.dailyTimeRange, at));
}

/** 当前绝对生效窗口内的全部价格；保留同一窗口下的峰/闲时段供 UI 完整展示。 */
export function effectiveWindowPricesAt(prices: ModelsCnPrice[], at: Date): ModelsCnPrice[] {
  return prices.filter((price) => isPriceEffectiveAt(price, at));
}

/** 下一批即将生效的价格。同一 effectiveFrom 的峰谷条目作为一组返回。 */
export function nextEffectivePricesAt(prices: ModelsCnPrice[], at: Date): ModelsCnPrice[] {
  const timestamp = at.getTime();
  const starts = prices
    .map((price) => parsedBound(price.effectiveFrom))
    .filter((value): value is number => value != null && Number.isFinite(value) && value > timestamp);
  if (starts.length === 0) return [];
  const next = Math.min(...starts);
  return prices.filter((price) => parsedBound(price.effectiveFrom) === next);
}

/** 从一组价格中按规则选取最优官方价格。
 *  纯函数：不修改输入，无副作用。
 *  规则见 docs/agent-integration-prompt.md §2。 */
export function selectOfficialPrice(prices: ModelsCnPrice[], at = new Date()): ResolvedPrice | null {
  const activePrices = prices.filter((price) => isPriceActiveAt(price, at));
  if (activePrices.length === 0) return null;
  let best: ModelsCnPrice | null = null;
  let bestScore = -Infinity;
  for (const price of activePrices) {
    const score = priceScore(price);
    if (score > bestScore) {
      bestScore = score;
      best = price;
    }
  }
  if (!best) return null;
  return resolvePrice(best);
}

/** 将单条 models-cn 价格归一化为 ResolvedPrice。
 *  仅在 input.cacheHit 存在时才填充 inputCached（docs/agent-integration-prompt.md §3）。 */
export function resolvePrice(price: ModelsCnPrice): ResolvedPrice {
  return {
    market: price.market,
    currency: price.currency,
    unit: price.unit,
    rateType: price.rateType,
    dailyTimeRange: price.dailyTimeRange ?? null,
    effectiveFrom: price.effectiveFrom ?? null,
    effectiveTo: price.effectiveTo ?? null,
    inputUncached: price.input.standard,
    inputCached: price.input.cacheHit ?? null,
    inputCacheWrite: price.input.explicitCacheCreation ?? null,
    inputCacheHit: price.input.explicitCacheHit ?? null,
    output: price.output,
    sourceUrl: price.sourceUrl,
    retrievedAt: null,
  };
}

/** 是否存在可展示的真实优惠。
 *  只有数据明确标记为 promotional，且标准价确实高于当前价时才显示划线原价；
 *  相等、涨价、非有限数值或浮点误差范围内的差异都不视为优惠。 */
export function isPromotionalDiscount(
  rateType: ModelsCnPrice["rateType"],
  standardAmount: number,
  currentAmount: number,
): boolean {
  if (
    rateType !== "promotional"
    || !Number.isFinite(standardAmount)
    || !Number.isFinite(currentAmount)
  ) {
    return false;
  }
  const tolerance = Math.max(Math.abs(standardAmount), Math.abs(currentAmount), 1) * 1e-9;
  return standardAmount - currentAmount > tolerance;
}

/** 同一输入区间下合并后的展示价格。促销价作为当前价，标准价仅用于真实优惠划价。 */
export interface PricingStrategyRow {
  key: string;
  inputTokenRange: ModelsCnPrice["inputTokenRange"] | null;
  current: ModelsCnPrice;
  standard: ModelsCnPrice | null;
}

/** 将同市场、币种下的 prices[] 按输入区间合并成完整价格策略。
 *  models-cn 会把 standard / promotional 作为两条记录返回；UI 不应重复两行，
 *  而应在同一格中展示当前促销价及（确有降价时）标准原价。 */
export function buildPricingStrategyRows(
  prices: ModelsCnPrice[],
  market: ModelsCnPrice["market"],
  currency: ModelsCnPrice["currency"],
): PricingStrategyRow[] {
  const groups = new Map<string, ModelsCnPrice[]>();
  for (const price of prices) {
    if (price.market !== market || price.currency !== currency) continue;
    const range = price.inputTokenRange;
    const key = JSON.stringify([
      price.unit,
      range?.minExclusive ?? null,
      range?.maxInclusive ?? null,
      range?.label ?? "",
      price.effectiveFrom ?? null,
      price.effectiveTo ?? null,
      price.dailyTimeRange ?? null,
    ]);
    const group = groups.get(key);
    if (group) group.push(price);
    else groups.set(key, [price]);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const promotional = group.find((price) => price.rateType === "promotional");
      const standard = group.find((price) => price.rateType === "standard") ?? null;
      const current = promotional ?? standard ?? group[0];
      return {
        key,
        inputTokenRange: current.inputTokenRange ?? null,
        current,
        standard: promotional ? standard : null,
      };
    })
    .sort((a, b) => {
      const aMin = a.inputTokenRange?.minExclusive ?? -1;
      const bMin = b.inputTokenRange?.minExclusive ?? -1;
      if (aMin !== bMin) return aMin - bMin;
      return (a.inputTokenRange?.maxInclusive ?? Number.MAX_SAFE_INTEGER)
        - (b.inputTokenRange?.maxInclusive ?? Number.MAX_SAFE_INTEGER);
    });
}

/** 是否存在按输入长度分段计价（即存在 inputTokenRange 条目）。
 *  仅此时才应展示「按输入长度分段计价」标题——仅因显式缓存价格（explicitCache*
 *  字段）进入策略卡片的单行「全部输入」场景不算分段，避免标题误导。 */
export function hasInputLengthTiers(rows: readonly PricingStrategyRow[]): boolean {
  return rows.some((row) => row.inputTokenRange != null);
}

/** 解析模型能力。缺失字段默认 false（保守降级）。 */
export function resolveCapabilities(capabilities: ModelsCnModel["capabilities"]): ResolvedModelCapabilities {
  return {
    thinking: capabilities?.thinking ?? false,
    toolCalls: capabilities?.toolCalls ?? false,
    jsonOutput: capabilities?.jsonOutput ?? false,
  };
}

/** 解析模型限制。缺失字段为 null。 */
export function resolveLimits(limits: ModelsCnModel["limits"]): ResolvedModelLimits {
  return {
    contextTokens: limits?.contextTokens ?? null,
    maxOutputTokens: limits?.maxOutputTokens ?? null,
  };
}

/** 查找 provider 的最早 retrievedAt（用于展示抓取时间）。 */
export function providerRetrievedAt(provider: ModelsCnProvider): string | null {
  let earliest: string | null = null;
  for (const source of provider.sources) {
    if (source.kind !== "pricing") continue;
    if (!earliest || source.retrievedAt < earliest) earliest = source.retrievedAt;
  }
  return earliest;
}

/** 解析单个模型为 ResolvedModel。
 *  纯函数：不修改输入。officialPrice 为 null 表示官方无价格。
 *  `supplemented` 标记是否使用了 models.dev 补全（由调用方根据 calibration 设置）。 */
export function resolveModel(
  provider: ModelsCnProvider,
  model: ModelsCnModel,
  options: { supplemented?: boolean; modelsDevReferenceUrl?: string | null; at?: Date } = {},
): ResolvedModel {
  const officialPrice = selectOfficialPrice(model.prices, options.at);
  if (officialPrice) officialPrice.retrievedAt = providerRetrievedAt(provider);
  return {
    providerId: provider.id,
    providerName: provider.displayNames?.["zh-CN"] ?? provider.name,
    modelId: model.id,
    modelName: model.name,
    limits: resolveLimits(model.limits),
    capabilities: resolveCapabilities(model.capabilities),
    aliases: model.aliases ?? [],
    officialPrice,
    allPrices: model.prices,
    supplementedFromModelsDev: options.supplemented ?? false,
    modelsDevReferenceUrl: options.modelsDevReferenceUrl ?? null,
  };
}

/** 费用估算输入。cacheHit 为 true 时使用缓存命中价。 */
export interface CostEstimateInput {
  inputTokens: number;
  outputTokens: number;
  /** 是否使用缓存命中价。仅在官方 input.cacheHit 存在时生效。 */
  useCache?: boolean;
}

/** 费用估算结果。 */
export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
  unit: string;
  /** 是否使用了缓存命中价。 */
  cacheApplied: boolean;
  /** 每百万 token 的输入单价（用于展示）。 */
  inputRate: number;
  outputRate: number;
}

/** 纯函数：按已选价格估算费用。
 *  规则：
 *  - 输入费用 = inputTokens / 1_000_000 * inputRate
 *  - 输出费用 = outputTokens / 1_000_000 * outputRate
 *  - 仅当 useCache === true 且 officialPrice.inputCached 非 null 时使用缓存价。
 *  - 若官方无价格，返回 null。 */
export function estimateCost(price: ResolvedPrice, input: CostEstimateInput): CostEstimate | null {
  const cacheApplied = input.useCache === true && price.inputCached != null;
  const inputRate = cacheApplied ? (price.inputCached as number) : price.inputUncached;
  const inputCost = (input.inputTokens / 1_000_000) * inputRate;
  const outputCost = (input.outputTokens / 1_000_000) * price.output;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    currency: price.currency,
    unit: price.unit,
    cacheApplied,
    inputRate,
    outputRate: price.output,
  };
}

/** 在 catalog 中按 (providerId, modelId) 查找模型。
 *  纯函数：接受已解析的 ModelsCnCatalog。 */
export function findModelInCatalog(
  catalog: { providers: ModelsCnProvider[] },
  providerId: string,
  modelId: string,
): { provider: ModelsCnProvider; model: ModelsCnModel } | null {
  for (const provider of catalog.providers) {
    if (provider.id !== providerId) continue;
    const model = provider.models.find((m) => m.id === modelId);
    if (model) return { provider, model };
  }
  return null;
}

/** 在 catalog 中按 modelId 模糊匹配（含别名）。 */
export function findModelByAlias(
  catalog: { providers: ModelsCnProvider[] },
  modelId: string,
): { provider: ModelsCnProvider; model: ModelsCnModel } | null {
  const normalized = modelId.trim().toLowerCase();
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      if (model.id.toLowerCase() === normalized) return { provider, model };
      if (model.aliases.some((a) => a.id.toLowerCase() === normalized)) return { provider, model };
    }
  }
  return null;
}

/** Flowlet 聚合模型（flowlet-pro / flowlet-flash）下属已启用路由的渠道+上游模型。 */
export type AggregateSubModel = {
  channelId: string;
  upstreamModel: string;
};

/** 聚合模型的 limits：取旗下所有已启用子模型的最小值（木桶效应——聚合模型能
 *  保证的能力上限由最弱的子模型决定）。null 视为无穷大，不参与 min。 */
export function aggregateMinLimits(subModels: ResolvedModel[]): ResolvedModelLimits {
  let contextTokens: number | null = null;
  let maxOutputTokens: number | null = null;
  for (const m of subModels) {
    if (m.limits.contextTokens != null) contextTokens = contextTokens == null ? m.limits.contextTokens : Math.min(contextTokens, m.limits.contextTokens);
    if (m.limits.maxOutputTokens != null) maxOutputTokens = maxOutputTokens == null ? m.limits.maxOutputTokens : Math.min(maxOutputTokens, m.limits.maxOutputTokens);
  }
  return { contextTokens, maxOutputTokens };
}

/** 聚合模型的能力：取旗下所有已启用子模型的交集——只有全部子模型都支持的能力
 *  才会对外展示为"支持"（聚合模型不能承诺任何单一子模型做不到的事）。 */
export function aggregateCapabilitiesIntersection(subModels: ResolvedModel[]): ResolvedModelCapabilities {
  return {
    thinking: subModels.length > 0 && subModels.every((m) => m.capabilities.thinking),
    toolCalls: subModels.length > 0 && subModels.every((m) => m.capabilities.toolCalls),
    jsonOutput: subModels.length > 0 && subModels.every((m) => m.capabilities.jsonOutput),
  };
}

/** 聚合模型的价格：取旗下所有已启用子模型的最大值（展示最坏情况下的成本上限）。
 *  仅当所有子模型都使用同一币种时返回有效价格，币种混杂返回 null。 */
export function aggregateMaxPrice(subModels: ResolvedModel[]): ResolvedPrice | null {
  const withPrice = subModels.filter((m) => m.officialPrice != null);
  if (withPrice.length === 0) return null;
  // 币种必须一致，否则无法做有意义的聚合。
  const firstCurrency = withPrice[0].officialPrice!.currency;
  if (!withPrice.every((m) => m.officialPrice!.currency === firstCurrency)) return null;
  const maxInputUncached = Math.max(...withPrice.map((m) => m.officialPrice!.inputUncached));
  const maxOutput = Math.max(...withPrice.map((m) => m.officialPrice!.output));
  // 缓存价：仅当全部子模型都有该字段才聚合，否则视为 null。
  const allCacheHit = withPrice.every((m) => m.officialPrice!.inputCached != null);
  const allCacheWrite = withPrice.every((m) => m.officialPrice!.inputCacheWrite != null);
  const allCacheHitExplicit = withPrice.every((m) => m.officialPrice!.inputCacheHit != null);
  const maxCacheHit = allCacheHit ? Math.max(...withPrice.map((m) => m.officialPrice!.inputCached as number)) : null;
  const maxCacheWrite = allCacheWrite ? Math.max(...withPrice.map((m) => m.officialPrice!.inputCacheWrite as number)) : null;
  const maxCacheHitExplicit = allCacheHitExplicit ? Math.max(...withPrice.map((m) => m.officialPrice!.inputCacheHit as number)) : null;
  // 任一子模型是 promotional 则聚合视为 promotional（更贴近用户真实负担）。
  const anyPromotional = withPrice.some((m) => m.officialPrice!.rateType === "promotional");
  // 任一子模型是 china 则聚合视为 china（Flowlet 仅服务国内）。
  const anyChina = withPrice.some((m) => m.officialPrice!.market === "china");
  const sample = withPrice[0].officialPrice!;
  return {
    market: anyChina ? "china" : sample.market,
    currency: firstCurrency,
    unit: sample.unit,
    rateType: anyPromotional ? "promotional" : "standard",
    dailyTimeRange: null,
    effectiveFrom: null,
    effectiveTo: null,
    inputUncached: maxInputUncached,
    inputCached: maxCacheHit,
    inputCacheWrite: maxCacheWrite,
    inputCacheHit: maxCacheHitExplicit,
    output: maxOutput,
    sourceUrl: sample.sourceUrl,
    retrievedAt: null,
  };
}

/** 聚合模型的 standard 价格（用于划价展示）。同 aggregateMaxPrice 取 max，但从
 *  各子模型的 standard 价格中聚合。币种混杂返回 null。 */
export function aggregateMaxStandardPrice(subModels: ResolvedModel[], at = new Date()): ResolvedPrice | null {
  const stdPrices = subModels
    .map((model) => selectOfficialPrice(
      (model.allPrices ?? []).filter((price) => price.rateType === "standard"),
      at,
    ))
    .filter((price): price is ResolvedPrice => price != null);
  if (stdPrices.length === 0) return null;
  const firstCurrency = stdPrices[0].currency;
  if (!stdPrices.every((price) => price.currency === firstCurrency)) return null;
  const maxInputUncached = Math.max(...stdPrices.map((price) => price.inputUncached));
  const maxOutput = Math.max(...stdPrices.map((price) => price.output));
  const allCacheHit = stdPrices.every((price) => price.inputCached != null);
  const maxCacheHit = allCacheHit ? Math.max(...stdPrices.map((price) => price.inputCached as number)) : null;
  const sample = stdPrices[0];
  return {
    market: sample.market,
    currency: firstCurrency,
    unit: sample.unit,
    rateType: "standard",
    dailyTimeRange: null,
    effectiveFrom: null,
    effectiveTo: null,
    inputUncached: maxInputUncached,
    inputCached: maxCacheHit,
    inputCacheWrite: null,
    inputCacheHit: null,
    output: maxOutput,
    sourceUrl: sample.sourceUrl,
    retrievedAt: null,
  };
}
