import { describe, expect, it } from "vitest";
import { platformLabel } from "./platform";

describe("platformLabel", () => {
  it("maps desktop OS families", () => {
    expect(platformLabel("windows")).toBe("Windows");
    expect(platformLabel("macos")).toBe("macOS");
    expect(platformLabel("darwin")).toBe("macOS");
    expect(platformLabel("linux")).toBe("Linux");
  });

  it("maps Linux distribution ids", () => {
    expect(platformLabel("ubuntu")).toBe("Ubuntu");
    expect(platformLabel("debian")).toBe("Debian");
    expect(platformLabel("fedora")).toBe("Fedora");
    expect(platformLabel("arch")).toBe("Arch");
    expect(platformLabel("manjaro")).toBe("Manjaro");
    expect(platformLabel("linuxmint")).toBe("Linux Mint");
    expect(platformLabel("centos")).toBe("CentOS");
    expect(platformLabel("rhel")).toBe("RHEL");
    expect(platformLabel("alpine")).toBe("Alpine");
    expect(platformLabel("opensuse-leap")).toBe("openSUSE");
    expect(platformLabel("opensuse-tumbleweed")).toBe("openSUSE");
  });

  it("maps mobile platforms", () => {
    expect(platformLabel("android")).toBe("Android");
    expect(platformLabel("ios")).toBe("iOS");
  });

  it("is case-insensitive", () => {
    expect(platformLabel("Ubuntu")).toBe("Ubuntu");
    expect(platformLabel("WINDOWS")).toBe("Windows");
  });

  it("falls back to title-case for unknown distribution ids", () => {
    expect(platformLabel("nixos")).toBe("Nixos");
    expect(platformLabel("void")).toBe("Void");
  });

  it("returns empty for missing or unknown values", () => {
    expect(platformLabel("")).toBe("");
    expect(platformLabel("unknown")).toBe("");
    expect(platformLabel("  ")).toBe("");
  });
});
