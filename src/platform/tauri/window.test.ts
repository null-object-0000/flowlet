import { beforeEach, describe, expect, it, vi } from "vitest";

const windowApi = vi.hoisted(() => ({
  startDragging: vi.fn<() => Promise<void>>(),
  startResizeDragging: vi.fn<(direction: string) => Promise<void>>(),
  minimize: vi.fn<() => Promise<void>>(),
  isMaximized: vi.fn<() => Promise<boolean>>(),
  onResized: vi.fn<(handler: () => void) => Promise<() => void>>(),
  toggleMaximize: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowApi,
}));

import { windowCommands } from "./window";

describe("windowCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    windowApi.startDragging.mockResolvedValue();
    windowApi.minimize.mockResolvedValue();
    windowApi.isMaximized.mockResolvedValue(false);
    windowApi.onResized.mockResolvedValue(vi.fn());
    windowApi.toggleMaximize.mockResolvedValue();
    windowApi.close.mockResolvedValue();
  });

  it("starts native window dragging", async () => {
    await windowCommands.startDragging();
    expect(windowApi.startDragging).toHaveBeenCalledOnce();
  });

  it("starts native resize dragging with the requested direction", async () => {
    await windowCommands.startResizeDragging("SouthEast");
    expect(windowApi.startResizeDragging).toHaveBeenCalledWith("SouthEast");
  });

  it("minimizes the native window", async () => {
    await windowCommands.minimize();
    expect(windowApi.minimize).toHaveBeenCalledOnce();
  });

  it("toggles native window maximization", async () => {
    await windowCommands.toggleMaximize();
    expect(windowApi.toggleMaximize).toHaveBeenCalledOnce();
  });

  it("reads and observes the native maximized state", async () => {
    const onResize = vi.fn();

    await expect(windowCommands.isMaximized()).resolves.toBe(false);
    await windowCommands.onResized(onResize);

    expect(windowApi.isMaximized).toHaveBeenCalledOnce();
    expect(windowApi.onResized).toHaveBeenCalledWith(onResize);
  });

  it("closes the native window", async () => {
    await windowCommands.close();
    expect(windowApi.close).toHaveBeenCalledOnce();
  });
});
