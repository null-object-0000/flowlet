import type { ReactNode } from "react";
import styles from "./DesktopPageLayoutView.module.css";

export function DesktopPageLayoutView({ header, children }: { header: ReactNode; children: ReactNode }) {
  return <div className={styles.page}>{header}{children}</div>;
}

export function DesktopPageHeaderView({ title, subtitle, children }: {
  title: ReactNode;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.titleBlock}>
        <h2 className={styles.title}>{title}</h2>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </div>
      {children ? <div className={styles.controls}>{children}</div> : null}
    </header>
  );
}
