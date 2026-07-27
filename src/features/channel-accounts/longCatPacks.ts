export type LongCatPack = {
  lotId?: string | number;
  packageId?: string | number;
  bizOrderNo?: string;
  packageName?: string;
  totalToken?: number;
  consumedToken?: number;
  remainingToken?: number;
  frozenToken?: number;
  consumedRatio?: number;
  effectiveTime?: string;
  expireTime?: string;
  remainSeconds?: number;
  consumeOrder?: number;
  modelScope?: string;
  status?: string;
  statusCode?: number;
  statusText?: string;
  displayStatusCode?: number;
  displayStatusText?: string;
  source?: string;
  sourceTypeCode?: number;
  sourceTypeText?: string;
  grantCategory?: string;
  _fromList?: boolean;
};

export function parseStoredLongCatPacks(value?: string | null): LongCatPack[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as LongCatPack[] : [];
  } catch {
    return [];
  }
}

export function sortLongCatPacks(packs: LongCatPack[]) {
  return [...packs].sort((a, b) => {
    if (!a.expireTime && !b.expireTime) return 0;
    if (!a.expireTime) return 1;
    if (!b.expireTime) return -1;
    return a.expireTime.localeCompare(b.expireTime);
  });
}

export function summarizeLongCatPacks(packs: LongCatPack[]) {
  const active = packs.filter((pack) => !pack.status || pack.status === "ACTIVE");
  const source = active.length ? active : packs;
  return source.reduce(
    (summary, pack) => ({
      total: summary.total + (pack.totalToken ?? 0),
      used: summary.used + (pack.consumedToken ?? 0),
      remaining: summary.remaining + (pack.remainingToken ?? 0),
      expireAt: pack.expireTime && (!summary.expireAt || pack.expireTime < summary.expireAt) ? pack.expireTime : summary.expireAt,
    }),
    { total: 0, used: 0, remaining: 0, expireAt: null as string | null },
  );
}
