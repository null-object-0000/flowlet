import "@douyinfe/semi-ui-19/react19-adapter";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { applyInitialPreferences } from "./app/preferences/AppPreferences";
import { windowCommands } from "./platform/tauri/window";
import { configureAppOverlayLayers, configureSideSheetWindowDragging } from "./shared/ui/overlayLayers";
import "./styles/reset.css";
import "./styles/tokens.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Flowlet root element was not found");
}

applyInitialPreferences();
configureAppOverlayLayers();
configureSideSheetWindowDragging(windowCommands.startDragging);
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
