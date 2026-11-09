import { lazy, Suspense } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell/AppShell";
import { OverviewPage } from "../pages/overview/OverviewPage";
import { RequestLogsRouteFallback } from "../pages/request-logs/RequestLogsRouteFallback";
import { PageHeader } from "../shared/ui/PageHeader";
import { useAppPreferences } from "./preferences/AppPreferences";

const RequestLogsPage = lazy(() => import("../pages/request-logs/RequestLogsPage").then((module) => ({ default: module.RequestLogsPage })));
const SettingsPage = lazy(() => import("../pages/settings/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const ModelServicesPage = lazy(() => import("../pages/models/ModelServicesPage").then((module) => ({ default: module.ModelServicesPage })));
const UsageCostPage = lazy(() => import("../pages/usage/UsageCostPage").then((module) => ({ default: module.UsageCostPage })));
const UsageAnalysisPage = lazy(() => import("../pages/usage-analysis/UsageAnalysisPage").then((module) => ({ default: module.UsageAnalysisPage })));
const AgentSessionsPage = lazy(() => import("../pages/agent-sessions/AgentSessionsPage").then((module) => ({ default: module.AgentSessionsPage })));

function PageRouteFallback({ title }: { title: string }) {
  const { t } = useAppPreferences();
  return <main aria-busy="true"><PageHeader title={t(title)} /></main>;
}

export function AppRouter() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="models" element={<Suspense fallback={<PageRouteFallback title="模型服务" />}><ModelServicesPage /></Suspense>} />
          <Route path="logs" element={<Suspense fallback={<RequestLogsRouteFallback />}><RequestLogsPage /></Suspense>} />
          <Route path="sessions" element={<Suspense fallback={<PageRouteFallback title="会话管理" />}><AgentSessionsPage /></Suspense>} />
          <Route path="usage" element={<Suspense fallback={<PageRouteFallback title="用量统计" />}><UsageCostPage /></Suspense>} />
          <Route path="usage-analysis" element={<Suspense fallback={<PageRouteFallback title="用量洞察" />}><UsageAnalysisPage /></Suspense>} />
          <Route path="settings" element={<Suspense fallback={<PageRouteFallback title="应用设置" />}><SettingsPage /></Suspense>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
