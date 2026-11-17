import { describe, expect, it } from "vitest";
import { resolveFrontendTarget } from "./mode";

describe("frontend target selection", () => {
  it.each(["development", "production", "web", "test", "unknown"])("uses the Web management UI in browser %s", (mode) => {
    expect(resolveFrontendTarget(mode, false, false)).toBe("web");
  });
  it("keeps demo explicit and offline", () => {
    expect(resolveFrontendTarget("demo", false, false)).toBe("demo");
    expect(resolveFrontendTarget("development", false, false, true)).toBe("demo");
  });
  it("uses the local Host UI only for desktop", () => {
    expect(resolveFrontendTarget("desktop", true, false)).toBe("desktop");
    expect(resolveFrontendTarget("development", true, false, true)).toBe("desktop");
  });
  it.each(["desktop", "web", "development", "demo"])("keeps client capability restrictions in %s", (mode) => {
    expect(resolveFrontendTarget(mode, true, true, true)).toBe("web");
  });
});
