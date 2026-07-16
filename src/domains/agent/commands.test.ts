import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  applyClaudeCodeGlobalConfig,
  applyOpenCodeGlobalConfig,
  detectChatGptDesktopEnvironment,
  detectClaudeCodeEnvironment,
  detectOpenCodeEnvironment,
  inspectClaudeCodeGlobalConfig,
  inspectOpenCodeGlobalConfig,
  restoreClaudeCodeGlobalConfig,
  restoreOpenCodeGlobalConfig,
} from "./commands";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("agent commands", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [detectClaudeCodeEnvironment, "claude-code"],
    [detectOpenCodeEnvironment, "opencode"],
    [detectChatGptDesktopEnvironment, "chatgpt-desktop"],
  ] as const)("uses the typed environment boundary for %s", async (call, agentId) => {
    vi.mocked(invoke).mockResolvedValue({
      agent_id: agentId,
      agent_name: agentId,
      installed: false,
      primary: null,
      installations: [],
    });

    await call();

    expect(invoke).toHaveBeenCalledWith("detect_agent_environment", { agentId });
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
