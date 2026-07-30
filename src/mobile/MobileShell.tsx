import { IconComment, IconDesktop, IconHome, IconSetting } from "@douyinfe/semi-icons";
import { NavLink, Outlet } from "react-router-dom";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import { MobileDeviceSelectionProvider } from "./MobileDeviceSelection";
import styles from "./MobileShell.module.css";

const items = [
  { to: "/", label: "概览", icon: <IconHome /> },
  { to: "/sessions", label: "会话", icon: <IconComment /> },
  { to: "/devices", label: "设备", icon: <IconDesktop /> },
  { to: "/settings", label: "设置", icon: <IconSetting /> },
];

export function MobileShell() {
  const { t } = useAppPreferences();
  return (
    <MobileDeviceSelectionProvider>
      <div className={styles.shell}>
        <main className={styles.content}><Outlet /></main>
        <nav className={styles.navigation} aria-label={t("主导航")}>
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              replace
              end={item.to === "/"}
              className={({ isActive }) => isActive ? styles.active : undefined}
            >
              {item.icon}
              <span>{t(item.label)}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </MobileDeviceSelectionProvider>
  );
}
