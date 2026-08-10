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
const demoTarget = import.meta.env.MODE === "demo" || import.meta.env.VITE_FLOWLET_DEMO === "true";

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
// 正式版 PC 桌面应用禁用 WebView 默认的浏览器右键菜单（刷新、返回、检查元素等
// 浏览器能力）。只在真实桌面应用的生产构建生效：开发调试（tauri dev）、官网 Demo
// 与移动端保留默认行为。preventDefault 只抑制默认菜单，不阻断 DOM 事件本身，
// 应用后续如需自定义右键菜单仍可正常触发。
if (!mobileTarget && !demoTarget && import.meta.env.PROD) {
  document.addEventListener("contextmenu", (event) => event.preventDefault());
}
if (!mobileTarget && !demoTarget) {
  void import("./platform/tauri/window").then(({ windowCommands }) => {
    configureSideSheetWindowDragging(windowCommands.startDragging, windowCommands.toggleMaximize);
  });
}

async function renderApp() {
  const RootApp = demoTarget
    ? (await import("./demo/DesktopDemoApp")).DesktopDemoApp
    : mobileTarget
      ? (await import("./mobile/MobileApp")).MobileApp
      : (await import("./app/App")).default;
  ReactDOM.createRoot(appRoot).render(
    <React.StrictMode>
      <RootApp />
    </React.StrictMode>,
  );
}

void renderApp();
