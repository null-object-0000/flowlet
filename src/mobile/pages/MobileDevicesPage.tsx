import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useMobileDevices } from "../../features/device-sync/useMobileDeviceSync";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import styles from "./MobilePage.module.css";

export function MobileDevicesPage() {
  const { language, t } = useAppPreferences();
  const devices = useMobileDevices();
  return (
    <section className={styles.page}>
      <header className={styles.heading}><div><h2>{t("设备")}</h2><p>{t("来自共享 S3 路径的 Flowlet 桌面设备")}</p></div></header>
      {devices.isLoading ? <div className={`${styles.card} ${styles.state}`}><span>{t("正在加载设备…")}</span></div> : null}
      {devices.isError ? <div className={`${styles.card} ${styles.state}`}><strong>{t("设备加载失败")}</strong><span>{devices.error.message}</span></div> : null}
      {!devices.isLoading && !devices.isError && !devices.data?.length ? <div className={`${styles.card} ${styles.state}`}><strong>{t("暂无设备")}</strong><span>{t("请先配置 S3 并执行刷新。")}</span></div> : null}
      <div className={styles.deviceList}>
        {(devices.data ?? []).map((device) => (
          <article className={styles.card} key={device.deviceId}>
            <div className={styles.cardHeader}><div><strong>{device.displayName}</strong><span>{device.platform} · Flowlet {device.appVersion}</span></div></div>
            <div className={styles.stats}>
              <div className={styles.stat}><span>Tokens</span><strong>{formatCompactNumber(device.knownTokens, language)}</strong><small>{t("累计")}</small></div>
              <div className={styles.stat}><span>{t("请求量")}</span><strong>{formatInteger(device.requestCount, language)}</strong><small>{t("{count} 天数据", { count: device.dayCount })}</small></div>
            </div>
            <p className={styles.muted}>{t("最近快照：{time}", { time: formatFullTimestamp(device.lastSeenAt, language) })}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
