import type { ModelSyncResult } from "../../domains/account/types";

export type ModelCandidate = ModelSyncResult["models"][number];

// OpenRouter /models Pricing 对象中会产生实际费用的字段。min_context 等分档阈值
// 不是价格，不能参与免费判断。
const BILLABLE_PRICING_KEYS = [
  "prompt",
  "completion",
  "request",
  "image",
  "web_search",
  "internal_reasoning",
  "input_cache_read",
  "input_cache_write",
] as const;

/** 仅在 OpenRouter 明确给出零价输入、输出，且所有已声明计费项均为 0 时判定免费。
 *  缺失或无法解析的价格保持“未知/非免费”，避免错误承诺。 */
export function isFreeModelPricing(pricing: ModelCandidate["pricing"]): boolean {
  const tiers = Array.isArray(pricing) ? pricing : pricing ? [pricing] : [];
  if (tiers.length === 0) return false;

  const base = tiers[0];
  if (!isZeroPrice(base.prompt) || !isZeroPrice(base.completion)) return false;

  return tiers.every((tier) => BILLABLE_PRICING_KEYS.every((key) => {
    if (!(key in tier) || tier[key] == null) return true;
    return isZeroPrice(tier[key]);
  }));
}

function isZeroPrice(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === 0;
}

/** 排序优先级：免费且支持 > 付费且支持 > 免费但不支持 > 付费/未知且不支持。
 *  `freeOverride` 用于非 OpenRouter 渠道（如千问按量付费福利页）按抓取的免费额度
 *  覆盖价格判断；缺省时仍按 /models 返回的 pricing 判定。 */
export function modelCandidateSortRank(candidate: ModelCandidate, supported: boolean, freeOverride?: boolean): number {
  const free = freeOverride ?? isFreeModelPricing(candidate.pricing);
  if (supported) return free ? 0 : 1;
  return free ? 2 : 3;
}

