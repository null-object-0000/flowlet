import type { ReactNode } from "react";
import { Tooltip } from "@douyinfe/semi-ui-19";
import { formatInteger } from "../formatters/number";
import { CompactNumber } from "./CompactNumber";
import styles from "./TokenBreakdownTooltip.module.css";

type TokenBreakdown = {
  total: number | null;
  input: number | null;
  cachedInput: number | null;
  cacheWriteInput?: number | null;
  uncachedInput: number | null;
  output: number | null;
  reasoning?: number | null;
  cacheHitRate: number | null;
  /** 可选：请求量（用量成本页渠道维度等聚合场景展示）。 */
  requests?: number | null;
  unknownUsageCount?: number;
};

type ContentProps = {
  tokens: TokenBreakdown;
  language: "zh-CN" | "en-US";
  t: (source: string, variables?: Record<string, string | number>) => string;
};

type Props = ContentProps & {
  children: ReactNode;
};

/** 悬浮层主体：总消耗 Token、缓存命中率，横线分割后展示输入/输出明细。 */
export function TokenBreakdownContent({ tokens, language, t }: ContentProps) {
  return (
    <div className={styles.breakdown}>
      <strong>{t("总消耗 Token")} <CompactNumber value={tokens.total} language={language} /></strong>
      <span><small>{t("缓存命中率")}</small><b>{formatPercentage(tokens.cacheHitRate)}</b></span>
      <hr className={styles.divider} />
      {tokens.requests != null ? <span><small>{t("请求量")}</small><b>{formatInteger(tokens.requests, language)}</b></span> : null}
      <span><small>{t("输入 Token")}</small><b><CompactNumber value={tokens.input} language={language} /></b></span>
      <span><small>{t("缓存输入 Token")}</small><b><CompactNumber value={tokens.cachedInput} language={language} /></b></span>
      {tokens.cacheWriteInput != null ? <span><small>{t("缓存写入")}</small><b><CompactNumber value={tokens.cacheWriteInput} language={language} /></b></span> : null}
      <span><small>{t("未缓存输入 Token")}</small><b><CompactNumber value={tokens.uncachedInput} language={language} /></b></span>
      <span><small>{t("输出 Token")}</small><b><CompactNumber value={tokens.output} language={language} /></b></span>
      {tokens.reasoning != null ? <span><small>{t("推理")}</small><b><CompactNumber value={tokens.reasoning} language={language} /></b></span> : null}
      {(tokens.unknownUsageCount ?? 0) > 0 ? (
        <span className={styles.missing}><small>{t("无 Token 明细请求")}</small><b>{tokens.unknownUsageCount}</b></span>
      ) : null}
    </div>
  );
}

export function TokenBreakdownTooltip({ children, tokens, language, t }: Props) {
  return (
    <Tooltip
      showArrow
      content={<TokenBreakdownContent tokens={tokens} language={language} t={t} />}
    >
      {children}
    </Tooltip>
  );
}

function formatPercentage(value: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`;
}
