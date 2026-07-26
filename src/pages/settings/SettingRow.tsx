import type { ReactNode } from "react";
import styles from "./SettingRow.module.css";

type SettingRowProps = {
  name: string;
  help?: string;
  control: ReactNode;
  keywords?: string;
};

export function SettingRow({ name, help, control, keywords }: SettingRowProps) {
  return (
    <div className={styles.row} data-keywords={keywords}>
      <div className={styles.copy}>
        <div className={styles.name}>{name}</div>
        {help ? <div className={styles.help}>{help}</div> : null}
      </div>
      <div className={styles.control}>{control}</div>
    </div>
  );
}

type SectionProps = {
  title: string;
  note?: string;
  children: ReactNode;
  keywords?: string;
};

export function SettingSection({ title, note, children, keywords }: SectionProps) {
  return (
    <section className={styles.section} data-keywords={keywords}>
      <div className={styles.sectionTitle}>{title}</div>
      {note ? <div className={styles.sectionNote}>{note}</div> : null}
      {children}
    </section>
  );
}

export function SettingBadge({ children }: { children: ReactNode }) {
  return <span className={styles.badge}>{children}</span>;
}
