import { lazy, Suspense } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell/AppShell";
import { OverviewPage } from "../pages/overview/OverviewPage";
import { RewritePlaceholderPage } from "../pages/rewrite-placeholder/RewritePlaceholderPage";
import { RequestLogsRouteFallback } from "../pages/request-logs/RequestLogsRouteFallback";
import { SettingsPage } from "../pages/settings/SettingsPage";
import { useAppPreferences } from "./preferences/AppPreferences";

const RequestLogsPage = lazy(() => import("../pages/request-logs/RequestLogsPage").then((module) => ({ default: module.RequestLogsPage })));

export function AppRouter() {
  const { t } = useAppPreferences();
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="models" element={<RewritePlaceholderPage title={t("模型服务")} description={t("开放模型与高级路由正在按旧版功能边界迁移。")} />} />
          <Route path="logs" element={<Suspense fallback={<RequestLogsRouteFallback />}><RequestLogsPage /></Suspense>} />
          <Route path="usage" element={<RewritePlaceholderPage title={t("用量成本")} description={t("用量汇总与成本分析将在后续切片迁移。")} />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="agents" element={<RewritePlaceholderPage title={t("AI Agent 接入")} description={t("完整 Agent 配置、复制与检测能力将在后续切片迁移。")} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
