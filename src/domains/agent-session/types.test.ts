import { describe, expect, it } from "vitest";
import { agentSessionLabel, hermesSessionOrigin, hermesSourceLabel } from "./types";

describe("agentSessionLabel", () => {
  it("labels DeepSeek Harness without falling back to OpenCode", () => {
    expect(agentSessionLabel("deepseek-harness")).toBe("DeepSeek Harness");
  });

  it("keeps an unknown future agent id visible", () => {
    expect(agentSessionLabel("future-agent")).toBe("future-agent");
  });
});

describe("hermesSourceLabel", () => {
  const t = (source: string) => source;

  it("maps known Hermes entry sources to readable labels", () => {
    expect(hermesSourceLabel("cli", t)).toBe("CLI");
    expect(hermesSourceLabel("feishu", t)).toBe("飞书");
    expect(hermesSourceLabel("cron", t)).toBe("定时任务");
  });

  it("keeps unknown sources and null/empty raw", () => {
    expect(hermesSourceLabel("telegram", t)).toBe("telegram");
    expect(hermesSourceLabel(null, t)).toBeUndefined();
    expect(hermesSourceLabel(undefined, t)).toBeUndefined();
    expect(hermesSourceLabel("", t)).toBeUndefined();
  });
});

describe("hermesSessionOrigin", () => {
  const t = (source: string) => source;

  it("combines source and named profile for Hermes sessions", () => {
    expect(hermesSessionOrigin({ agentType: "hermes", nativeSource: "feishu", nativeProfile: "myvault" }, t))
      .toBe("飞书 · myvault");
  });

  it("labels the default profile explicitly", () => {
    expect(hermesSessionOrigin({ agentType: "hermes", nativeSource: "cli", nativeProfile: "default" }, t))
      .toBe("CLI · 默认 Profile");
  });

  it("is undefined for non-Hermes agents or when source/profile are absent", () => {
    expect(hermesSessionOrigin({ agentType: "opencode", nativeSource: "feishu", nativeProfile: "myvault" }, t))
      .toBeUndefined();
    expect(hermesSessionOrigin({ agentType: "hermes", nativeSource: null, nativeProfile: null }, t))
      .toBeUndefined();
  });
});
