import styles from "./ChannelBrandLogoView.module.css";

export function ChannelBrandLogoView({ channelId, name }: { channelId: string; name: string }) {
  if (channelId === "flowlet") {
    return <span className={`${styles.logo} ${styles.flowlet}`} aria-hidden="true"><img src="/flowlet-logo.png" alt="" /></span>;
  }
  if (channelId === "longcat") {
    return <span className={`${styles.logo} ${styles.longcat}`} aria-hidden="true"><img src="/icons/lobe/longcat-color.svg" alt="" /></span>;
  }
  if (channelId === "kimi") {
    return <span className={`${styles.logo} ${styles.kimi}`} aria-hidden="true"><img src="/icons/lobe/kimi-color.svg" alt="" /></span>;
  }
  if (channelId === "qwen") {
    return <span className={`${styles.logo} ${styles.qwen}`} aria-hidden="true"><img src="/icons/lobe/qwen-color.svg" alt="" /></span>;
  }
  if (channelId === "deepseek") {
    return <span className={`${styles.logo} ${styles.deepseek}`} aria-hidden="true"><i /></span>;
  }
  if (channelId === "zhipu") {
    return <span className={`${styles.logo} ${styles.zhipu}`} aria-hidden="true"><img src="/icons/lobe/zhipu-color.svg" alt="" /></span>;
  }
  if (channelId === "openrouter") {
    return <span className={`${styles.logo} ${styles.openrouter}`} aria-hidden="true"><i /></span>;
  }
  if (channelId === "chatgpt") {
    return <span className={`${styles.logo} ${styles.chatgpt}`} aria-hidden="true"><i /></span>;
  }
  return <span className={`${styles.logo} ${styles.fallback}`} aria-hidden="true">{name.trim().charAt(0).toUpperCase() || "?"}</span>;
}
