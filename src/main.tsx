import "@douyinfe/semi-ui-19/react19-adapter";
import React from "react";
import ReactDOM from "react-dom/client";
import { applyInitialPreferences } from "./app/preferences/AppPreferences";
import { resolveDesktopClient } from "./platform/desktop/mode";
import { isDesktopHost } from "./platform/desktop/mode";
import { configureAppOverlayLayers, configureSideSheetWindowDragging } from "./shared/ui/overlayLayers";
import "./styles/reset.css";
import "./styles/tokens.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Flowlet root element was not found");
}
const appRoot = root;

const webTarget = import.meta.env.MODE === "web";
/** Electron desktop 壳（preload 注入 `window.flowletDesktop`）。 */
const desktopTarget = isDesktopHost;
/**
 * Electron 客户端模式：本机只跑 Client Gateway，界面按 Web 管理台渲染
 * （远程观测 + 管理，本机 Agent 接入/抓取/跨设备同步等桌面能力隐藏）。
 */
const desktopClientTarget =
  desktopTarget && resolveDesktopClient(import.meta.env.MODE, window.flowletDesktop?.mode);
const mobileTarget = !webTarget && !desktopTarget && (
  import.meta.env.MODE === "mobile"
  || import.meta.env.VITE_FLOWLET_TARGET === "mobile"
  || import.meta.env.TAURI_ENV_PLATFORM === "android"
  || import.meta.env.TAURI_ENV_PLATFORM === "ios"
  || /\b(?:Android|iPhone|iPad|iPod)\b/i.test(navigator.userAgent)
);
const demoTarget = !desktopTarget && (import.meta.env.MODE === "demo" || import.meta.env.VITE_FLOWLET_DEMO === "true");

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
// 与移动端保留默认行为。Electron desktop 壳同样适用。preventDefault 只抑制默认
// 菜单，不阻断 DOM 事件本身，应用后续如需自定义右键菜单仍可正常触发。
if (!mobileTarget && !demoTarget && !webTarget && import.meta.env.PROD) {
  document.addEventListener("contextmenu", (event) => event.preventDefault());
}
// 无边框窗口壳（Tauri 与 Electron desktop 都渲染 WindowControls）：
// `windowCommands` 内部按运行模式分派——Tauri 走原生 window API，desktop 走
// preload IPC 桥（不触碰 `__TAURI_INTERNALS__`）。抽屉头部的拖动/双击最大化在
// desktop 下由 `-webkit-app-region` 交给平台处理（HG-2 降级），不再用 JS 拦截。
if (!mobileTarget && !demoTarget && !webTarget) {
  void import("./platform/tauri/window").then(({ windowCommands }) => {
    configureSideSheetWindowDragging(
      windowCommands.startDragging,
      windowCommands.toggleMaximize,
      { desktop: desktopTarget },
    );
  });
}

async function renderApp() {
  // 默认分支：Tauri 桌面壳与 Electron desktop 壳都渲染正式桌面应用（App），
  // 不是 WebApp / mobile / demo。
  const RootApp = webTarget || desktopClientTarget
    ? (await import("./web/WebApp")).WebApp
    : demoTarget
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
