import { Layout, Tag, Typography } from "@douyinfe/semi-ui-19";
import { NavLink, Outlet } from "react-router-dom";
import styles from "./AppShell.module.css";
import navStyles from "./Nav.module.css";

const { Header, Sider, Content } = Layout;
const { Text, Title } = Typography;

const navItems = [
  { to: "/", label: "概览" },
  { to: "/channels", label: "渠道账号" },
];

export function AppShell() {
  return (
    <Layout className={styles.shell}>
      <Sider className={styles.sidebar}>
        <div className={styles.brand}>
          <Title heading={5}>Flowlet</Title>
          <Tag color="blue" size="small">Next</Tag>
        </div>
        <nav className={styles.nav}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) => (isActive ? navStyles.active : navStyles.link)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </Sider>

      <Layout>
        <Header className={styles.header}>
          <Text strong>Flowlet 前端重构</Text>
        </Header>
        <Content className={styles.content}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}