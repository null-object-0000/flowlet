import "@douyinfe/semi-ui-19/react19-adapter";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { applyInitialPreferences } from "./app/preferences/AppPreferences";
import "./styles/reset.css";
import "./styles/tokens.css";
export function renderApp(root: HTMLElement) {
  applyInitialPreferences();
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
