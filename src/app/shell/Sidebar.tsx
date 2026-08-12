import type { ReactNode } from "react";
import { Typography } from "@douyinfe/semi-ui-19";
import {
  IconHistogram,
  IconHome,
  IconComment,
  IconList,
  IconPieChart2Stroked,
  IconServer,
  IconSetting,
  IconHistory,
  IconKanban,
} from "@douyinfe/semi-icons";
import { NavLink } from "react-router-dom";
import navStyles from "./Nav.module.css";
import styles from "./Sidebar.module.css";
import { useAppPreferences } from "../preferences/AppPreferences";
import { FlowletLogo } from "../../shared/ui/FlowletLogo";

const { Text, Title } = Typography;

const navGroups: Array<{
  label: string;
  items: Array<{ to: string; label: string; icon: ReactNode; tag?: string }>;
}> = [
  {
    label: "工作台",
    items: [
      { to: "/", label: "运行概览", icon: <IconHome /> },
      { to: "/models", label: "模型服务", icon: <IconServer /> },
      { to: "/projects", label: "项目管理", icon: <IconKanban /> },
    ],
  },
  {
    label: "运行记录",
    items: [
      { to: "/logs", label: "请求日志", icon: <IconList /> },
      { to: "/sessions", label: "会话管理", icon: <IconComment /> },
      { to: "/tasks", label: "任务日志", icon: <IconHistory /> },
    ],
  },
  {
    label: "分析",
    items: [
      { to: "/usage", label: "用量统计", icon: <IconHistogram /> },
      { to: "/usage-analysis", label: "用量洞察", icon: <IconPieChart2Stroked /> },
    ],
  },
];

export function Sidebar() {
  const { t } = useAppPreferences();
  return (
    <div className={styles.inner}>
      <div className={styles.brand}>
        <FlowletLogo variant="brand" />
        <div className={styles.brandCopy}>
          <Title heading={5} style={{ margin: 0 }}>Flowlet</Title>
          <Text type="tertiary" size="small">v{__FLOWLET_APP_VERSION__}</Text>
        </div>
      </div>

      <nav className={styles.nav} aria-label={t("主导航")}>
        {navGroups.map((group) => (
          <div key={group.label} className={styles.navGroup}>
            <div className={styles.navLabel}>{t(group.label)}</div>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) => (isActive ? navStyles.active : navStyles.link)}
              >
                <span className={navStyles.icon}>{item.icon}</span>
                {t(item.label)}
                {item.tag ? <span className={navStyles.tag}>{item.tag}</span> : null}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className={styles.footer}>
        <NavLink to="/settings" className={({ isActive }) => (isActive ? navStyles.active : navStyles.link)}>
          <span className={navStyles.icon}><IconSetting /></span>
          {t("应用设置")}
        </NavLink>
      </div>
    </div>
  );
}
