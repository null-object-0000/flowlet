import { IconCamera, IconCloud, IconSetting, IconWrench } from "@douyinfe/semi-icons";

function IconDatabase() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
      <ellipse cx="12" cy="5.5" rx="8.5" ry="3.5" />
      <path d="M3.5 6v5c0 1.9 3.8 3.5 8.5 3.5s8.5-1.6 8.5-3.5V6" />
      <path d="M3.5 12v5c0 1.9 3.8 3.5 8.5 3.5s8.5-1.6 8.5-3.5v-5" />
    </svg>
  );
}

function IconInfo() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="7.5" r="1.3" fill="white" />
      <rect x="11" y="10" width="2" height="7" rx="1" fill="white" />
    </svg>
  );
}

function IconLock() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
      <path d="M7 10V7.5a5 5 0 0 1 10 0V10h1.5A1.5 1.5 0 0 1 20 11.5v8A1.5 1.5 0 0 1 18.5 21h-13A1.5 1.5 0 0 1 4 19.5v-8A1.5 1.5 0 0 1 5.5 10H7zm2 0h6V7.5a3 3 0 0 0-6 0V10z" />
    </svg>
  );
}
import styles from "./SettingsNav.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { isWebHost } from "../../platform/web/mode";

export type SettingsTab =
  | "general"
  | "capture"
  | "sync"
  | "storage"
  | "auth"
  | "maintenance"
  | "about";

type NavItem = {
  key: SettingsTab;
  label: string;
  icon: React.ReactNode;
};

const NAV_ITEMS: NavItem[] = [
  { key: "general", label: "通用", icon: <IconSetting /> },
  { key: "capture", label: "数据捕获", icon: <IconCamera /> },
  { key: "sync", label: "同步管理", icon: <IconCloud /> },
  { key: "storage", label: "存储管理", icon: <IconDatabase /> },
  { key: "maintenance", label: "数据维护", icon: <IconWrench /> },
];

export function SettingsNav({ active, onChange }: { active: SettingsTab; onChange: (tab: SettingsTab) => void }) {
  const { t } = useAppPreferences();
  // 登录提供方只在 Web Host 存在（桌面壳是本地单用户，没有登录页）。
  const items = isWebHost
    ? [...NAV_ITEMS, { key: "auth" as const, label: "登录与访问", icon: <IconLock /> }]
    : NAV_ITEMS;
  return (
    <nav className={styles.nav}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`${styles.button} ${active === item.key ? styles.active : ""}`}
          data-tab={item.key}
          aria-label={t(item.label)}
          aria-current={active === item.key ? "true" : undefined}
          onClick={() => onChange(item.key)}
        >
          <span className={styles.icon} aria-hidden="true">{item.icon}</span>
          {t(item.label)}
        </button>
      ))}
      <div className={styles.sep} />
      <button
        type="button"
        className={`${styles.button} ${active === "about" ? styles.active : ""}`}
        data-tab="about"
        aria-label={t("关于")}
        aria-current={active === "about" ? "true" : undefined}
        onClick={() => onChange("about")}
      >
        <span className={styles.icon} aria-hidden="true"><IconInfo /></span>
        {t("关于")}
      </button>
    </nav>
  );
}

export function useSettingsTabMeta(): Record<SettingsTab, { title: string; desc: string }> {
  const { t } = useAppPreferences();
  return {
    general: { title: t("通用设置"), desc: t("调整 Flowlet 的显示、主题与启动行为") },
    capture: { title: t("数据捕获"), desc: t("控制请求 / 响应内容的捕获、保留和脱敏策略") },
    sync: { title: t("同步管理"), desc: t("管理云端同步、设备连接与用量汇总") },
    auth: { title: t("登录与访问"), desc: t("配置管理台的登录方式（GitHub OAuth）与准入名单") },
    storage: { title: t("存储管理"), desc: t("查看本地数据占用并清理不再需要的内容") },
    maintenance: { title: t("数据维护"), desc: t("检查并修复历史统计数据") },
    about: { title: t("关于 Flowlet"), desc: t("版本信息、数据目录与诊断工具") },
  };
}
