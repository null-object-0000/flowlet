import type { ReactNode } from "react";
import { Tooltip } from "@douyinfe/semi-ui-19";
import { formatCostAmount, type CostAmountValue } from "../formatters/cost";
import styles from "./TokenBreakdownTooltip.module.css";

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
  apiEquivalent?: CostAmountValue | null;
  /** 原生会话的套餐消耗（无 breakdown 时展示）。 */
  planConsumption?: CostAmountValue | null;
  t: (source: string, variables?: Record<string, string | number>) => string;
};

export function CostBreakdownTooltip({ children, total, inputUncached, inputCached, inputCacheWrite, output, currency, apiEquivalent, planConsumption, t }: Props) {
  const fmt = (v: number | null, digits = 2) => formatCostAmount({ amount: v, currency }, v != null && v < 0.01 ? 6 : digits);
  const hasBreakup = inputUncached != null || inputCached != null || inputCacheWrite != null || output != null;
  const hasNativeMeta = apiEquivalent?.amount != null || planConsumption?.amount != null;
  return (
    <Tooltip
      showArrow
      content={(
        <div className={styles.breakdown}>
          <strong>{t("总费用")} {fmt(total)}</strong>
          {hasBreakup ? (
            <>
              {inputUncached != null ? <span><small>{t("未缓存输入")}</small><b>{fmt(inputUncached)}</b></span> : null}
              {inputCached != null ? <span><small>{t("缓存命中")}</small><b>{fmt(inputCached)}</b></span> : null}
              {inputCacheWrite != null ? <span><small>{t("缓存写入")}</small><b>{fmt(inputCacheWrite)}</b></span> : null}
              {output != null ? <span><small>{t("输出")}</small><b>{fmt(output)}</b></span> : null}
            </>
          ) : null}
          {hasNativeMeta && !hasBreakup ? (
            <>
              {apiEquivalent?.amount != null ? <span><small>{t("API 等价价值")}</small><b>{formatCostAmount(apiEquivalent, 4)}</b></span> : null}
              {planConsumption?.amount != null ? <span><small>{t("套餐消耗")}</small><b>{formatCostAmount(planConsumption, 4)}</b></span> : null}
            </>
          ) : null}
        </div>
      )}
    >
      {children}
    </Tooltip>
  );
}
