import LongCatColor from "@lobehub/icons/es/LongCat/components/Color";
import DeepSeekLogo from "@lobehub/icons/es/DeepSeek/components/Mono";
import styles from "./ChannelBrandLogo.module.css";

export function ChannelBrandLogo({ channelId, name }: { channelId: string; name: string }) {
  if (channelId === "longcat") {
    return <span className={`${styles.logo} ${styles.longcat}`} aria-hidden="true"><LongCatColor size={32} /></span>;
  }
  if (channelId === "deepseek") {
    return <span className={`${styles.logo} ${styles.deepseek}`} aria-hidden="true"><DeepSeekLogo size={22} /></span>;
  }
  return <span className={`${styles.logo} ${styles.fallback}`} aria-hidden="true">{name.trim().charAt(0).toUpperCase() || "?"}</span>;
}
