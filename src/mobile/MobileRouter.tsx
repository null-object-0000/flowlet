import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { MobileShell } from "./MobileShell";
import { MobileOverviewPage } from "./pages/MobileOverviewPage";
import { MobileDevicesPage } from "./pages/MobileDevicesPage";
import { MobileSessionsPage } from "./pages/MobileSessionsPage";
import { MobileSettingsPage } from "./pages/MobileSettingsPage";
import { MobileTasksPage } from "./pages/MobileTasksPage";

export function MobileRouter() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<MobileShell />}>
          <Route index element={<MobileOverviewPage />} />
          <Route path="usage" element={<Navigate to="/" replace />} />
          <Route path="devices" element={<MobileDevicesPage />} />
          <Route path="sessions" element={<MobileSessionsPage />} />
          <Route path="tasks" element={<MobileTasksPage />} />
          <Route path="settings" element={<MobileSettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
