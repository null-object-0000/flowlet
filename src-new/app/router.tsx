import { lazy, Suspense } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell/AppShell";
import { OverviewPage } from "../pages/overview/OverviewPage";
import { RewritePlaceholderPage } from "../pages/rewrite-placeholder/RewritePlaceholderPage";
import { RequestLogsRouteFallback } from "../pages/request-logs/RequestLogsRouteFallback";

const RequestLogsPage = lazy(() => import("../pages/request-logs/RequestLogsPage").then((module) => ({ default: module.RequestLogsPage })));

export function AppRouter() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="models" element={<RewritePlaceholderPage title="模型服务" description="开放模型与高级路由正在按旧版功能边界迁移。" />} />
          <Route path="logs" element={<Suspense fallback={<RequestLogsRouteFallback />}><RequestLogsPage /></Suspense>} />
          <Route path="usage" element={<RewritePlaceholderPage title="用量成本" description="用量汇总与成本分析将在后续切片迁移。" />} />
          <Route path="settings" element={<RewritePlaceholderPage title="高级设置" description="应用设置和高级路由能力将在后续切片迁移。" />} />
          <Route path="agents" element={<RewritePlaceholderPage title="AI Agent 接入" description="完整 Agent 配置、复制与检测能力将在后续切片迁移。" />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
