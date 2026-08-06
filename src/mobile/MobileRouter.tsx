import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { MobileShell } from "./MobileShell";
import { MobileOverviewPage } from "./pages/MobileOverviewPage";
import { MobileDevicesPage } from "./pages/MobileDevicesPage";
import { MobileSettingsPage } from "./pages/MobileSettingsPage";
import { MobileTasksPage } from "./pages/MobileTasksPage";
import { MobileDeviceSessionsPage } from "./pages/MobileDeviceSessionsPage";
import { MobileDeviceAgentsPage } from "./pages/MobileDeviceAgentsPage";

export function MobileRouter() {
  return (
    <HashRouter>
      <Routes>
        {/* 设备二级页：独立页面，无底部 Tab，返回回到设备页。 */}
        <Route path="devices/:deviceId/sessions" element={<MobileDeviceSessionsPage />} />
        <Route path="devices/:deviceId/agents" element={<MobileDeviceAgentsPage />} />

        <Route element={<MobileShell />}>
          <Route index element={<MobileOverviewPage />} />
          <Route path="devices" element={<MobileDevicesPage />} />
          <Route path="projects" element={<MobileTasksPage />} />
          <Route path="settings" element={<MobileSettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}