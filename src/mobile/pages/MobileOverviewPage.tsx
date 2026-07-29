import { Button, Toast } from "@douyinfe/semi-ui-19";
import { useEffect, useMemo, useRef } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useMobileDailyUsage, useMobileDevices, useMobileDeviceSyncActions, useMobileS3Settings } from "../../features/device-sync/useMobileDeviceSync";
import { errorMessage } from "../../shared/errors/AppError";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import { summarizeMobileUsage } from "../mobileUsage";
import styles from "./MobilePage.module.css";

export function MobileOverviewPage() {
  const { language, t } = useAppPreferences();
  const settings = useMobileS3Settings();
  const devices = useMobileDevices();
  const usage = useMobileDailyUsage(null);
  const actions = useMobileDeviceSyncActions();
  const autoRefreshStarted = useRef(false);
  const summary = useMemo(() => summarizeMobileUsage(usage.data ?? []), [usage.data]);
  const today = new Date().toLocaleDateString("en-CA");
  const todaySummary = useMemo(
    () => summarizeMobileUsage((usage.data ?? []).filter((day) => day.date === today)),
    [today, usage.data],
  );

  const refresh = async (quiet = false) => {
    try {
      const result = await actions.refreshS3.mutateAsync();
      if (!quiet) Toast.success(t("已刷新 {devices} 台设备", { devices: result.remoteDevices }));
    } catch (error) {
      if (!quiet) Toast.error(t("刷新失败：{message}", { message: errorMessage(error) }));
    }
  };

  useEffect(() => {
    if (!settings.data?.config || autoRefreshStarted.current) return;
    autoRefreshStarted.current = true;
    void refresh(true);
  }, [settings.data?.config]);

  const status = settings.data?.status;
  return (
    <section className={styles.page}>
      <header className={styles.heading}>
        <div><h2>{t("设备用量")}</h2><p>{t("查看 Flowlet 桌面设备同步的每日汇总")}</p></div>
        <Button theme="solid" loading={actions.refreshS3.isPending} disabled={!settings.data?.config} onClick={() => void refresh()}>{t("刷新")}</Button>
      </header>

      {!settings.isLoading && !settings.data?.config ? (
        <div className={`${styles.card} ${styles.state}`}>
          <strong>{t("尚未配置数据源")}</strong>
          <span>{t("前往设置，填写与桌面端相同的 S3 Bucket 和路径前缀。")}</span>
        </div>
      ) : null}

      <div className={styles.stats}>
        <article className={styles.stat}><span>{t("今日 Token")}</span><strong>{formatCompactNumber(todaySummary.tokens, language)}</strong><small>{t("{count} 次请求", { count: formatInteger(todaySummary.requests, language) })}</small></article>
        <article className={styles.stat}><span>{t("设备数量")}</span><strong>{formatInteger(devices.data?.length ?? 0, language)}</strong><small>{t("远端共享设备")}</small></article>
        <article className={styles.stat}><span>{t("累计 Token")}</span><strong>{formatCompactNumber(summary.tokens, language)}</strong><small>{t("所有已同步日期")}</small></article>
        <article className={styles.stat}><span>{t("累计请求")}</span><strong>{formatCompactNumber(summary.requests, language)}</strong><small>{t("每日摘要汇总")}</small></article>
      </div>

      <article className={styles.card}>
        <div className={styles.cardHeader}><div><strong>{t("同步状态")}</strong><span>{status?.lastSuccessAt ? formatFullTimestamp(status.lastSuccessAt, language) : t("尚未成功刷新")}</span></div></div>
        <div className={styles.status} data-state={status?.status ?? "never"}><i /><span>{status?.message ?? t("正在读取设置…")}</span></div>
      </article>

      <article className={styles.card}>
        <div className={styles.cardHeader}><div><strong>{t("最近设备")}</strong><span>{t("按快照更新时间排序")}</span></div></div>
        {devices.isError ? <div className={styles.state}><strong>{t("设备加载失败")}</strong><span>{devices.error.message}</span></div> : null}
        {!devices.isError && !devices.data?.length ? <div className={styles.state}><span>{t("刷新后，远端设备会显示在这里。")}</span></div> : null}
        <div className={styles.deviceList}>
          {(devices.data ?? []).slice(0, 3).map((device) => (
            <div className={styles.device} key={device.deviceId}>
              <strong>{device.displayName}</strong><span>{formatCompactNumber(device.knownTokens, language)} Tokens</span>
              <small>{device.platform} · {t("{count} 天数据", { count: device.dayCount })}</small>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}
