import { hasDesktopBridge } from "./bridge";

/** Explicit desktop build or an actual Electron preload; browsers never imply native APIs. */
export function resolveDesktopHost(mode: string, desktopBridgePresent: boolean): boolean {
  return mode === "desktop" || desktopBridgePresent;
}

export const isDesktopHost = resolveDesktopHost(import.meta.env.MODE, hasDesktopBridge());

/** The preload's client declaration always restricts capabilities, including dev/web builds. */
export function resolveDesktopClient(_mode: string, bridgeMode: string | undefined): boolean {
  return bridgeMode === "client";
}

export const isDesktopClient = resolveDesktopClient(
  import.meta.env.MODE,
  hasDesktopBridge() ? window.flowletDesktop?.mode : undefined,
);
