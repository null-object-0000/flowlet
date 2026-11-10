import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resizeBridge = {
  resizeBegin: vi.fn(async () => undefined),
  resizeEnd: vi.fn(async () => undefined),
};

function setBridge(bridge: unknown) {
  (window as { flowletDesktop?: unknown }).flowletDesktop = bridge;
}

async function loadResizeHandles() {
  vi.stubEnv("MODE", "desktop");
  vi.resetModules();
  return (await import("./WindowResizeHandles")).WindowResizeHandles;
}

/**
 * Electron desktop（HG-2 降级）：缩放手柄不再调用 Tauri `startResizeDragging`，
 * 而是把方向 + 初始屏幕坐标交给 preload 桥的 `resizeBegin`（主进程 setBounds 跟随）。
 */
describe("WindowResizeHandles in Electron desktop mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBridge({
      window: {
        minimize: vi.fn(),
        toggleMaximize: vi.fn(),
        close: vi.fn(),
        isMaximized: vi.fn(),
        onMaximizedChanged: vi.fn(),
        resizeBegin: resizeBridge.resizeBegin,
        resizeEnd: resizeBridge.resizeEnd,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    setBridge(undefined);
  });

  it("starts a bridge-driven resize with the direction and screen coordinates", async () => {
    const WindowResizeHandles = await loadResizeHandles();
    render(<WindowResizeHandles />);

    fireEvent.mouseDown(screen.getByTestId("resize-handle-SouthEast"), {
      buttons: 1,
      screenX: 120,
      screenY: 80,
    });

    await waitFor(() =>
      expect(resizeBridge.resizeBegin).toHaveBeenCalledWith({
        direction: "SouthEast",
        screenX: 120,
        screenY: 80,
      }),
    );

    fireEvent.mouseUp(window);
    await waitFor(() => expect(resizeBridge.resizeEnd).toHaveBeenCalledOnce());
  });

  it("forwards every handle direction unchanged to the desktop bridge", async () => {
    const WindowResizeHandles = await loadResizeHandles();
    render(<WindowResizeHandles />);

    for (const direction of [
      "NorthWest",
      "North",
      "NorthEast",
      "East",
      "SouthEast",
      "South",
      "SouthWest",
      "West",
    ]) {
      fireEvent.mouseDown(screen.getByTestId(`resize-handle-${direction}`), {
        buttons: 1,
        screenX: 1,
        screenY: 2,
      });
      fireEvent.mouseUp(window);
      await waitFor(() =>
        expect(resizeBridge.resizeBegin).toHaveBeenCalledWith({
          direction,
          screenX: 1,
          screenY: 2,
        }),
      );
    }
  });
});