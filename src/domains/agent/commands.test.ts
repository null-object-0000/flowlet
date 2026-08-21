import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  applyAgentGlobalConfig,
  authorizeCodexAccount,
  detectAgentEnvironment,
  inspectAgentGlobalConfig,
  listCachedCodexAccounts,
  listAgentCapabilities,
  queryCodexAccounts,
  restoreAgentGlobalConfig,
  startAgentRuntime,
  stopAgentRuntime,
} from "./commands";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("agent commands", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the compiled Agent capability list through the typed boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ agents: [] });

    await listAgentCapabilities();

    expect(invoke).toHaveBeenCalledWith("list_agent_capabilities", undefined);
  });

  it.each(["claude-code", "opencode", "pi", "codex"])("uses the typed environment boundary for %s", async (agentId) => {
    vi.mocked(invoke).mockResolvedValue({
      agent_id: agentId,
      agent_name: agentId,
      installed: false,
      primary: null,
      installations: [],
    });

    await detectAgentEnvironment(agentId);

    expect(invoke).toHaveBeenCalledWith("detect_agent_environment", { agentId });
  });

  it.each([
    [() => startAgentRuntime("deepseek-harness"), "start_agent_runtime"],
    [() => stopAgentRuntime("deepseek-harness"), "stop_agent_runtime"],
  ] as const)("uses the typed Agent runtime boundary", async (call, command) => {
    vi.mocked(invoke).mockResolvedValue({});
    await call();
    expect(invoke).toHaveBeenCalledWith(command, { agentId: "deepseek-harness" });
  });

  it("queries Codex account data through the typed Tauri boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ accounts: [] });

    await queryCodexAccounts();

    expect(invoke).toHaveBeenCalledWith("query_codex_accounts", undefined);
  });

  it("reads cached Codex account snapshots through the typed Tauri boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ accounts: [] });

    await listCachedCodexAccounts();

    expect(invoke).toHaveBeenCalledWith("list_cached_codex_accounts", undefined);
  });

  it("starts independent Codex account authorization through the typed Tauri boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ account_id: "account-2", signed_in: true });

    await authorizeCodexAccount();

    expect(invoke).toHaveBeenCalledWith("authorize_codex_account", undefined);
  });

  it.each([
    [() => inspectAgentGlobalConfig("claude-code"), "inspect_agent_global_config"],
    [() => applyAgentGlobalConfig("claude-code"), "apply_agent_global_config"],
    [() => restoreAgentGlobalConfig("claude-code"), "restore_agent_global_config"],
  ] as const)("uses the typed Agent global config boundary", async (call, command) => {
    vi.mocked(invoke).mockResolvedValue({});
    await call();
    expect(invoke).toHaveBeenCalledWith(command, { agentId: "claude-code" });
  });

  it("passes independent Claude Code context options through the typed boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({});

    await applyAgentGlobalConfig("claude-code", { primaryLongContext: true, fastLongContext: false });

    expect(invoke).toHaveBeenCalledWith("apply_agent_global_config", {
      agentId: "claude-code",
      options: { primaryLongContext: true, fastLongContext: false },
    });
  });

});
