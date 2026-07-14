import { HashRouter, Route, Routes } from "react-router-dom";
import { RewritePlaceholderPage } from "../pages/rewrite-placeholder/RewritePlaceholderPage";
import { AppShell } from "./shell/AppShell";

export function AppRouter() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<RewritePlaceholderPage />} />
          <Route path="*" element={<RewritePlaceholderPage />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}