import { Toast } from "@douyinfe/semi-ui-19";

export const APP_OVERLAY_Z_INDEX = {
  sideSheet: 1100,
  modal: 1200,
  toast: 1300,
} as const;

export function configureAppOverlayLayers() {
  Toast.config({ zIndex: APP_OVERLAY_Z_INDEX.toast });
}
