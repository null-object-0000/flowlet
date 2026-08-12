import { useState } from "react";
import {
  AgentSessionsDemoView,
  DesktopAppFrameView,
  DesktopOverviewDemoView,
  DesktopSidebarView,
  ModelsServiceDemoView,
  ProjectsBoardDemoView,
  RequestLogsDemoView,
  SettingsDemoView,
  TaskLogsDemoView,
  UsageAnalysisDemoView,
  UsageStatisticsDemoView,
  type DesktopNavGroup,
} from "@flowlet/product-ui";
import {
  IconComment,
  IconHistogram,
  IconHistory,
  IconHome,
  IconKanban,
  IconList,
  IconPieChart2Stroked,
  IconServer,
  IconSetting,
} from "@douyinfe/semi-icons";
import styles from "./DesktopDemoApp.module.css";

type DemoPage = "overview" | "models" | "projects" | "logs" | "sessions" | "tasks" | "usage" | "usage-analysis" | "settings";

export function DesktopDemoApp() {
  const [active, setActive] = useState<DemoPage>("overview");
  const zh = !navigator.language.toLowerCase().startsWith("en");
  const groups: DesktopNavGroup[] = [
    { id: "workspace", label: zh ? "工作台" : "Workspace", items: [
      { id: "overview", label: zh ? "运行概览" : "Overview", icon: <IconHome /> },
      { id: "models", label: zh ? "模型服务" : "Models", icon: <IconServer /> },
      { id: "projects", label: zh ? "项目管理" : "Projects", icon: <IconKanban /> },
    ] },
    { id: "records", label: zh ? "运行记录" : "Activity", items: [
      { id: "logs", label: zh ? "请求日志" : "Requests", icon: <IconList /> },
      { id: "sessions", label: zh ? "会话管理" : "Sessions", icon: <IconComment /> },
      { id: "tasks", label: zh ? "任务日志" : "Tasks", icon: <IconHistory /> },
    ] },
    { id: "analysis", label: zh ? "分析" : "Analysis", items: [
      { id: "usage", label: zh ? "用量统计" : "Usage", icon: <IconHistogram /> },
      { id: "usage-analysis", label: zh ? "用量洞察" : "Usage insights", icon: <IconPieChart2Stroked /> },
    ] },
  ];
  const labels: Record<DemoPage, string> = {
    overview: zh ? "运行概览" : "Overview",
    models: zh ? "模型服务" : "Models",
    projects: zh ? "项目管理" : "Projects",
    logs: zh ? "请求日志" : "Requests",
    sessions: zh ? "会话管理" : "Sessions",
    tasks: zh ? "任务日志" : "Tasks",
    usage: zh ? "用量统计" : "Usage",
    "usage-analysis": zh ? "用量洞察" : "Usage insights",
    settings: zh ? "应用设置" : "Settings",
  };

  let content: React.ReactNode;
  switch (active) {
    case "models": content = <ModelsServiceDemoView zh={zh} />; break;
    case "projects": content = <ProjectsBoardDemoView zh={zh} />; break;
    case "logs": content = <RequestLogsDemoView zh={zh} />; break;
    case "sessions": content = <AgentSessionsDemoView zh={zh} />; break;
    case "usage-analysis": content = <UsageAnalysisDemoView zh={zh} />; break;
    case "usage": content = <UsageStatisticsDemoView zh={zh} />; break;
    case "tasks": content = <TaskLogsDemoView zh={zh} />; break;
    case "settings": content = <SettingsDemoView zh={zh} appVersion={__FLOWLET_APP_VERSION__} />; break;
    default: content = <DesktopOverviewDemoView zh={zh} />;
  }

  return (
    <DesktopAppFrameView sidebar={<DesktopSidebarView
      logo={<img src="/flowlet-logo.png" alt="" />}
      productName="Flowlet"
      version={`v${__FLOWLET_APP_VERSION__} · Demo`}
      groups={groups}
      activeId={active}
      settings={{ id: "settings", label: labels.settings, icon: <IconSetting /> }}
      onNavigate={(id) => setActive(id as DemoPage)}
    />}>
      <div className={styles.page}>{content}</div>
    </DesktopAppFrameView>
  );
}
