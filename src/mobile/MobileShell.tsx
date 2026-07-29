import { IconComment, IconHome, IconSetting } from "@douyinfe/semi-icons";
import { NavLink, Outlet } from "react-router-dom";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import { FlowletLogo } from "../shared/ui/FlowletLogo";
import styles from "./MobileShell.module.css";

const items = [
  { to: "/", label: "概览", icon: <IconHome /> },
  { to: "/sessions", label: "会话", icon: <IconComment /> },
  { to: "/settings", label: "设置", icon: <IconSetting /> },
];

export function MobileShell() {
  const { t } = useAppPreferences();
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <FlowletLogo variant="brand" />
        <div><strong>Flowlet</strong><span>{t("移动数据查看器")}</span></div>
      </header>
      <main className={styles.content}><Outlet /></main>
      <nav className={styles.navigation} aria-label={t("主导航")}>
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) => isActive ? styles.active : undefined}
          >
            {item.icon}
            <span>{t(item.label)}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
