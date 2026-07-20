import styles from "./ChannelBrandLogo.module.css";
import { FlowletLogo } from "../../shared/ui/FlowletLogo";

export function ChannelBrandLogo({ channelId, name }: { channelId: string; name: string }) {
  if (channelId === "flowlet") {
    return <FlowletLogo variant="channel" />;
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
  return <span className={`${styles.logo} ${styles.fallback}`} aria-hidden="true">{name.trim().charAt(0).toUpperCase() || "?"}</span>;
}
