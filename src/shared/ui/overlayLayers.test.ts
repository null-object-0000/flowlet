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
    vi.useRealTimers();
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

  it("keeps mobile feedback below the system safe area", () => {
    const config = vi.spyOn(Toast, "config");

    configureAppOverlayLayers({ mobile: true });

    expect(config).toHaveBeenCalledWith({
      zIndex: APP_OVERLAY_Z_INDEX.toast,
      top: "calc(env(safe-area-inset-top, 0px) + 12px)",
    });
    config.mockRestore();
  });

  it("starts window dragging on a single mousedown on the header blank area", () => {
    const startDragging = vi.fn<() => Promise<void>>().mockResolvedValue();
    const toggleMaximize = vi.fn<() => Promise<void>>().mockResolvedValue();
    const header = document.createElement("div");
    header.className = "semi-sidesheet-header";
    const blank = document.createElement("span");
    blank.textContent = "详情";
    header.append(blank);
    document.body.append(header);
    cleanup = configureSideSheetWindowDragging(startDragging, toggleMaximize);

    blank.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1, detail: 1 }));

    expect(startDragging).toHaveBeenCalledOnce();
    expect(toggleMaximize).not.toHaveBeenCalled();
  });

  it("toggles maximize on a double mousedown without starting a drag", () => {
    const startDragging = vi.fn<() => Promise<void>>().mockResolvedValue();
    const toggleMaximize = vi.fn<() => Promise<void>>().mockResolvedValue();
    const header = document.createElement("div");
    header.className = "semi-sidesheet-header";
    const blank = document.createElement("span");
    blank.textContent = "详情";
    header.append(blank);
    document.body.append(header);
    cleanup = configureSideSheetWindowDragging(startDragging, toggleMaximize);

    const event = new MouseEvent("mousedown", { bubbles: true, buttons: 1, detail: 2 });
    const preventDefault = vi.spyOn(event, "preventDefault");
    blank.dispatchEvent(event);

    expect(toggleMaximize).toHaveBeenCalledOnce();
    expect(startDragging).not.toHaveBeenCalled();
    // 双击时必须阻止默认的文本选中行为。
    expect(preventDefault).toHaveBeenCalled();
  });

  it("supports dragging on the SideSheet header title blank area too", () => {
    const startDragging = vi.fn<() => Promise<void>>().mockResolvedValue();
    const toggleMaximize = vi.fn<() => Promise<void>>().mockResolvedValue();
    const header = document.createElement("div");
    header.className = "semi-sidesheet-header";
    const title = document.createElement("div");
    title.className = "semi-sidesheet-title";
    title.textContent = "Token 用量明细";
    header.append(title);
    document.body.append(header);
    cleanup = configureSideSheetWindowDragging(startDragging, toggleMaximize);

    title.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1, detail: 1 }));

    expect(startDragging).toHaveBeenCalledOnce();
  });

  it("keeps SideSheet header controls interactive", () => {
    const startDragging = vi.fn<() => Promise<void>>().mockResolvedValue();
    const toggleMaximize = vi.fn<() => Promise<void>>().mockResolvedValue();
    const header = document.createElement("div");
    header.className = "semi-sidesheet-header";
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    tab.textContent = "CLI 接入";
    const close = document.createElement("button");
    close.textContent = "关闭";
    header.append(tab, close);
    document.body.append(header);
    cleanup = configureSideSheetWindowDragging(startDragging, toggleMaximize);

    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1, detail: 1 }));
    close.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1, detail: 1 }));

    expect(startDragging).not.toHaveBeenCalled();
    expect(toggleMaximize).not.toHaveBeenCalled();
  });

  it("ignores right-button clicks on the header", () => {
    const startDragging = vi.fn<() => Promise<void>>().mockResolvedValue();
    const toggleMaximize = vi.fn<() => Promise<void>>().mockResolvedValue();
    const header = document.createElement("div");
    header.className = "semi-sidesheet-header";
    const blank = document.createElement("span");
    blank.textContent = "详情";
    header.append(blank);
    document.body.append(header);
    cleanup = configureSideSheetWindowDragging(startDragging, toggleMaximize);

    blank.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 2, detail: 1 }));

    expect(startDragging).not.toHaveBeenCalled();
    expect(toggleMaximize).not.toHaveBeenCalled();
  });
});
