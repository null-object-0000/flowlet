import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { MobileShell } from "./MobileShell";
import { MobileOverviewPage } from "./pages/MobileOverviewPage";
import { MobileSessionsPage } from "./pages/MobileSessionsPage";
import { MobileSettingsPage } from "./pages/MobileSettingsPage";

export function MobileRouter() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<MobileShell />}>
          <Route index element={<MobileOverviewPage />} />
          <Route path="usage" element={<Navigate to="/" replace />} />
          <Route path="devices" element={<Navigate to="/" replace />} />
          <Route path="sessions" element={<MobileSessionsPage />} />
          <Route path="settings" element={<MobileSettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
