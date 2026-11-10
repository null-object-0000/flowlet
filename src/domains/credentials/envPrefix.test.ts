import { describe, expect, it } from "vitest";
import {
  envKeysForPrefix,
  isValidEnvPrefixInput,
  providerDefaultEnvPrefix,
  resolveEnvPrefix,
} from "./envPrefix";

describe("providerDefaultEnvPrefix", () => {
  it("uses the host-provided default prefix", () => {
    expect(providerDefaultEnvPrefix({ id: "dockhand", defaultEnvPrefix: "DOCKHAND" })).toBe("DOCKHAND");
    expect(providerDefaultEnvPrefix({ id: "gitlab", defaultEnvPrefix: "gitlab" })).toBe("GITLAB");
  });

  it("falls back to the provider id when an old host omits defaultEnvPrefix", () => {
    expect(providerDefaultEnvPrefix({ id: "gitlab" })).toBe("GITLAB");
    expect(providerDefaultEnvPrefix({ id: "dockhand" })).toBe("DOCKHAND");
    expect(providerDefaultEnvPrefix({ id: "custom" })).toBe("CUSTOM");
  });
});

describe("resolveEnvPrefix", () => {
  it("uses the fallback for blank values", () => {
    expect(resolveEnvPrefix("", "DOCKHAND")).toBe("DOCKHAND");
    expect(resolveEnvPrefix("   ", "DOCKHAND")).toBe("DOCKHAND");
    expect(resolveEnvPrefix(null, "GITLAB")).toBe("GITLAB");
    expect(resolveEnvPrefix(undefined, "GITLAB")).toBe("GITLAB");
  });

  it("trims and uppercases explicit prefixes", () => {
    expect(resolveEnvPrefix("  na  ", "DOCKHAND")).toBe("NA");
    expect(resolveEnvPrefix("sz", "DOCKHAND")).toBe("SZ");
  });
});

describe("envKeysForPrefix", () => {
  it("generates the two environment variable names", () => {
    expect(envKeysForPrefix("DOCKHAND_NA")).toEqual({
      url: "DOCKHAND_NA_URL",
      token: "DOCKHAND_NA_TOKEN",
    });
  });
});

describe("isValidEnvPrefixInput", () => {
  it("accepts blank (default prefix) and valid prefixes", () => {
    expect(isValidEnvPrefixInput("")).toBe(true);
    expect(isValidEnvPrefixInput("   ")).toBe(true);
    expect(isValidEnvPrefixInput("NA")).toBe(true);
    expect(isValidEnvPrefixInput("na")).toBe(true);
    expect(isValidEnvPrefixInput("SELF_2")).toBe(true);
    expect(isValidEnvPrefixInput("A".repeat(24))).toBe(true);
  });

  it("rejects invalid prefixes", () => {
    expect(isValidEnvPrefixInput("2NA")).toBe(false);
    expect(isValidEnvPrefixInput("NA-1")).toBe(false);
    expect(isValidEnvPrefixInput("_NA")).toBe(false);
    expect(isValidEnvPrefixInput("A".repeat(25))).toBe(false);
  });
});