import { lazy, Suspense } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell/AppShell";
import { OverviewPage } from "../pages/overview/OverviewPage";
import { RequestLogsRouteFallback } from "../pages/request-logs/RequestLogsRouteFallback";
import { SettingsPage } from "../pages/settings/SettingsPage";
import { ModelServicesPage } from "../pages/models/ModelServicesPage";
import { UsageCostPage } from "../pages/usage/UsageCostPage";

const RequestLogsPage = lazy(() => import("../pages/request-logs/RequestLogsPage").then((module) => ({ default: module.RequestLogsPage })));

export function AppRouter() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="models" element={<ModelServicesPage />} />
          <Route path="logs" element={<Suspense fallback={<RequestLogsRouteFallback />}><RequestLogsPage /></Suspense>} />
          <Route path="usage" element={<UsageCostPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
