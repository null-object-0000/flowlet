import { IconClose } from "@douyinfe/semi-icons";
import { SideSheet } from "@douyinfe/semi-ui-19";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatInteger, type NumberLanguage } from "../../shared/formatters/number";
import { CompactNumber } from "../../shared/ui/CompactNumber";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { DETAIL_SHEET_WIDTH } from "../../shared/ui/drawerWidth";
import type { UsageTokenDetailColumn, UsageTokenDetails } from "./deviceUsagePresentation";
import styles from "./UsageTokenDetailSheet.module.css";

type Translate = (source: string, variables?: Record<string, string | number>) => string;
type MetricKey = keyof Pick<UsageTokenDetailColumn,
  "total" | "input" | "cachedInput" | "cacheWriteInput" | "uncachedInput" | "output"
  | "reasoning" | "requests" | "unknownUsageCount" | "cacheHitRate">;

export function UsageTokenDetailSheet({
  visible,
  onClose,
  contextLabel,
  details,
  language,
  t,
  mobile = false,
}: {
  visible: boolean;
  onClose: () => void;
  contextLabel: string;
  details: UsageTokenDetails;
  language: NumberLanguage;
  t: Translate;
  mobile?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const touchStartY = useRef<number | null>(null);

  useEffect(() => {
    if (!visible) return;
    setExpanded(false);
    if (!mobile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [mobile, visible]);

  const content = (
    <UsageMetricComparison details={details} language={language} t={t} />
  );

  if (mobile) {
    if (!visible) return null;
    return createPortal(
      <div
        className={styles.mobileBackdrop}
        style={{ zIndex: APP_OVERLAY_Z_INDEX.modal }}
        onClick={onClose}
      >
        <section
          className={styles.mobileSheet}
          data-expanded={expanded || undefined}
          data-testid="sheet"
          data-placement="bottom"
          role="dialog"
          aria-modal="true"
          aria-label={t("Token 用量明细")}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className={styles.mobileHandle}
            aria-label={expanded ? t("收起") : t("展开")}
            onClick={() => setExpanded((value) => !value)}
            onTouchStart={(event) => { touchStartY.current = event.touches[0]?.clientY ?? null; }}
            onTouchEnd={(event) => {
              const start = touchStartY.current;
              const end = event.changedTouches[0]?.clientY;
              touchStartY.current = null;
              if (start == null || end == null) return;
              if (end - start < -28) setExpanded(true);
              if (end - start > 48) setExpanded(false);
            }}
          >
            <span />
          </button>
          <header className={styles.mobileHeader}>
            <div>
              <strong>{t("Token 用量明细")}</strong>
              <span>{contextLabel}</span>
            </div>
            <button type="button" aria-label={t("关闭")} onClick={onClose}><IconClose /></button>
          </header>
          <div className={styles.mobileBody}>{content}</div>
        </section>
      </div>,
      document.body,
    );
  }

  return (
    <SideSheet
      title={t("Token 用量明细")}
      visible={visible}
      onCancel={onClose}
      placement="right"
      width={DETAIL_SHEET_WIDTH}
      bodyStyle={{ padding: "16px 18px 24px" }}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      footer={null}
    >
      <p className={styles.context}>{contextLabel}</p>
      {content}
    </SideSheet>
  );
}

function UsageMetricComparison({ details, language, t }: {
  details: UsageTokenDetails;
  language: NumberLanguage;
  t: Translate;
}) {
  const metrics: Array<{ key: MetricKey; label: string; kind: "token" | "integer" | "percentage" }> = [
    { key: "total", label: "Tokens", kind: "token" },
    { key: "input", label: t("输入 Token"), kind: "token" },
    { key: "cachedInput", label: t("缓存输入 Token"), kind: "token" },
    { key: "cacheWriteInput", label: t("缓存写入"), kind: "token" },
    { key: "uncachedInput", label: t("未缓存输入 Token"), kind: "token" },
    { key: "output", label: t("输出 Token"), kind: "token" },
    { key: "reasoning", label: t("推理"), kind: "token" },
    { key: "requests", label: t("请求量"), kind: "integer" },
    { key: "unknownUsageCount", label: t("无 Token 明细请求"), kind: "integer" },
    { key: "cacheHitRate", label: t("缓存命中率"), kind: "percentage" },
  ];
  const sources = [
    { key: "total" as const, label: t("总计") },
    { key: "flowlet" as const, label: t("经过 Flowlet") },
    { key: "native" as const, label: t("Agent 原生") },
  ];

  return (
    <div className={styles.content}>
      <div className={styles.comparison} role="table" aria-label={t("Token 用量明细")}>
        <div className={styles.comparisonHeader} role="row">
          <span aria-hidden="true" />
          {sources.map((source) => <strong role="columnheader" key={source.key}>{source.label}</strong>)}
        </div>
        {metrics.map((metric) => (
          <div className={styles.metricRow} data-featured={metric.key === "total" || undefined} role="row" key={metric.key}>
            <strong className={styles.metricLabel} role="rowheader">{metric.label}</strong>
            {sources.map((source) => (
              <div className={styles.metricValue} role="cell" key={source.key}>
                <span>{source.label}</span>
                <strong>{formatMetric(details[source.key][metric.key], metric.kind, language)}</strong>
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className={styles.note}>{t("短横线表示当前来源未单独保存该项明细，不会按 0 计算。")}</p>
    </div>
  );
}

function formatMetric(
  value: number | null,
  kind: "token" | "integer" | "percentage",
  language: NumberLanguage,
): ReactNode {
  if (value == null || !Number.isFinite(value)) return "—";
  if (kind === "percentage") return `${(value * 100).toFixed(1)}%`;
  if (kind === "integer") return formatInteger(value, language);
  return <CompactNumber value={value} language={language} />;
}
