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
  };
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
