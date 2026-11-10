import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDesktopClient, resolveDesktopHost } from "./mode";

function setBridge(bridge: unknown) {
  (window as { flowletDesktop?: unknown }).flowletDesktop = bridge;
}

describe("desktop mode detection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    delete (window as { flowletDesktop?: unknown }).flowletDesktop;
  });

  it("treats the desktop build mode as the Electron desktop shell", () => {
    expect(resolveDesktopHost("desktop", false)).toBe(true);
  });

  it("falls back to the preload bridge when the build mode is not desktop", () => {
    expect(resolveDesktopHost("web", true)).toBe(true);
    expect(resolveDesktopHost("production", true)).toBe(true);
    expect(resolveDesktopHost("development", true)).toBe(true);
  });

  it("never treats Web Host / Tauri / mobile / demo modes as desktop without the bridge", () => {
    for (const mode of ["web", "production", "development", "mobile", "demo"]) {
      expect(resolveDesktopHost(mode, false)).toBe(false);
    }
  });

  it("evaluates import.meta.env.MODE === 'desktop' at module load", async () => {
    vi.stubEnv("MODE", "desktop");
    vi.resetModules();
    const { isDesktopHost } = await import("./mode");
    expect(isDesktopHost).toBe(true);
  });

  it("uses the preload bridge as a load-time fallback even without the desktop mode", async () => {
    vi.stubEnv("MODE", "web");
    setBridge({ adminToken: "bridge-token" });
    vi.resetModules();
    const { isDesktopHost } = await import("./mode");
    expect(isDesktopHost).toBe(true);
  });

  it("客户端模式只在 desktop 构建且 preload 声明 client 时成立", async () => {
    expect(resolveDesktopClient("desktop", "client")).toBe(true);
    expect(resolveDesktopClient("desktop", "host")).toBe(false);
    expect(resolveDesktopClient("desktop", undefined)).toBe(false);
    // Web Host / Tauri / mobile 即使桥声明 client 也不是 Electron 客户端模式。
    for (const mode of ["web", "production", "development", "mobile", "demo"]) {
      expect(resolveDesktopClient(mode, "client")).toBe(false);
    }
  });

  it("客户端模式下按 Web 语义运行（isWebHost 为 true，命令走本机 HTTP 网关）", async () => {
    vi.stubEnv("MODE", "desktop");
    setBridge({ adminToken: "remote-token", mode: "client" });
    vi.resetModules();
    const { isDesktopClient } = await import("./mode");
    const { isWebHost } = await import("../web/mode");
    expect(isDesktopClient).toBe(true);
    expect(isWebHost).toBe(true);
  });

  it("主机模式下 isWebHost 仍为 false（桌面壳走本机命令面）", async () => {
    vi.stubEnv("MODE", "desktop");
    setBridge({ adminToken: "local-token", mode: "host" });
    vi.resetModules();
    const { isDesktopClient } = await import("./mode");
    const { isWebHost } = await import("../web/mode");
    expect(isDesktopClient).toBe(false);
    expect(isWebHost).toBe(false);
  });

  it("stays false in a non-desktop build without the bridge", async () => {
    vi.stubEnv("MODE", "web");
    vi.resetModules();
    const { isDesktopHost } = await import("./mode");
    expect(isDesktopHost).toBe(false);
  });
});