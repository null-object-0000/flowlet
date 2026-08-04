import { useParams } from "react-router-dom";
import { WindowControls } from "../../app/shell/WindowControls";
import { ProjectDetail } from "./ProjectsPage";
import styles from "./ProjectDetailWindow.module.css";

/**
 * 项目详情的独立窗口页面：无侧边栏，顶部为无边框窗口控制条，
 * 下方直接展示与主窗口一致的项目任务看板。
 * 该页面由 Rust `open_project_detail_window` command 通过
 * `#/project-window/:projectId` hash 路由创建。
 */
export function ProjectDetailWindow() {
  const { projectId } = useParams();
  return (
    <div className={styles.window}>
      <WindowControls standalone />
      <main className={styles.content}>
        {projectId ? <ProjectDetail projectId={projectId} /> : null}
      </main>
    </div>
  );
}
