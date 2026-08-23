import type { CodexRateLimitResetCredit, CodexRateLimitResetCredits } from "../../domains/agent/types";

type JsonRecord = Record<string, unknown>;

export type QwenQuotaWindow = {
  total: number;
  used: number;
  remaining: number;
  remainingPercent: number;
  resetAt: string | null;
};

export type QwenTokenPlanDetails = {
  specCode: string;
  status: string | null;
  autoRenew: boolean | null;
  remainingDays: number | null;
  startAt: string | null;
  expireAt: string | null;
  fiveHour: QwenQuotaWindow | null;
  sevenDay: QwenQuotaWindow | null;
  /** 重置卡列表，字段结构与 Codex 重置机会对齐；无生效中的卡时为 null。 */
  resetCards: CodexRateLimitResetCredits | null;
};

export function parseQwenTokenPlanDetails(raw?: string | null): QwenTokenPlanDetails | null {
  if (!raw) return null;
  let bundle: JsonRecord;
  try {
    bundle = JSON.parse(raw) as JsonRecord;
  } catch {
    return null;
  }

  const subscription = responseData(bundle.subscription);
  const quotaConfig = responseData(bundle.quota_config);
  const usage = responseData(bundle.usage);
  if (!subscription || !quotaConfig || !usage) return null;

  const specCode = stringValue(subscription.specCode) ?? "standard";
  const tier = recordValue(quotaConfig[specCode]) ?? recordValue(quotaConfig.standard);
  if (!tier) return null;

  return {
    specCode,
    status: stringValue(subscription.status),
    autoRenew: booleanValue(subscription.autoRenewFlag),
    remainingDays: numberValue(subscription.remainingDays),
    startAt: timestampValue(subscription.startTime),
    expireAt: timestampValue(subscription.endTime),
    fiveHour: quotaWindow(
      numberValue(tier.five_hour),
      numberValue(usage.per5HourPercentage),
      usage.per5HourResetTime,
    ),
    sevenDay: quotaWindow(
      numberValue(tier.weekly),
      numberValue(usage.per1WeekPercentage),
      usage.per1WeekResetTime,
    ),
    resetCards: parseQwenResetCards(bundle.reset_card_list),
  };
}

/** 订阅是否有效：接口明确返回非 VALID（EXPIRED 等）时为无效。
 *  旧快照/接口未返回 status 时按有效处理（向后兼容）。 */
export function isQwenSubscriptionActive(details: QwenTokenPlanDetails | null | undefined): boolean {
  if (!details) return false;
  const status = details.status?.trim().toUpperCase();
  return status == null || status === "" || status === "VALID";
}

/** 无效订阅的展示口径："expired" = 套餐已过期；"missing" = 未订阅（含未知状态）。 */
export function qwenSubscriptionInactiveKind(
  details: QwenTokenPlanDetails | null | undefined,
): "expired" | "missing" {
  return details?.status?.trim().toUpperCase() === "EXPIRED" ? "expired" : "missing";
}

/** 重置卡列表是可选项槽位：`/tokenplan/personal/api/v2/reset-card/list` 有响应时
 *  进入数据 bundle，无卡/无响应时返回 null 且不阻断订阅同步。只保留生效中的卡
 *  （now >= effectiveAt && now < expiresAt），字段结构与 Codex 重置机会对齐：
 *  cardNo → id、cardType → reset_type、effectiveAt → granted_at、expiresAt → expires_at。 */
function parseQwenResetCards(value: unknown, nowMs = Date.now()): CodexRateLimitResetCredits | null {
  const items = resetCardItems(unwrapResetCardList(value));
  if (items.length === 0) return null;
  const credits: CodexRateLimitResetCredit[] = [];
  for (const card of items) {
    const grantedAt = epochMs(card.effectiveAt);
    const expiresAt = epochMs(card.expiresAt);
    if (grantedAt == null || expiresAt == null) continue;
    if (nowMs < grantedAt || nowMs >= expiresAt) continue;
    credits.push({
      id: stringValue(card.cardNo) ?? String(credits.length + 1),
      reset_type: stringValue(card.cardType),
      status: stringValue(card.status) ?? "ACTIVE",
      granted_at: grantedAt,
      expires_at: expiresAt,
      title: null,
    });
  }
  if (credits.length === 0) return null;
  return { available_count: credits.length, credits };
}

/** 逐层解开 token-plan 接口的 data.DataV2.data.data 信封；最内层 data 可能是
 *  卡片数组（responseData 只能返回对象，不能直接复用）。 */
function unwrapResetCardList(value: unknown): unknown {
  const root = recordValue(value);
  const data = recordValue(root?.data);
  const dataV2 = recordValue(data?.DataV2);
  const envelope = recordValue(dataV2?.data);
  if (envelope != null && "data" in envelope) return envelope.data;
  return envelope?.data ?? dataV2?.data ?? data?.data ?? data ?? root;
}

function resetCardItems(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value as JsonRecord[];
  const record = recordValue(value);
  if (!record) return [];
  for (const key of ["list", "items", "records", "cards", "cardList", "result"]) {
    const child = record[key];
    if (Array.isArray(child)) return child as JsonRecord[];
  }
  return [];
}

function responseData(value: unknown): JsonRecord | null {
  const root = recordValue(value);
  const data = recordValue(root?.data);
  const dataV2 = recordValue(data?.DataV2);
  const envelope = recordValue(dataV2?.data);
  return recordValue(envelope?.data);
}

function quotaWindow(total: number | null, consumedRatio: number | null, resetValue: unknown): QwenQuotaWindow | null {
  if (total == null || consumedRatio == null) return null;
  const normalizedRatio = Math.min(1, Math.max(0, consumedRatio > 1 ? consumedRatio / 100 : consumedRatio));
  const used = Math.round(total * normalizedRatio);
  const remaining = Math.max(0, total - used);
  return {
    total,
    used,
    remaining,
    remainingPercent: Math.max(0, Math.min(100, (1 - normalizedRatio) * 100)),
    resetAt: timestampValue(resetValue),
  };
}

function recordValue(value: unknown): JsonRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
}

function timestampValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 ? new Date(value).toISOString() : null;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  return null;
}

/** 重置卡时间归一化为 epoch 毫秒：数字优先按毫秒处理，秒级时间戳（< 1e11）自动换算。 */
function epochMs(value: unknown): number | null {
  const number = numberValue(value);
  if (number != null) {
    return number > 1e11 ? number : number * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  return null;
}
