import { describe, expect, it } from "vitest";
import { agentSessionLabel } from "./types";

describe("agentSessionLabel", () => {
  it("labels DeepSeek Harness without falling back to OpenCode", () => {
    expect(agentSessionLabel("deepseek-harness")).toBe("DeepSeek Harness");
  });

  it("keeps an unknown future agent id visible", () => {
    expect(agentSessionLabel("future-agent")).toBe("future-agent");
  });
});
