import type { ReactNode } from "react";
import { Typography } from "@douyinfe/semi-ui-19";
import {
  IconHistogram,
  IconHome,
  IconList,
  IconServer,
  IconSetting,
} from "@douyinfe/semi-icons";
import { NavLink } from "react-router-dom";
import navStyles from "./Nav.module.css";
import styles from "./Sidebar.module.css";

const { Text, Title } = Typography;

const navItems: Array<{ to: string; label: string; icon: ReactNode }> = [
  { to: "/", label: "概览", icon: <IconHome /> },
  { to: "/models", label: "模型服务", icon: <IconServer /> },
  { to: "/logs", label: "请求日志", icon: <IconList /> },
  { to: "/usage", label: "用量成本", icon: <IconHistogram /> },
  { to: "/settings", label: "高级设置", icon: <IconSetting /> },
];

export function Sidebar() {
  return (
    <div className={styles.inner}>
      <div className={styles.brand}>
        <span className={styles.mark}>F</span>
        <div className={styles.brandCopy}>
          <Title heading={5} style={{ margin: 0 }}>Flowlet</Title>
          <Text type="tertiary" size="small">v0.1.0</Text>
        </div>
      </div>

      <nav className={styles.nav} aria-label="主导航">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) => (isActive ? navStyles.active : navStyles.link)}
          >
            <span className={navStyles.icon}>{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>

    </div>
  );
}
