import { Toast } from "@douyinfe/semi-ui-19";
import { describe, expect, it, vi } from "vitest";
import { APP_OVERLAY_Z_INDEX, configureAppOverlayLayers } from "./overlayLayers";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

describe("app overlay layers", () => {
  it("keeps feedback above dialogs and side sheets", () => {
    expect(APP_OVERLAY_Z_INDEX.modal).toBeGreaterThan(APP_OVERLAY_Z_INDEX.sideSheet);
    expect(APP_OVERLAY_Z_INDEX.toast).toBeGreaterThan(APP_OVERLAY_Z_INDEX.modal);
  });

  it("configures Semi Toast with the shared feedback layer", () => {
    const config = vi.spyOn(Toast, "config");

    configureAppOverlayLayers();

    expect(config).toHaveBeenCalledWith({ zIndex: APP_OVERLAY_Z_INDEX.toast });
    config.mockRestore();
  });
});
