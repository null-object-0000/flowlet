import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((_command: string, _args?: Record<string, unknown>, _timeout?: number): Promise<unknown> => Promise.resolve(undefined));
vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string, args?: Record<string, unknown>, timeout?: number) => invokeMock(command, args, timeout),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { backgroundTaskCommands } from "./commands";

afterEach(() => invokeMock.mockReset());

describe("backgroundTaskCommands contract", () => {
  it("maps task pagination and filters to the Rust contract", async () => {
    await backgroundTaskCommands.list({ page: 2, pageSize: 20, status: "failed", jobType: "agent-data-sync" });
    expect(invokeMock).toHaveBeenCalledWith("list_background_jobs", { filter: { page: 2, page_size: 20, status: "failed", job_type: "agent-data-sync" } }, undefined);
  });
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

  it("opens one persisted task detail", async () => {
    await backgroundTaskCommands.detail("job-1");
    expect(invokeMock).toHaveBeenCalledWith("get_background_job_detail", { jobId: "job-1" }, undefined);
  });

  it("cancels and cleans persisted tasks", async () => {
    await backgroundTaskCommands.cancel("job-1");
    await backgroundTaskCommands.cleanup(90);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "cancel_background_job", { jobId: "job-1" }, undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "cleanup_background_jobs", { keepDays: 90 }, undefined);
  });
});
