import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const windowApi = vi.hoisted(() => ({
  startResizeDragging: vi.fn<(direction: string) => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowApi,
}));

import { WindowResizeHandles } from "./WindowResizeHandles";

describe("WindowResizeHandles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    windowApi.startResizeDragging.mockResolvedValue();
  });

  it("starts resizing with the matching direction on left-button mousedown", () => {
    render(<WindowResizeHandles />);

    fireEvent.mouseDown(screen.getByTestId("resize-handle-SouthEast"), {
      buttons: 1,
    });

    expect(windowApi.startResizeDragging).toHaveBeenCalledWith("SouthEast");
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

    expect(windowApi.startResizeDragging).not.toHaveBeenCalled();
  });
});
