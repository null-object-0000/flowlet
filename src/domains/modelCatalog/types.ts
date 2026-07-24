/** models-cn API 类型定义。
 *  数据源：https://null-object-0000.github.io/models-cn/api.json
 *  接入规则见 docs/agent-integration-prompt.md。*/

export type ModelsCnMarket = "china" | "international";
export type ModelsCnCurrency = "CNY" | "USD";
export type ModelsCnRateType = "standard" | "promotional";
export type ModelsCnUnit = "1M_tokens";

/** 单个输入价格对象。`standard` 必须存在，其余字段可选。
 *  规则：仅在字段存在时才处理缓存命中价（docs/agent-integration-prompt.md §3）。 */
export interface ModelsCnInputPrice {
  standard: number;
  cacheHit?: number;
  explicitCacheCreation?: number;
  explicitCacheHit?: number;
}

export interface ModelsCnPrice {
  market: ModelsCnMarket;
  currency: ModelsCnCurrency;
  unit: ModelsCnUnit;
  rateType: ModelsCnRateType;
  inputTokenRange?: { label: string; maxInclusive?: number; minExclusive?: number };
  input: ModelsCnInputPrice;
  output: number;
  sourceUrl: string;
}

export interface ModelsCnCapabilities {
  thinking?: boolean;
  jsonOutput?: boolean;
  toolCalls?: boolean;
  chatPrefixCompletion?: boolean;
  fimCompletion?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  supportedParameters?: string[];
}

export interface ModelsCnLimits {
  contextTokens?: number;
  maxOutputTokens?: number;
  concurrency?: number;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
}

export interface ModelsCnAlias {
  id: string;
  mode: string;
  deprecatedAt?: string;
}

export interface ModelsCnModel {
  id: string;
  name: string;
  createdAt?: string;
  tokenizer?: string;
  aliases: ModelsCnAlias[];
  capabilities?: ModelsCnCapabilities;
  limits?: ModelsCnLimits;
  prices: ModelsCnPrice[];
}

export interface ModelsCnSource {
  url: string;
  kind: string;
  locale: string;
  currency?: string;
  retrievedAt: string;
  contentHash: string;
}

export interface ModelsCnProvider {
  schemaVersion: string;
  health: { status: string; lastSuccessfulAt: string; lastAttemptAt: string; consecutiveFailures: number };
  id: string;
  name: string;
  displayNames?: Record<string, string>;
  ownedBy: string;
  baseUrls?: { openai?: string; anthropic?: string };
  models: ModelsCnModel[];
  sources: ModelsCnSource[];
}

/** models.dev 校准条目。仅用于官方字段缺失时的补全，不得覆盖官方值。 */
export interface ModelsCnCalibrationModel {
  provider: string;
  model: string;
  referenceProvider: string;
  referenceModel: string;
  referenceUrl: string;
  status: "match" | "partial" | "mismatch";
  checks: { field: string; official: unknown; reference: unknown; status: "match" | "mismatch" | "missing" }[];
}

export interface ModelsCnCatalog {
  schemaVersion: string;
  providers: ModelsCnProvider[];
  inventories: unknown[];
  calibration: { modelsDev: { models: ModelsCnCalibrationModel[] } };
}

/** 解析后的标准化模型详情（跨 provider 归一化）。 */
export interface ResolvedModelLimits {
  contextTokens: number | null;
  maxOutputTokens: number | null;
}

export interface ResolvedModelCapabilities {
  thinking: boolean;
  toolCalls: boolean;
  jsonOutput: boolean;
}

/** 单条已选价格（已按 docs/agent-integration-prompt.md §2 规则选取）。 */
export interface ResolvedPrice {
  market: ModelsCnMarket;
  currency: ModelsCnCurrency;
  unit: ModelsCnUnit;
  rateType: ModelsCnRateType;
  inputUncached: number;
  /** 缓存命中价。仅在官方 input.cacheHit 存在时有值。 */
  inputCached: number | null;
  inputCacheWrite: number | null;
  output: number;
  sourceUrl: string;
  /** 来源抓取时间（来自 provider.sources 的 retrievedAt）。 */
  retrievedAt: string | null;
}

/** 完整解析结果：模型 + 官方价格。 */
export interface ResolvedModel {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  limits: ResolvedModelLimits;
  capabilities: ResolvedModelCapabilities;
  aliases: ModelsCnAlias[];
  /** 按规则选取的官方价格。若官方无价格则为 null。 */
  officialPrice: ResolvedPrice | null;
  /** 所有市场价（用于展示多市场信息）。 */
  allPrices: ModelsCnPrice[];
  /** 是否使用了 models.dev 补全（仅字段缺失时）。 */
  supplementedFromModelsDev: boolean;
  /** models.dev 参考链接（补全时有值）。 */
  modelsDevReferenceUrl: string | null;
}
