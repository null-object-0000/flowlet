import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const windowApi = vi.hoisted(() => ({
  resizeBegin: vi.fn(),
  resizeEnd: vi.fn(),
}));

vi.mock("../../platform/desktop/bridge", () => ({ requireDesktopWindowBridge: () => windowApi }));
vi.mock("../../platform/desktop/mode", () => ({ isDesktopHost: true }));

import { WindowResizeHandles } from "./WindowResizeHandles";

describe("WindowResizeHandles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    windowApi.resizeBegin.mockResolvedValue(undefined);
    windowApi.resizeEnd.mockResolvedValue(undefined);
  });

  it("starts resizing with the matching direction on left-button mousedown", async () => {
    render(<WindowResizeHandles />);

    fireEvent.mouseDown(screen.getByTestId("resize-handle-SouthEast"), {
      buttons: 1, screenX: 120, screenY: 240,
    });

    await waitFor(() => expect(windowApi.resizeBegin).toHaveBeenCalledWith({ direction: "SouthEast", screenX: 120, screenY: 240 }));
    fireEvent.mouseUp(window);
    await waitFor(() => expect(windowApi.resizeEnd).toHaveBeenCalledOnce());
  });

  it("maps all eight directions to resize handles", () => {
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
      expect(screen.getByTestId(`resize-handle-${direction}`)).toBeInTheDocument();
    }
  });

  it("ignores non-primary mouse buttons", () => {
    render(<WindowResizeHandles />);

    fireEvent.mouseDown(screen.getByTestId("resize-handle-West"), { buttons: 2 });

    expect(windowApi.resizeBegin).not.toHaveBeenCalled();
  });
});
