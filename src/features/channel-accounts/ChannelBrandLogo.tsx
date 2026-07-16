import styles from "./ChannelBrandLogo.module.css";

export function ChannelBrandLogo({ channelId, name }: { channelId: string; name: string }) {
  if (channelId === "longcat") {
    return <span className={`${styles.logo} ${styles.longcat}`} aria-hidden="true"><img src="/icons/lobe/longcat-color.svg" alt="" /></span>;
  }
  if (channelId === "deepseek") {
    return <span className={`${styles.logo} ${styles.deepseek}`} aria-hidden="true"><i /></span>;
  }
  return <span className={`${styles.logo} ${styles.fallback}`} aria-hidden="true">{name.trim().charAt(0).toUpperCase() || "?"}</span>;
}
