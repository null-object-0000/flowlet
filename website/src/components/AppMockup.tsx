import { useState } from "react";
import {
  AgentSessionsDemoView,
  DesktopAppFrameView,
  DesktopOverviewDemoView,
  DesktopSidebarView,
  ModelsServiceDemoView,
  ProjectsBoardDemoView,
  RequestLogsDemoView,
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
import { useI18n } from "../i18n/I18nContext";
import styles from "./AppMockup.module.css";

type DemoPage = "overview" | "models" | "projects" | "requests" | "sessions" | "tasks" | "usage" | "insights";

export function AppMockup() {
  const { lang } = useI18n();
  const zh = lang === "zh";
  const [activePage, setActivePage] = useState<DemoPage>("overview");

  const navGroups: DesktopNavGroup[] = [
    { id: "workspace", label: zh ? "工作台" : "Workspace", items: [
      { id: "overview", label: zh ? "运行概览" : "Overview", icon: <IconHome /> },
      { id: "models", label: zh ? "模型服务" : "Models", icon: <IconServer /> },
      { id: "projects", label: zh ? "项目管理" : "Projects", icon: <IconKanban /> },
    ] },
    { id: "records", label: zh ? "运行记录" : "Activity", items: [
      { id: "requests", label: zh ? "请求日志" : "Requests", icon: <IconList /> },
      { id: "sessions", label: zh ? "会话管理" : "Sessions", icon: <IconComment /> },
      { id: "tasks", label: zh ? "任务日志" : "Tasks", icon: <IconHistory /> },
    ] },
    { id: "analysis", label: zh ? "分析" : "Analysis", items: [
      { id: "usage", label: zh ? "用量统计" : "Usage", icon: <IconHistogram /> },
      { id: "insights", label: zh ? "用量洞察" : "Insights", icon: <IconPieChart2Stroked /> },
    ] },
  ];

  const pageMeta: Record<DemoPage, { title: string; subtitle: string }> = {
    overview: { title: zh ? "运行概览" : "Overview", subtitle: zh ? "本地模型服务状态" : "Local model service" },
    models: { title: zh ? "模型服务" : "Model services", subtitle: zh ? "开放模型与路由候选" : "Exposed models and routes" },
    projects: { title: zh ? "项目管理" : "Projects", subtitle: zh ? "交给 Agent 执行的任务" : "Tasks delegated to agents" },
    requests: { title: zh ? "请求日志" : "Request log", subtitle: zh ? "真实上游请求与响应" : "Actual upstream requests" },
    sessions: { title: zh ? "会话管理" : "Sessions", subtitle: zh ? "Agent 原生会话与活动" : "Native agent sessions" },
    tasks: { title: zh ? "任务日志" : "Tasks", subtitle: zh ? "后台任务执行记录" : "Background task activity" },
    usage: { title: zh ? "用量统计" : "Usage", subtitle: zh ? "Token 与费用统计" : "Token and cost totals" },
    insights: { title: zh ? "用量洞察" : "Usage insights", subtitle: zh ? "Token、性能与费用" : "Tokens, performance and cost" },
  };

  let content: React.ReactNode;
  switch (activePage) {
    case "models": content = <ModelsServiceDemoView zh={zh} />; break;
    case "projects": content = <ProjectsBoardDemoView zh={zh} />; break;
    case "requests": content = <RequestLogsDemoView zh={zh} />; break;
    case "sessions": content = <AgentSessionsDemoView zh={zh} />; break;
    case "tasks": content = <div className={styles.placeholder}><strong>{zh ? "该页面 Demo 正在接入共享展示层" : "This demo is being migrated to the shared view layer"}</strong><span>{zh ? "真实应用功能不受影响。" : "The live application is unaffected."}</span></div>; break;
    case "usage": content = <UsageStatisticsDemoView zh={zh} />; break;
    case "insights": content = <UsageAnalysisDemoView zh={zh} />; break;
    default: content = <DesktopOverviewDemoView zh={zh} onOpenUsage={() => setActivePage("usage")} />;
  }

  return (
    <DesktopAppFrameView
      embedded
      sidebar={<DesktopSidebarView
        logo={<img src="/flowlet-logo.png" alt="" />}
        productName="Flowlet"
        version="v0.1.0"
        groups={navGroups}
        activeId={activePage}
        settings={{ id: "settings", label: zh ? "应用设置" : "Settings", icon: <IconSetting /> }}
        onNavigate={(id) => {
          if (["overview", "models", "projects", "requests", "sessions", "tasks", "usage", "insights"].includes(id)) setActivePage(id as DemoPage);
        }}
      />}
    >
      <div className={styles.sharedPage} aria-label={`${pageMeta[activePage].title} · ${pageMeta[activePage].subtitle}`}>{content}</div>
    </DesktopAppFrameView>
  );
}
