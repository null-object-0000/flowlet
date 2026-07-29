import "@douyinfe/semi-ui-19/react19-adapter";
import React from "react";
import ReactDOM from "react-dom/client";
import { applyInitialPreferences } from "./app/preferences/AppPreferences";
import { configureAppOverlayLayers, configureSideSheetWindowDragging } from "./shared/ui/overlayLayers";
import "./styles/reset.css";
import "./styles/tokens.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Flowlet root element was not found");
}
const appRoot = root;

const mobileTarget = import.meta.env.MODE === "mobile"
  || import.meta.env.VITE_FLOWLET_TARGET === "mobile"
  || import.meta.env.TAURI_ENV_PLATFORM === "android"
  || import.meta.env.TAURI_ENV_PLATFORM === "ios"
  || /\b(?:Android|iPhone|iPad|iPod)\b/i.test(navigator.userAgent);

if (mobileTarget) {
  document
    .querySelector<HTMLMetaElement>('meta[name="viewport"]')
    ?.setAttribute(
      "content",
      "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
    );
}

applyInitialPreferences();
configureAppOverlayLayers({ mobile: mobileTarget });
if (!mobileTarget) {
  void import("./platform/tauri/window").then(({ windowCommands }) => {
    configureSideSheetWindowDragging(windowCommands.startDragging);
  });
}

async function renderApp() {
  const RootApp = mobileTarget
    ? (await import("./mobile/MobileApp")).MobileApp
    : (await import("./app/App")).default;
  ReactDOM.createRoot(appRoot).render(
    <React.StrictMode>
      <RootApp />
    </React.StrictMode>,
  );
}

void renderApp();
