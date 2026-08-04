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

// 抽屉头部只有「空白区域」作为窗口拖拽区；标题、按钮、标签等有内容或交互的
// 元素保持原有功能（如标题文字可选中、按钮可点击），不参与拖拽。
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
  ".semi-sidesheet-title",
].join(",");

export function configureSideSheetWindowDragging(startDragging: () => Promise<void>) {
  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(".semi-sidesheet-header")) return;
    if (target.closest(SIDE_SHEET_DRAG_EXCLUDE_SELECTOR)) return;

    event.preventDefault();
    void startDragging().catch((error) => {
      console.error("Failed to start window dragging from SideSheet header", error);
    });
  };

  document.addEventListener("pointerdown", handlePointerDown);
  return () => document.removeEventListener("pointerdown", handlePointerDown);
}
