import { Toast } from "@douyinfe/semi-ui-19";

export const APP_OVERLAY_Z_INDEX = {
  sideSheet: 1100,
  modal: 1200,
  toast: 1300,
} as const;

export function configureAppOverlayLayers(options: { mobile?: boolean } = {}) {
  Toast.config({
    zIndex: APP_OVERLAY_Z_INDEX.toast,
    ...(options.mobile
      ? { top: "calc(env(safe-area-inset-top, 0px) + 12px)" }
      : {}),
  });
}

// 抽屉头部除明确交互元素外均可作为窗口拖拽区：标题文字不参与拖拽，但标题周围
// 及内部的空白区域应支持拖拽与双击。按钮、链接、输入框、Tab 等保持原有交互。
const SIDE_SHEET_DRAG_EXCLUDE_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "[contenteditable='true']",
  "[role='button']",
  "[role='combobox']",
  "[role='menuitem']",
  "[role='tab']",
  ".semi-input-wrapper",
  ".semi-select",
  ".semi-tabs-tab",
].join(",");

const DESKTOP_DRAG_STYLE_ID = "flowlet-desktop-window-drag-styles";

/**
 * Electron desktop 壳没有 Tauri `startDragging()` 的等价 API（HG-2），抽屉头部
 * 改用 CSS `-webkit-app-region: drag` 交给 Chromium 原生处理拖动（双击最大化同样
 * 由平台处理）。这里集中注入全局规则，避免页面/feature 各自覆盖 `.semi-sidesheet-*`。
 */
function installDesktopSideSheetDragRegions(): () => void {
  if (typeof document === "undefined") return () => undefined;
  if (document.getElementById(DESKTOP_DRAG_STYLE_ID)) return () => undefined;

  const style = document.createElement("style");
  style.id = DESKTOP_DRAG_STYLE_ID;
  style.textContent = [
    ".semi-sidesheet-header { -webkit-app-region: drag; }",
    `.semi-sidesheet-header :is(${SIDE_SHEET_DRAG_EXCLUDE_SELECTOR}) { -webkit-app-region: no-drag; }`,
  ].join("\n");
  document.head.appendChild(style);
  return () => style.remove();
}

/**
 * 让所有抽屉（Semi SideSheet）的公共标题栏空白区域支持窗口拖拽与双击最大化/还原。
 *
 * Tauri 桌面壳：与主窗口标题栏（WindowControls）同一套成熟方案——在 `mousedown`
 * 上读取 `event.detail`（双击时第二次 mousedown 的 detail 为 2），直接切换最大化/
 * 还原；否则立即进入系统拖动。注意不能依赖 `dblclick`（Windows 拖动模态会吞掉它），
 * 也绝不能先于本次判断去调用 `startDragging`（同样会吞掉第二次 mousedown）。
 * 双击操作作用于抽屉所在当前窗口（`toggleMaximize` 由 `getCurrentWindow()` 提供）。
 *
 * Electron desktop 壳（`options.desktop`）：走 CSS `-webkit-app-region: drag`，
 * 不再注册 mousedown 逻辑（也没有可调用的程序化拖动 API）。
 */
export function configureSideSheetWindowDragging(
  startDragging: () => Promise<void>,
  toggleMaximize?: () => Promise<void>,
  options: { desktop?: boolean } = {},
) {
  if (options.desktop) {
    return installDesktopSideSheetDragRegions();
  }

  const handleMouseDown = (event: MouseEvent) => {
    if (event.buttons !== 1) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(".semi-sidesheet-header")) return;
    if (target.closest(SIDE_SHEET_DRAG_EXCLUDE_SELECTOR)) return;

    if (event.detail === 2) {
      // 双击 header 空白：切换最大化/还原。preventDefault 阻断双击默认的文本选中。
      event.preventDefault();
      if (toggleMaximize) {
        void toggleMaximize().catch((error) => {
          console.error("Failed to toggle maximize from SideSheet header", error);
        });
      }
      return;
    }

    event.preventDefault();
    void startDragging().catch((error) => {
      console.error("Failed to start window dragging from SideSheet header", error);
    });
  };

  document.addEventListener("mousedown", handleMouseDown);
  return () => document.removeEventListener("mousedown", handleMouseDown);
}
