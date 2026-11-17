import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeCommand as invoke } from "../../platform/host/client";
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

vi.mock("../../platform/host/client", async (original) => ({
  ...await original<typeof import("../../platform/host/client")>(),
  invokeCommand: vi.fn(),
}));

describe("agent commands", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the compiled Agent capability list through the typed boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ agents: [] });

    await listAgentCapabilities();

    expect(invoke).toHaveBeenCalledWith("list_agent_capabilities");
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

    expect(invoke).toHaveBeenCalledWith("detect_agent_environment", { agentId }, 10_000);
  });

  it.each([
    [() => startAgentRuntime("deepseek-harness"), "start_agent_runtime"],
    [() => stopAgentRuntime("deepseek-harness"), "stop_agent_runtime"],
  ] as const)("uses the typed Agent runtime boundary", async (call, command) => {
    vi.mocked(invoke).mockResolvedValue({});
    await call();
    expect(invoke).toHaveBeenCalledWith(command, { agentId: "deepseek-harness" }, command === "start_agent_runtime" ? 30_000 : 15_000);
  });

  it("queries Codex account data through the typed Host boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ accounts: [] });

    await queryCodexAccounts();

    expect(invoke).toHaveBeenCalledWith("query_codex_accounts", undefined, 60_000);
  });

  it("reads cached Codex account snapshots through the typed Host boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ accounts: [] });

    await listCachedCodexAccounts();

    expect(invoke).toHaveBeenCalledWith("list_cached_codex_accounts");
  });

  it("starts independent Codex account authorization through the typed Host boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ account_id: "account-2", signed_in: true });

    await authorizeCodexAccount();

    expect(invoke).toHaveBeenCalledWith("authorize_codex_account", undefined, 360_000);
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

  it("passes explicit model choices through the typed boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({});

    await applyAgentGlobalConfig("claude-code", { primaryModel: "deepseek-v4-pro", fastModel: "deepseek-v4-flash" });

    expect(invoke).toHaveBeenCalledWith("apply_agent_global_config", {
      agentId: "claude-code",
      options: { primaryModel: "deepseek-v4-pro", fastModel: "deepseek-v4-flash" },
    });
  });

});
