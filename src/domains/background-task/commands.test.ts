import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((_command: string, _args?: Record<string, unknown>, _timeout?: number): Promise<unknown> => Promise.resolve(undefined));
vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string, args?: Record<string, unknown>, timeout?: number) => invokeMock(command, args, timeout),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { backgroundTaskCommands } from "./commands";

afterEach(() => invokeMock.mockReset());

describe("backgroundTaskCommands contract", () => {
  it("starts a forced manual Agent sync with the long-running timeout", async () => {
    await backgroundTaskCommands.syncAgentData(true, "manual");
    expect(invokeMock).toHaveBeenCalledWith("sync_agent_data", { force: true, triggerSource: "manual" }, 120_000);
  });

  it("starts a scheduled Codex account sync with the long-running timeout", async () => {
    await backgroundTaskCommands.syncCodexAccounts("background");
    expect(invokeMock).toHaveBeenCalledWith("sync_codex_accounts", { triggerSource: "background" }, 120_000);
  });

  it("reads persisted per-source sync status", async () => {
    await backgroundTaskCommands.agentSyncStatus();
    expect(invokeMock).toHaveBeenCalledWith("get_agent_sync_status", undefined, undefined);
  });

  it("reads both local model catalog documents through separate commands", async () => {
    await backgroundTaskCommands.getModelsCnCatalog();
    await backgroundTaskCommands.getModelsDevProviderCatalog("openrouter");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_models_cn_catalog", undefined, undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_models_dev_provider_catalog", { providerId: "openrouter" }, undefined);
  });
});
