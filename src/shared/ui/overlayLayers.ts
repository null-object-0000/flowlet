import { Toast } from "@douyinfe/semi-ui-19";

export const APP_OVERLAY_Z_INDEX = {
  sideSheet: 1100,
  modal: 1200,
  toast: 1300,
} as const;

export function configureAppOverlayLayers() {
  Toast.config({ zIndex: APP_OVERLAY_Z_INDEX.toast });
}

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
