import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { AgentBrandMark, agentBrandKey } from "./AgentBrandMark";

describe("agentBrandKey", () => {
  it("resolves every agent / client id used by usage attribution", () => {
    // 客户端维度用 client_id（Codex CLI 的归属 ID 是 `codex`），
    // Agent 原生账号维度用会话类型 ID（account_id，如 `codex-cli`）。
    expect(agentBrandKey("claude-code")).toBe("claude-code");
    expect(agentBrandKey("opencode")).toBe("opencode");
    expect(agentBrandKey("pi")).toBe("pi");
    expect(agentBrandKey("hermes")).toBe("hermes");
    expect(agentBrandKey("deepseek-harness")).toBe("deepseek");
    expect(agentBrandKey("codex")).toBe("openai");
    expect(agentBrandKey("codex-cli")).toBe("openai");
    expect(agentBrandKey("codex-desktop")).toBe("openai");
    expect(agentBrandKey("chatgpt-desktop")).toBe("openai");
  });

  it("returns null for unregistered ids so callers can fall back to a letter badge", () => {
    expect(agentBrandKey("some-unknown-agent")).toBeNull();
    expect(agentBrandKey("")).toBeNull();
  });
});

describe("AgentBrandMark", () => {
  it("renders the DeepSeek mark for DeepSeek Harness instead of the generic fallback", () => {
    const { container } = render(<AgentBrandMark agentId="deepseek-harness" />);
    const mark = container.firstElementChild as HTMLElement;
    expect(mark.className).toContain("deepseek");
    expect(mark.className).not.toContain("generic");
  });

  it("renders the Hermes mark for the Hermes Agent client", () => {
    const { container } = render(<AgentBrandMark agentId="hermes" />);
    const mark = container.firstElementChild as HTMLElement;
    expect(mark.className).toContain("hermes");
    expect(mark.className).not.toContain("generic");
  });

  it("renders the OpenAI mark for every Codex surface", () => {
    for (const agentId of ["codex", "codex-cli", "codex-desktop"]) {
      const { container, unmount } = render(<AgentBrandMark agentId={agentId} />);
      const mark = container.firstElementChild as HTMLElement;
      expect(mark.className).toContain("openai");
      expect(mark.className).not.toContain("generic");
      unmount();
    }
  });

  it("keeps the generic fallback for unregistered ids", () => {
    const { container } = render(<AgentBrandMark agentId="some-unknown-agent" />);
    expect((container.firstElementChild as HTMLElement).className).toContain("generic");
  });
});
