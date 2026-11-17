import "@douyinfe/semi-ui-19/react19-adapter";
import React from "react";
import ReactDOM from "react-dom/client";
import { applyInitialPreferences } from "./app/preferences/AppPreferences";
import { isDesktopClient, isDesktopHost } from "./platform/desktop/mode";
import { resolveFrontendTarget } from "./platform/host/mode";
import { configureAppOverlayLayers, configureSideSheetWindowDragging } from "./shared/ui/overlayLayers";
import "./styles/reset.css";
import "./styles/tokens.css";

const root = document.getElementById("root");
if (!root) throw new Error("Flowlet root element was not found");
const appRoot = root;
const target = resolveFrontendTarget(
  import.meta.env.MODE,
  isDesktopHost,
  isDesktopClient,
  import.meta.env.VITE_FLOWLET_DEMO === "true",
);

applyInitialPreferences();
configureAppOverlayLayers();
// Only the real Electron shell owns native titlebars/context-menu policy.
// Browser, demo and development builds retain normal browser behavior.
if (isDesktopHost && import.meta.env.PROD) {
  document.addEventListener("contextmenu", (event) => event.preventDefault());
}
if (isDesktopHost) {
  void import("./platform/host/window").then(({ windowCommands }) => {
    configureSideSheetWindowDragging(
      windowCommands.startDragging,
      windowCommands.toggleMaximize,
      { desktop: true },
    );
  });
}

async function renderApp() {
  const RootApp = target === "web"
    ? (await import("./web/WebApp")).WebApp
    : target === "demo"
      ? (await import("./demo/DesktopDemoApp")).DesktopDemoApp
      : (await import("./app/App")).default;
  ReactDOM.createRoot(appRoot).render(
    <React.StrictMode>
      <RootApp />
    </React.StrictMode>,
  );
}

void renderApp();
