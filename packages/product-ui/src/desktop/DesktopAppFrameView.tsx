import type { ReactNode } from "react";
import styles from "./DesktopAppFrameView.module.css";

export type DesktopNavItem = {
  id: string;
  label: string;
  icon: ReactNode;
};

export type DesktopNavGroup = {
  id: string;
  label: string;
  items: DesktopNavItem[];
};

export function DesktopSidebarView({
  logo,
  productName,
  version,
  groups,
  activeId,
  settings,
  onNavigate,
}: {
  logo: ReactNode;
  productName: string;
  version: string;
  groups: DesktopNavGroup[];
  activeId: string;
  settings?: DesktopNavItem;
  onNavigate: (id: string) => void;
}) {
  const item = (entry: DesktopNavItem) => (
    <button
      key={entry.id}
      type="button"
      className={`${styles.navItem} ${activeId === entry.id ? styles.active : ""}`}
      onClick={() => onNavigate(entry.id)}
      aria-pressed={activeId === entry.id}
    >
      <span className={styles.navIcon}>{entry.icon}</span>
      <span>{entry.label}</span>
    </button>
  );

  return (
    <div className={styles.sidebarInner}>
      <div className={styles.brand}>
        <span className={styles.logo}>{logo}</span>
        <span className={styles.brandCopy}><strong>{productName}</strong><small>{version}</small></span>
      </div>
      <nav className={styles.nav}>
        {groups.map((group) => (
          <div className={styles.navGroup} key={group.id}>
            <div className={styles.navLabel}>{group.label}</div>
            {group.items.map(item)}
          </div>
        ))}
      </nav>
      {settings ? <div className={styles.footer}>{item(settings)}</div> : null}
    </div>
  );
}

export function DesktopAppFrameView({ sidebar, children, embedded = false }: { sidebar: ReactNode; children: ReactNode; embedded?: boolean }) {
  return (
    <div className={`${styles.shell} ${embedded ? styles.embedded : ""}`}>
      <aside className={styles.sidebar}>{sidebar}</aside>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
