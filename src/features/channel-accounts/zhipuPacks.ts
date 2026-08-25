/**
 * Z.AI（智谱 BigModel）API 按量付费的资源包（额度包）解析。
 *
 * 资源包由官方控制台的资源包管理页 `GET /api/biz/tokenAccounts/list/my` 抓取，
 * Rust 侧 extractor 已把 `rows` 归一化为数组写入 `AccountBalanceSnapshot.token_packs`。
 * 单个资源包字段：
 * - packageId / tokenNo：资源包标识
 * - packageName：资源包名称（如「【实名认证】500万GLM-4.7体验包」）
 * - totalToken / consumedToken / remainingToken：总量 / 已用 / 剩余
 * - consumeType：TOKENS（按 tokens 计费）或 TIMES（按次计费）
 * - status：EFFECTIVE（生效中）/ EXPIRED（已失效）
 * - suitableModel / suitableScene：适用模型与场景
 * - effectiveTime / expireTime：生效时间 / 到期时间
 */
export type ZhipuPack = {
  packageId?: string;
  tokenNo?: string;
  packageName?: string;
  totalToken?: number;
  consumedToken?: number;
  remainingToken?: number;
  frozenToken?: number;
  consumeType?: string;
  suitableModel?: string;
  suitableScene?: string;
  status?: string;
  statusText?: string;
  type?: string;
  effectiveTime?: string | null;
  expireTime?: string | null;
  purchaseTime?: string | null;
};

export function parseStoredZhipuPacks(value?: string | null): ZhipuPack[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as ZhipuPack[]) : [];
  } catch {
    return [];
  }
}

export type ZhipuPackSummary = {
  total: number;
  used: number;
  remaining: number;
  expireAt: string | null;
  effectivePackCount: number;
};

/** 汇总生效中、按 tokens 计费的资源包（用于卡片/概览的主列与副列）。
 *  按次计费的资源包不参与 token 汇总，只在明细表中逐条展示。 */
export function summarizeZhipuPacks(packs: ZhipuPack[]): ZhipuPackSummary {
  const effective = packs.filter(
    (pack) => pack.status === "EFFECTIVE" && (pack.consumeType ?? "TOKENS") === "TOKENS",
  );
  return effective.reduce<ZhipuPackSummary>(
    (summary, pack) => ({
      total: summary.total + (pack.totalToken ?? 0),
      used: summary.used + (pack.consumedToken ?? 0),
      remaining: summary.remaining + (pack.remainingToken ?? 0),
      expireAt:
        pack.expireTime && (!summary.expireAt || pack.expireTime < summary.expireAt)
          ? pack.expireTime
          : summary.expireAt,
      effectivePackCount: summary.effectivePackCount + 1,
    }),
    { total: 0, used: 0, remaining: 0, expireAt: null, effectivePackCount: 0 },
  );
}
