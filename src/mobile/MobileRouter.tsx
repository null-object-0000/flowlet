import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { MobileShell } from "./MobileShell";
import { MobileDevicesPage } from "./pages/MobileDevicesPage";
import { MobileOverviewPage } from "./pages/MobileOverviewPage";
import { MobileSettingsPage } from "./pages/MobileSettingsPage";
import { MobileUsagePage } from "./pages/MobileUsagePage";

export function MobileRouter() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<MobileShell />}>
          <Route index element={<MobileOverviewPage />} />
          <Route path="usage" element={<MobileUsagePage />} />
          <Route path="devices" element={<MobileDevicesPage />} />
          <Route path="settings" element={<MobileSettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
