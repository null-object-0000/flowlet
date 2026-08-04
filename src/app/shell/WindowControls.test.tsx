import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const windowApi = vi.hoisted(() => ({
  startDragging: vi.fn<() => Promise<void>>(),
  minimize: vi.fn<() => Promise<void>>(),
  isMaximized: vi.fn<() => Promise<boolean>>(),
  onResized: vi.fn<(handler: () => void) => Promise<() => void>>(),
  toggleMaximize: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowApi,
}));

vi.mock("../preferences/AppPreferences", () => ({
  useAppPreferences: () => ({ t: (key: string) => key }),
}));

import { WindowControls } from "./WindowControls";

describe("WindowControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    windowApi.startDragging.mockResolvedValue();
    windowApi.minimize.mockResolvedValue();
    windowApi.isMaximized.mockResolvedValue(false);
    windowApi.onResized.mockResolvedValue(vi.fn());
    windowApi.toggleMaximize.mockResolvedValue();
    windowApi.close.mockResolvedValue();
  });

  it("starts window dragging on a single left-button mousedown", () => {
    render(<WindowControls />);

    fireEvent.mouseDown(screen.getByTestId("titlebar-drag-region"), { buttons: 1, detail: 1 });

    expect(windowApi.startDragging).toHaveBeenCalledOnce();
    expect(windowApi.toggleMaximize).not.toHaveBeenCalled();
  });

  it("extends the drag region to the window left edge in standalone mode", () => {
    render(<WindowControls standalone />);

    const region = screen.getByTestId("titlebar-drag-region");
    expect(region.className).toContain("dragRegionStandalone");
  });

  it("keeps the sidebar offset drag region for the main window by default", () => {
    render(<WindowControls />);

    const region = screen.getByTestId("titlebar-drag-region");
    expect(region.className).not.toContain("dragRegionStandalone");
  });

  it("toggles maximize on a double mousedown without starting a drag or selecting text", () => {
    render(<WindowControls />);

    const node = screen.getByTestId("titlebar-drag-region");
    const event = new MouseEvent("mousedown", { bubbles: true, buttons: 1, detail: 2 });
    const preventDefault = vi.spyOn(event, "preventDefault");
    node.dispatchEvent(event);

    expect(windowApi.toggleMaximize).toHaveBeenCalledOnce();
    expect(windowApi.startDragging).not.toHaveBeenCalled();
    // 双击最大化的同时，必须阻止默认的文本选中行为。
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("ignores non-primary mouse buttons on the drag region", () => {
    render(<WindowControls />);

    fireEvent.mouseDown(screen.getByTestId("titlebar-drag-region"), { buttons: 2, detail: 1 });

    expect(windowApi.startDragging).not.toHaveBeenCalled();
    expect(windowApi.toggleMaximize).not.toHaveBeenCalled();
  });

  it("minimizes the window", () => {
    render(<WindowControls />);

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));

    expect(windowApi.minimize).toHaveBeenCalledOnce();
  });

  it("toggles maximize from the control button", () => {
    render(<WindowControls />);

    fireEvent.click(screen.getByRole("button", { name: "最大化" }));

    expect(windowApi.toggleMaximize).toHaveBeenCalledOnce();
  });

  it("closes the window", () => {
    render(<WindowControls />);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(windowApi.close).toHaveBeenCalledOnce();
  });
});
