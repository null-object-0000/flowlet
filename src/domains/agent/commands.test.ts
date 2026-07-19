import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  applyClaudeCodeGlobalConfig,
  applyOpenCodeGlobalConfig,
  authorizeCodexAccount,
  detectChatGptDesktopEnvironment,
  detectClaudeCodeEnvironment,
  detectOpenCodeEnvironment,
  inspectClaudeCodeGlobalConfig,
  inspectOpenCodeGlobalConfig,
  listCachedCodexAccounts,
  queryCodexAccounts,
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

  it("queries Codex account data through the typed Tauri boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ accounts: [], current_account_id: null });

    await queryCodexAccounts();

    expect(invoke).toHaveBeenCalledWith("query_codex_accounts", undefined);
  });

  it("reads cached Codex account snapshots through the typed Tauri boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ accounts: [], current_account_id: null });

    await listCachedCodexAccounts();

    expect(invoke).toHaveBeenCalledWith("list_cached_codex_accounts", undefined);
  });

  it("starts independent Codex account authorization through the typed Tauri boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ account_id: "account-2", signed_in: true });

    await authorizeCodexAccount();

    expect(invoke).toHaveBeenCalledWith("authorize_codex_account", undefined);
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
