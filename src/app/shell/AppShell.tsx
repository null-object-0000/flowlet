import { Layout } from "@douyinfe/semi-ui-19";
import { Outlet } from "react-router-dom";
import styles from "./AppShell.module.css";
import { Sidebar } from "./Sidebar";
import { WindowControls } from "./WindowControls";
import { AgentDataAutoSync } from "../../features/background-tasks/AgentDataAutoSync";

const { Sider, Content } = Layout;

export function AppShell() {
  return (
    <>
      <WindowControls />
      <AgentDataAutoSync />
      <Layout className={styles.shell}>
        <Sider className={styles.sidebar}>
          <Sidebar />
        </Sider>
        <Content className={styles.content}>
          <Outlet />
        </Content>
      </Layout>
    </>
  );
}
