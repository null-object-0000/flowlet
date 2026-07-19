import { Toast } from "@douyinfe/semi-ui-19";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_OVERLAY_Z_INDEX, configureAppOverlayLayers, configureSideSheetWindowDragging } from "./overlayLayers";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

describe("app overlay layers", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.replaceChildren();
  });

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

  it("starts window dragging from a SideSheet header blank area", () => {
    const startDragging = vi.fn<() => Promise<void>>().mockResolvedValue();
    const header = document.createElement("div");
    header.className = "semi-sidesheet-header";
    const title = document.createElement("span");
    title.textContent = "详情";
    header.append(title);
    document.body.append(header);
    cleanup = configureSideSheetWindowDragging(startDragging);

    title.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));

    expect(startDragging).toHaveBeenCalledOnce();
  });

  it("keeps SideSheet header controls interactive", () => {
    const startDragging = vi.fn<() => Promise<void>>().mockResolvedValue();
    const header = document.createElement("div");
    header.className = "semi-sidesheet-header";
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    tab.textContent = "CLI 接入";
    const close = document.createElement("button");
    close.textContent = "关闭";
    header.append(tab, close);
    document.body.append(header);
    cleanup = configureSideSheetWindowDragging(startDragging);

    tab.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    close.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));

    expect(startDragging).not.toHaveBeenCalled();
  });
});
