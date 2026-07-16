import { beforeEach, describe, expect, it, vi } from "vitest";

const windowApi = vi.hoisted(() => ({
  startDragging: vi.fn<() => Promise<void>>(),
  minimize: vi.fn<() => Promise<void>>(),
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
    windowApi.close.mockResolvedValue();
  });

  it("starts native window dragging", async () => {
    await windowCommands.startDragging();
    expect(windowApi.startDragging).toHaveBeenCalledOnce();
  });

  it("minimizes the native window", async () => {
    await windowCommands.minimize();
    expect(windowApi.minimize).toHaveBeenCalledOnce();
  });

  it("closes the native window", async () => {
    await windowCommands.close();
    expect(windowApi.close).toHaveBeenCalledOnce();
  });
});
