import { isDesktopClient, isDesktopHost } from "../desktop/mode";
import { resolveFrontendTarget } from "../host/mode";

/** Web capability boundary also applies to browser development and Electron client mode. */
export const isWebHost = resolveFrontendTarget(
  import.meta.env.MODE,
  isDesktopHost,
  isDesktopClient,
  import.meta.env.VITE_FLOWLET_DEMO === "true",
) === "web";
