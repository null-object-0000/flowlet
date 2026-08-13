import type { ReactNode } from "react";
import { Tooltip } from "@douyinfe/semi-ui-19";
import { formatCostAmount, type CostAmountValue } from "../formatters/cost";
import styles from "./TokenBreakdownTooltip.module.css";

type ApiEquivalentCost = CostAmountValue & {
  inputUncachedAmount?: number | null;
  inputCachedAmount?: number | null;
  inputCacheWriteAmount?: number | null;
  outputAmount?: number | null;
};

type Props = {
  children: ReactNode;
  /** 总费用（用于无 breakdown 兜底）。 */
  total: number | null;
  inputUncached?: number | null;
  inputCached?: number | null;
  inputCacheWrite?: number | null;
  output?: number | null;
  currency: string;
  /** 原生会话的 API 等价价值（无 breakdown 时展示）。 */
  apiEquivalent?: ApiEquivalentCost | null;
  t: (source: string, variables?: Record<string, string | number>) => string;
};

export function CostBreakdownTooltip({ children, total, inputUncached, inputCached, inputCacheWrite, output, currency, apiEquivalent, t }: Props) {
  const resolvedCurrency = apiEquivalent?.currency ?? currency;
  const resolvedTotal = apiEquivalent?.amount ?? total;
  const resolvedInputUncached = inputUncached ?? apiEquivalent?.inputUncachedAmount;
  const resolvedInputCached = inputCached ?? apiEquivalent?.inputCachedAmount;
  const resolvedInputCacheWrite = inputCacheWrite ?? apiEquivalent?.inputCacheWriteAmount;
  const resolvedOutput = output ?? apiEquivalent?.outputAmount;
  const fmt = (v: number | null | undefined) => formatCostAmount({ amount: v ?? null, currency: resolvedCurrency }, 4);
  const hasBreakup = resolvedInputUncached != null || resolvedInputCached != null || resolvedInputCacheWrite != null || resolvedOutput != null;
  return (
    <Tooltip
      showArrow
      content={(
        <div className={styles.breakdown}>
          <strong>{apiEquivalent?.amount != null ? t("API 等价价值") : t("总费用")} {fmt(resolvedTotal)}</strong>
          {hasBreakup ? (
            <>
              {resolvedInputUncached != null ? <span><small>{t("未缓存输入")}</small><b>{fmt(resolvedInputUncached)}</b></span> : null}
              {resolvedInputCached != null ? <span><small>{t("缓存命中")}</small><b>{fmt(resolvedInputCached)}</b></span> : null}
              {resolvedInputCacheWrite != null ? <span><small>{t("缓存写入")}</small><b>{fmt(resolvedInputCacheWrite)}</b></span> : null}
              {resolvedOutput != null ? <span><small>{t("输出")}</small><b>{fmt(resolvedOutput)}</b></span> : null}
            </>
          ) : null}
        </div>
      )}
    >
      {children}
    </Tooltip>
  );
}
