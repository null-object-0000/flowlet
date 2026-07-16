import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { detectClaudeCodeEnvironment } from "./commands";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("agent commands", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the typed agent environment command boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({
      agent_id: "claude-code",
      agent_name: "Claude Code CLI",
      installed: false,
      primary: null,
      installations: [],
    });

    await detectClaudeCodeEnvironment();

    expect(invoke).toHaveBeenCalledWith("detect_agent_environment", { agentId: "claude-code" });
  });
});
