import { describe, expect, it } from "vitest";
import {
  envKeyList,
  envKeysForPrefix,
  envKeysForProvider,
  isValidEnvPrefixInput,
  providerDefaultEnvPrefix,
  resolveEnvPrefix,
  suggestEnvPrefix,
} from "./envPrefix";

describe("providerDefaultEnvPrefix", () => {
  it("uses the host-provided default prefix", () => {
    expect(providerDefaultEnvPrefix({ id: "dockhand", defaultEnvPrefix: "DOCKHAND" })).toBe("DOCKHAND");
    expect(providerDefaultEnvPrefix({ id: "gitlab", defaultEnvPrefix: "gitlab" })).toBe("GITLAB");
  });

  it("falls back to the provider id when an old host omits defaultEnvPrefix", () => {
    expect(providerDefaultEnvPrefix({ id: "gitlab" })).toBe("GITLAB");
    expect(providerDefaultEnvPrefix({ id: "dockhand" })).toBe("DOCKHAND");
    expect(providerDefaultEnvPrefix({ id: "jenkins" })).toBe("JENKINS");
    expect(providerDefaultEnvPrefix({ id: "beszel" })).toBe("BESZEL");
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

describe("envKeysForProvider", () => {
  it("adds an identity key for username/email providers", () => {
    // Jenkins：Basic 认证 → 用户名 + token
    expect(envKeysForProvider("JENKINS_NA", "jenkins")).toEqual({
      url: "JENKINS_NA_URL",
      user: "JENKINS_NA_USER",
      token: "JENKINS_NA_TOKEN",
    });
    // Beszel：邮箱 + 密码（没有长期 API Token）
    expect(envKeysForProvider("BESZEL_NA", "beszel")).toEqual({
      url: "BESZEL_NA_URL",
      user: "BESZEL_NA_EMAIL",
      token: "BESZEL_NA_PASSWORD",
    });
    expect(envKeysForProvider("DOCKHAND_NA", "dockhand")).toEqual({
      url: "DOCKHAND_NA_URL",
      user: null,
      token: "DOCKHAND_NA_TOKEN",
    });
    expect(envKeysForProvider("GITLAB", "gitlab")).toEqual({
      url: "GITLAB_URL",
      user: null,
      token: "GITLAB_TOKEN",
    });
  });
});

describe("envKeyList", () => {
  it("returns the ordered keys and drops the unused identity slot", () => {
    expect(envKeyList(envKeysForProvider("BESZEL_NA", "beszel"))).toEqual([
      "BESZEL_NA_URL",
      "BESZEL_NA_EMAIL",
      "BESZEL_NA_PASSWORD",
    ]);
    expect(envKeyList(envKeysForProvider("JENKINS_NA", "jenkins"))).toEqual([
      "JENKINS_NA_URL",
      "JENKINS_NA_USER",
      "JENKINS_NA_TOKEN",
    ]);
    expect(envKeyList(envKeysForProvider("DOCKHAND_NA", "dockhand"))).toEqual([
      "DOCKHAND_NA_URL",
      "DOCKHAND_NA_TOKEN",
    ]);
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
describe("suggestEnvPrefix", () => {
  it("derives the prefix from ASCII fragments of the name", () => {
    expect(suggestEnvPrefix({ providerDefault: "DOCKHAND", name: "公司 Dockhand NA" })).toBe("DOCKHAND_NA");
    expect(suggestEnvPrefix({ providerDefault: "GITLAB", name: "gitlab sz 线上" })).toBe("GITLAB_SZ");
    expect(suggestEnvPrefix({ providerDefault: "JENKINS", name: "Jenkins-build 01" })).toBe("JENKINS_BUILD_01");
    expect(suggestEnvPrefix({ providerDefault: "BESZEL", name: "Beszel 监控 hub" })).toBe("BESZEL_HUB");
  });

  it("falls back to the provider default for non-ASCII names", () => {
    expect(suggestEnvPrefix({ providerDefault: "DOCKHAND", name: "公司-北美-线上" })).toBe("DOCKHAND");
    expect(suggestEnvPrefix({ providerDefault: "GITLAB", name: "", note: "" })).toBe("GITLAB");
  });

  it("uses the note when the name has no usable fragment, and dedupes the default word", () => {
    expect(suggestEnvPrefix({ providerDefault: "DOCKHAND", name: "北美", note: "dockhand self" })).toBe(
      "DOCKHAND_SELF",
    );
    // 名称与备注片段都参与拼接，重复片段只保留一次。
    expect(suggestEnvPrefix({ providerDefault: "GITLAB", name: "公司 sz", note: "sz 线上" })).toBe("GITLAB_SZ");
  });

  it("avoids prefixes already used by other credentials", () => {
    expect(
      suggestEnvPrefix({ providerDefault: "DOCKHAND", name: "北美", used: ["DOCKHAND"] }),
    ).toBe("DOCKHAND_2");
    expect(
      suggestEnvPrefix({
        providerDefault: "DOCKHAND",
        name: "公司 Dockhand NA",
        used: ["DOCKHAND_NA", "DOCKHAND_NA_2"],
      }),
    ).toBe("DOCKHAND_NA_3");
    // 不同服务已占用同名时同样避让
    expect(
      suggestEnvPrefix({ providerDefault: "GITLAB", name: "NA", used: ["GITLAB_NA"] }),
    ).toBe("GITLAB_NA_2");
  });

  it("keeps the result within 24 chars and always valid", () => {
    const suggestion = suggestEnvPrefix({
      providerDefault: "DOCKHAND",
      name: "north america production instance one",
    });
    expect(suggestion.length).toBeLessThanOrEqual(24);
    expect(suggestion).toMatch(/^[A-Z][A-Z0-9_]{0,23}$/);
    expect(suggestion.endsWith("_")).toBe(false);

    const conflict = suggestEnvPrefix({
      providerDefault: "DOCKHAND",
      name: "north america production instance one",
      used: [suggestion],
    });
    expect(conflict.length).toBeLessThanOrEqual(24);
    expect(conflict).toMatch(/^[A-Z][A-Z0-9_]{0,23}$/);
    expect(conflict).not.toBe(suggestion);
    expect(isValidEnvPrefixInput(conflict)).toBe(true);
  });
});
