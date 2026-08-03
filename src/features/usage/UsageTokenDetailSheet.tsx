import { SideSheet } from "@douyinfe/semi-ui-19";
import { formatInteger, type NumberLanguage } from "../../shared/formatters/number";
import { CompactNumber } from "../../shared/ui/CompactNumber";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import type { UsageTokenDetailColumn, UsageTokenDetails } from "./deviceUsagePresentation";
import styles from "./UsageTokenDetailSheet.module.css";

type Translate = (source: string, variables?: Record<string, string | number>) => string;

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
  return (
    <SideSheet
      title={t("Token 用量明细")}
      visible={visible}
      onCancel={onClose}
      placement={mobile ? "bottom" : "right"}
      width={mobile ? "100%" : "min(620px, 96vw)"}
      height={mobile ? "min(82vh, 720px)" : undefined}
      bodyStyle={{
        padding: mobile
          ? "14px 14px calc(env(safe-area-inset-bottom, 0px) + 22px)"
          : "16px 18px 24px",
      }}
      headerStyle={mobile ? { padding: "14px 16px 12px" } : undefined}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      footer={null}
    >
      <div className={styles.content}>
        <p className={styles.context}>{contextLabel}</p>
        <UsageSourceSection label={t("总计")} data={details.total} language={language} t={t} featured />
        <UsageSourceSection label={t("经过 Flowlet")} data={details.flowlet} language={language} t={t} />
        <UsageSourceSection label={t("Agent 原生")} data={details.native} language={language} t={t} />
        <p className={styles.note}>{t("短横线表示当前来源未单独保存该项明细，不会按 0 计算。")}</p>
      </div>
    </SideSheet>
  );
}

function UsageSourceSection({ label, data, language, t, featured = false }: {
  label: string;
  data: UsageTokenDetailColumn;
  language: NumberLanguage;
  t: Translate;
  featured?: boolean;
}) {
  const metrics: Array<{ label: string; value: number | null; integer?: boolean; percentage?: boolean }> = [
    { label: t("输入 Token"), value: data.input },
    { label: t("缓存输入 Token"), value: data.cachedInput },
    { label: t("缓存写入"), value: data.cacheWriteInput },
    { label: t("未缓存输入 Token"), value: data.uncachedInput },
    { label: t("输出 Token"), value: data.output },
    { label: t("推理"), value: data.reasoning },
    { label: t("请求量"), value: data.requests, integer: true },
    { label: t("无 Token 明细请求"), value: data.unknownUsageCount, integer: true },
    { label: t("缓存命中率"), value: data.cacheHitRate, percentage: true },
  ];
  return (
    <section className={[styles.source, featured ? styles.featured : ""].join(" ")}>
      <header>
        <span>{label}</span>
        <strong><CompactNumber value={data.total} language={language} /> Tokens</strong>
      </header>
      <div className={styles.metrics}>
        {metrics.map((metric) => (
          <div key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.percentage
              ? formatPercentage(metric.value)
              : metric.integer
                ? metric.value == null ? "—" : formatInteger(metric.value, language)
                : <CompactNumber value={metric.value} language={language} />}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatPercentage(value: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`;
}
