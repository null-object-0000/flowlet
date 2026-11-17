export type FrontendTarget = "desktop" | "web" | "demo";

/** No implicit native host: unknown/default browser builds use the Web management UI. */
export function resolveFrontendTarget(
  mode: string,
  desktop: boolean,
  client: boolean,
  demo = false,
): FrontendTarget {
  if (client) return "web";
  if (desktop) return "desktop";
  if (mode === "demo" || demo) return "demo";
  return "web";
}
