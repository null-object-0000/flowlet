import { Layout, Toast } from "@douyinfe/semi-ui-19";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import styles from "./AppShell.module.css";
import { Sidebar } from "./Sidebar";
import { WindowControls } from "./WindowControls";
import { useAppPreferences } from "../preferences/AppPreferences";
import { projectCommands } from "../../domains/project/commands";
import { errorMessage } from "../../shared/errors/AppError";
import { AgentDataAutoSync } from "../../features/background-tasks/AgentDataAutoSync";
import { CodexAccountAutoSync } from "../../features/background-tasks/CodexAccountAutoSync";
import { ChannelResourceAutoSync } from "../../features/background-tasks/ChannelResourceAutoSync";

const { Sider, Content } = Layout;

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useAppPreferences();
  // 右上角窗口控制区的「在独立窗口打开」按钮：目前仅项目任务看板
  // （/projects/:projectId）支持独立窗口，其他页面不注入该能力。
  const detailMatch = /^\/projects\/([^/]+)\/?$/.exec(location.pathname);
  const projectId = detailMatch?.[1];
  const openDetailWindow = projectId
    ? async () => {
        try {
          await projectCommands.openDetailWindow(projectId);
          // 项目详情已移交独立窗口展示，主窗口自动回退到项目管理页。
          navigate("/projects");
        } catch (error) {
          Toast.error(errorMessage(error));
        }
      }
    : undefined;
  return (
    <>
      <WindowControls openDetailWindow={openDetailWindow} />
      <AgentDataAutoSync />
      <CodexAccountAutoSync />
      <ChannelResourceAutoSync />
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
