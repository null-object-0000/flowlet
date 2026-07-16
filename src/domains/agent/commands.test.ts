import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  applyClaudeCodeGlobalConfig,
  applyOpenCodeGlobalConfig,
  detectClaudeCodeEnvironment,
  inspectClaudeCodeGlobalConfig,
  inspectOpenCodeGlobalConfig,
  restoreClaudeCodeGlobalConfig,
  restoreOpenCodeGlobalConfig,
} from "./commands";

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

  it.each([
    [inspectClaudeCodeGlobalConfig, "inspect_agent_global_config"],
    [applyClaudeCodeGlobalConfig, "apply_agent_global_config"],
    [restoreClaudeCodeGlobalConfig, "restore_agent_global_config"],
  ] as const)("uses the typed Claude Code global config boundary", async (call, command) => {
    vi.mocked(invoke).mockResolvedValue({});

    await call();

    expect(invoke).toHaveBeenCalledWith(command, { agentId: "claude-code" });
  });

  it.each([
    [inspectOpenCodeGlobalConfig, "inspect_agent_global_config"],
    [applyOpenCodeGlobalConfig, "apply_agent_global_config"],
    [restoreOpenCodeGlobalConfig, "restore_agent_global_config"],
  ] as const)("uses the typed OpenCode global config boundary", async (call, command) => {
    vi.mocked(invoke).mockResolvedValue({});

    await call();

    expect(invoke).toHaveBeenCalledWith(command, { agentId: "opencode" });
  });
});
