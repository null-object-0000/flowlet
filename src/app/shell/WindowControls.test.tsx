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

  it("toggles maximize on a double mousedown without starting a drag", () => {
    render(<WindowControls />);

    fireEvent.mouseDown(screen.getByTestId("titlebar-drag-region"), { buttons: 1, detail: 2 });

    expect(windowApi.toggleMaximize).toHaveBeenCalledOnce();
    expect(windowApi.startDragging).not.toHaveBeenCalled();
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
