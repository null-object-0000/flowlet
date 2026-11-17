import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowCommands } from "./window";

const windowApi = {
  startDragging: vi.fn<() => Promise<void>>(),
  startResizeDragging: vi.fn<(direction: string) => Promise<void>>(),
  minimize: vi.fn<() => Promise<void>>(),
  isMaximized: vi.fn<() => Promise<boolean>>(),
  onMaximizedChanged: vi.fn<(handler: (maximized: boolean) => void) => () => void>(),
  resizeBegin: vi.fn(),
  resizeEnd: vi.fn(),
  toggleMaximize: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
};

describe("windowCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.flowletDesktop = { window: windowApi };
    windowApi.startDragging.mockResolvedValue();
    windowApi.startResizeDragging.mockResolvedValue();
    windowApi.minimize.mockResolvedValue();
    windowApi.isMaximized.mockResolvedValue(false);
    windowApi.onMaximizedChanged.mockReturnValue(vi.fn());
    windowApi.toggleMaximize.mockResolvedValue();
    windowApi.close.mockResolvedValue();
  });
  afterEach(() => { delete window.flowletDesktop; });

  it("starts window dragging through the explicit bridge", async () => {
    await windowCommands.startDragging();
    expect(windowApi.startDragging).toHaveBeenCalledOnce();
  });
  it("starts resize dragging with the requested direction", async () => {
    await windowCommands.startResizeDragging("SouthEast");
    expect(windowApi.startResizeDragging).toHaveBeenCalledWith("SouthEast");
  });
  it("minimizes the window", async () => {
    await windowCommands.minimize();
    expect(windowApi.minimize).toHaveBeenCalledOnce();
  });
  it("toggles maximization", async () => {
    await windowCommands.toggleMaximize();
    expect(windowApi.toggleMaximize).toHaveBeenCalledOnce();
  });
  it("reads and observes maximized state and disposes its subscription", async () => {
    const onResize = vi.fn();
    await expect(windowCommands.isMaximized()).resolves.toBe(false);
    const stop = await windowCommands.onResized(onResize);
    windowApi.onMaximizedChanged.mock.calls[0][0](true);
    expect(onResize).toHaveBeenCalledOnce();
    stop();
    expect(windowApi.onMaximizedChanged.mock.results[0].value).toHaveBeenCalledOnce();
  });
  it("closes the window via the shell's hide-to-tray method", async () => {
    await windowCommands.close();
    expect(windowApi.close).toHaveBeenCalledOnce();
  });
});
