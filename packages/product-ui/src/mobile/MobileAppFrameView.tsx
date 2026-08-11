import type { ReactNode } from "react";
import styles from "./MobileAppFrameView.module.css";

export type MobileNavItem = {
  id: string;
  label: string;
  icon: ReactNode;
  href?: string;
};

type Props = {
  children: ReactNode;
  items: MobileNavItem[];
  activeId: string;
  navigationLabel: string;
  embedded?: boolean;
  onNavigate?: (id: string) => void;
};

export function MobileAppFrameView({ children, items, activeId, navigationLabel, embedded = false, onNavigate }: Props) {
  return (
    <div className={`${styles.shell} ${embedded ? styles.embedded : ""}`}>
      <main className={styles.content}>{children}</main>
      <nav className={styles.navigation} aria-label={navigationLabel}>
        {items.map((item) => {
          const content = <>{item.icon}<span>{item.label}</span></>;
          const className = activeId === item.id ? styles.active : undefined;
          return item.href ? <a key={item.id} href={item.href} className={className} aria-current={activeId === item.id ? "page" : undefined} onClick={(event) => { event.preventDefault(); onNavigate?.(item.id); }}>{content}</a> : <button key={item.id} type="button" className={className} aria-current={activeId === item.id ? "page" : undefined} onClick={() => onNavigate?.(item.id)}>{content}</button>;
        })}
      </nav>
    </div>
  );
}
