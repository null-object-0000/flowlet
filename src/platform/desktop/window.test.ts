import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopWindowBridge } from "./bridge";

type WindowBridgeFns = {
  minimize: ReturnType<typeof vi.fn>;
  toggleMaximize: ReturnType<typeof vi.fn>;
  isMaximized: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onMaximizedChanged: ReturnType<typeof vi.fn>;
  resizeBegin: ReturnType<typeof vi.fn>;
  resizeEnd: ReturnType<typeof vi.fn>;
  startDragging: ReturnType<typeof vi.fn>;
  startResizeDragging: ReturnType<typeof vi.fn>;
};

function makeDesktopWindowBridge(): WindowBridgeFns {
  return {
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
    onMaximizedChanged: vi.fn((listener: (maximized: boolean) => void) => {
      void listener;
      return () => undefined;
    }),
    resizeBegin: vi.fn(async () => undefined),
    resizeEnd: vi.fn(async () => undefined),
    startDragging: vi.fn(async () => undefined),
    startResizeDragging: vi.fn(async () => undefined),
  };
}

function setBridge(bridge: unknown) {
  (window as { flowletDesktop?: unknown }).flowletDesktop = bridge;
}

async function loadWindowCommands(mode: "desktop" | "production") {
  vi.stubEnv("MODE", mode);
  vi.resetModules();
  return (await import("../host/window")).windowCommands;
}

describe("windowCommands transport selection", () => {
  let bridge: WindowBridgeFns;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = makeDesktopWindowBridge();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    setBridge(undefined);
  });

  it("routes electron desktop window commands to the preload bridge", async () => {
    setBridge({ adminToken: "token", window: bridge });
    const windowCommands = await loadWindowCommands("desktop");

    await windowCommands.minimize();
    await windowCommands.toggleMaximize();
    await windowCommands.close();
    await expect(windowCommands.isMaximized()).resolves.toBe(true);

    expect(bridge.minimize).toHaveBeenCalledOnce();
    expect(bridge.toggleMaximize).toHaveBeenCalledOnce();
    expect(bridge.close).toHaveBeenCalledOnce();
    expect(bridge.isMaximized).toHaveBeenCalledOnce();

  });

  it("maps the maximized-state subscription to window:maximized-changed", async () => {
    let capturedListener: ((maximized: boolean) => void) | undefined;
    const unsubscribe = vi.fn();
    bridge.onMaximizedChanged.mockImplementation((listener: (maximized: boolean) => void) => {
      capturedListener = listener;
      return unsubscribe;
    });
    setBridge({ window: bridge });
    const windowCommands = await loadWindowCommands("desktop");
    const onResize = vi.fn();

    const stopListening = await windowCommands.onResized(onResize);
    expect(bridge.onMaximizedChanged).toHaveBeenCalledOnce();

    capturedListener?.(true);
    expect(onResize).toHaveBeenCalledOnce();

    stopListening();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("uses the optional programmatic drag channels when the shell provides them", async () => {
    setBridge({ window: bridge });
    const windowCommands = await loadWindowCommands("desktop");

    await windowCommands.startDragging();
    await windowCommands.startResizeDragging("SouthEast");

    expect(bridge.startDragging).toHaveBeenCalledOnce();
    expect(bridge.startResizeDragging).toHaveBeenCalledWith("SouthEast");
  });

  it("rejects with a readable error when the desktop bridge is missing", async () => {
    const windowCommands = await loadWindowCommands("desktop");
    await expect(windowCommands.minimize()).rejects.toThrow(/桌面桥不可用/);
  });

  it.each(["production", "development", "web", "demo"])("never assumes a native window in %s without preload", async (mode) => {
    vi.stubEnv("MODE", mode);
    const { windowCommands } = await import("../host/window");
    await expect(windowCommands.minimize()).rejects.toThrow(/桌面桥不可用/);
    await expect(windowCommands.startResizeDragging("NorthWest")).rejects.toThrow(/桌面桥不可用/);
  });

  it("keeps window controls available in Electron client mode", async () => {
    setBridge({ mode: "client", window: bridge });
    const windowCommands = await loadWindowCommands("production");
    await windowCommands.close();
    expect(bridge.close).toHaveBeenCalledOnce();
  });

  it("exposes the desktop bridge contract required by the renderer", () => {
    // 编译期契约：preload 实现必须满足 DesktopWindowBridge 形状。
    const contract: DesktopWindowBridge = {
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      isMaximized: async () => false,
      close: async () => undefined,
      onMaximizedChanged: () => () => undefined,
      resizeBegin: async () => undefined,
      resizeEnd: async () => undefined,
    };
    expect(typeof contract.resizeBegin).toBe("function");
  });
});