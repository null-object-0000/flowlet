import { Select } from "@douyinfe/semi-ui-19";
import { useMemo, useState } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useMobileDailyUsage, useMobileDevices } from "../../features/device-sync/useMobileDeviceSync";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import { filterMobileUsage, summarizeMobileUsage, type MobileUsagePeriod } from "../mobileUsage";
import styles from "./MobilePage.module.css";

export function MobileUsagePage() {
  const { language, t } = useAppPreferences();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [period, setPeriod] = useState<MobileUsagePeriod>("month");
  const devices = useMobileDevices();
  const usage = useMobileDailyUsage(deviceId);
  const days = useMemo(() => filterMobileUsage(usage.data ?? [], period), [period, usage.data]);
  const summary = useMemo(() => summarizeMobileUsage(days), [days]);

  return (
    <section className={styles.page}>
      <header className={styles.heading}><div><h2>{t("用量")}</h2><p>{t("按设备和时间查看请求与 Token 汇总")}</p></div></header>
      <div className={styles.controls}>
        <Select
          value={deviceId ?? "__all__"}
          aria-label={t("设备")}
          optionList={[
            { value: "__all__", label: t("全部设备") },
            ...(devices.data ?? []).map((device) => ({ value: device.deviceId, label: device.displayName })),
          ]}
          onChange={(value) => setDeviceId(value === "__all__" ? null : String(value))}
        />
        <Select
          value={period}
          aria-label={t("统计周期")}
          optionList={[
            { value: "week", label: t("近 7 天") },
            { value: "month", label: t("近 30 天") },
            { value: "all", label: t("全部时间") },
          ]}
          onChange={(value) => setPeriod(value as MobileUsagePeriod)}
        />
      </div>
      <div className={styles.stats}>
        <article className={styles.stat}><span>Tokens</span><strong>{formatCompactNumber(summary.tokens, language)}</strong><small>{t("输入 {input} · 输出 {output}", { input: formatCompactNumber(summary.inputTokens, language), output: formatCompactNumber(summary.outputTokens, language) })}</small></article>
        <article className={styles.stat}><span>{t("请求量")}</span><strong>{formatInteger(summary.requests, language)}</strong><small>{t("{count} 天数据", { count: days.length })}</small></article>
        <article className={styles.stat}><span>{t("缓存输入")}</span><strong>{formatCompactNumber(summary.cachedInputTokens, language)}</strong><small>Tokens</small></article>
        <article className={styles.stat}><span>{t("设备")}</span><strong>{deviceId ? "1" : formatInteger(devices.data?.length ?? 0, language)}</strong><small>{deviceId ? t("指定设备") : t("全部设备")}</small></article>
      </div>
      <article className={styles.card}>
        <div className={styles.cardHeader}><div><strong>{t("每日汇总")}</strong><span>{t("费用和模型明细暂不跨设备同步")}</span></div></div>
        {usage.isError ? <div className={styles.state}><strong>{t("用量数据加载失败")}</strong><span>{usage.error.message}</span></div> : null}
        {!usage.isError && days.length === 0 ? <div className={styles.state}><span>{t("当前筛选范围暂无数据")}</span></div> : null}
        <div className={styles.days}>
          {[...days].reverse().map((day) => (
            <div className={styles.day} key={day.date}>
              <strong>{day.date}</strong><span>{formatCompactNumber(day.knownTokens, language)} Tokens</span>
              <small>{t("{count} 次请求", { count: formatInteger(day.requestCount, language) })} · {t("输入 {input} · 输出 {output}", { input: formatCompactNumber(day.inputTokens, language), output: formatCompactNumber(day.outputTokens, language) })}</small>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}
