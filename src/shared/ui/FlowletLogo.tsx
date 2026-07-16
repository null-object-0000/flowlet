import styles from "./FlowletLogo.module.css";

type FlowletLogoVariant = "brand" | "model" | "channel";

export function FlowletLogo({ variant = "model" }: { variant?: FlowletLogoVariant }) {
  return (
    <span className={`${styles.logo} ${styles[variant]}`} aria-hidden="true">
      <img src="/logo_1254_transparent.png" alt="" />
    </span>
  );
}
