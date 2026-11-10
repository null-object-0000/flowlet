import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopBridgeUnavailableError,
  desktopAdminToken,
  getDesktopBridge,
  hasDesktopBridge,
  requireDesktopOpenExternal,
  requireDesktopWindowBridge,
} from "./bridge";

function setBridge(bridge: unknown) {
  (window as { flowletDesktop?: unknown }).flowletDesktop = bridge;
}

describe("desktop preload bridge", () => {
  afterEach(() => {
    setBridge(undefined);
  });

  it("reports absence without throwing when preload did not run", () => {
    expect(getDesktopBridge()).toBeUndefined();
    expect(hasDesktopBridge()).toBe(false);
    expect(desktopAdminToken()).toBe("");
    expect(() => requireDesktopWindowBridge()).toThrow(DesktopBridgeUnavailableError);
    expect(() => requireDesktopOpenExternal()).toThrow(DesktopBridgeUnavailableError);
  });

  it("exposes the preload management token for the web command client", () => {
    setBridge({ adminToken: "preload-admin-token" });
    expect(hasDesktopBridge()).toBe(true);
    expect(desktopAdminToken()).toBe("preload-admin-token");
  });

  it("returns empty token when the bridge has no token field", () => {
    setBridge({ window: {} });
    expect(desktopAdminToken()).toBe("");
  });

  it("returns the injected window and openExternal capabilities", async () => {
    const windowBridge = { minimize: async () => undefined };
    const openExternal = async () => undefined;
    setBridge({ window: windowBridge, openExternal });

    expect(requireDesktopWindowBridge()).toBe(windowBridge);
    expect(requireDesktopOpenExternal()).toBe(openExternal);
  });

  it("rejects a partially injected bridge instead of silently no-oping", () => {
    setBridge({ adminToken: "token-only" });
    expect(() => requireDesktopWindowBridge()).toThrow(/window\.flowletDesktop\.window/);
    expect(() => requireDesktopOpenExternal()).toThrow(/window\.flowletDesktop\.openExternal/);
  });
});