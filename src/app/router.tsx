import { lazy, Suspense } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell/AppShell";
import { OverviewPage } from "../pages/overview/OverviewPage";
import { RequestLogsRouteFallback } from "../pages/request-logs/RequestLogsRouteFallback";
import { SettingsPage } from "../pages/settings/SettingsPage";
import { ModelServicesPage } from "../pages/models/ModelServicesPage";
import { UsageCostPage } from "../pages/usage/UsageCostPage";
import { UsageAnalysisPage } from "../pages/usage-analysis/UsageAnalysisPage";
import { AgentSessionsPage } from "../pages/agent-sessions/AgentSessionsPage";
import { TaskLogsPage } from "../pages/task-logs/TaskLogsPage";
import { ProjectsPage } from "../pages/projects/ProjectsPage";
import { ProjectDetailWindow } from "../pages/projects/ProjectDetailWindow";

const RequestLogsPage = lazy(() => import("../pages/request-logs/RequestLogsPage").then((module) => ({ default: module.RequestLogsPage })));

export function AppRouter() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="models" element={<ModelServicesPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:projectId" element={<ProjectsPage />} />
          <Route path="logs" element={<Suspense fallback={<RequestLogsRouteFallback />}><RequestLogsPage /></Suspense>} />
          <Route path="sessions" element={<AgentSessionsPage />} />
          <Route path="tasks" element={<TaskLogsPage />} />
          <Route path="usage" element={<UsageCostPage />} />
          <Route path="usage-analysis" element={<UsageAnalysisPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
        {/* 独立窗口：项目详情看板（无侧边栏，自带无边框窗口控制条）。 */}
        <Route path="project-window/:projectId" element={<ProjectDetailWindow />} />
      </Routes>
    </HashRouter>
  );
}
