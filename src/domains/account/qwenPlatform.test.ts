import { afterEach, describe, expect, it, vi } from "vitest";

// 契约测试：确认命令封装只把冻结的 command 名与 { accountId } 传给
// invokeCommand，不在页面或其它模块里重复拼写 Tauri command。

const invokeMock = vi.fn(
  (cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> =>
    Promise.resolve(undefined),
);

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> =>
    timeoutMs === undefined ? invokeMock(cmd, args) : invokeMock(cmd, args, timeoutMs),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { qwenPlatformCommands } from "./qwenPlatform";

afterEach(() => invokeMock.mockReset());

describe("qwenPlatformCommands contract", () => {
  it("status -> qwen_platform_status with { accountId }", async () => {
    const status = {
      accountId: "a1",
      loggedIn: true,
      aliyunId: "aliyun-1",
      email: "user@example.com",
      expiresAt: "2026-12-01T00:00:00Z",
    };
    invokeMock.mockResolvedValueOnce(status);

    const result = await qwenPlatformCommands.status("a1");

    expect(invokeMock).toHaveBeenCalledWith("qwen_platform_status", { accountId: "a1" });
    expect(result).toEqual(status);
  });

  it("loginStart -> qwen_platform_login_start with a wider timeout", async () => {
    const started = {
      verificationUrl: "https://account.aliyun.com/device",
      expiresInSeconds: 300,
      intervalSeconds: 5,
    };
    invokeMock.mockResolvedValueOnce(started);

    const result = await qwenPlatformCommands.loginStart("a1");

    expect(invokeMock).toHaveBeenCalledWith(
      "qwen_platform_login_start",
      { accountId: "a1" },
      30_000,
    );
    expect(result).toEqual(started);
  });

  it("loginPoll -> qwen_platform_login_poll with { accountId }", async () => {
    const poll = { status: "pending" };
    invokeMock.mockResolvedValueOnce(poll);

    await expect(qwenPlatformCommands.loginPoll("a1")).resolves.toEqual(poll);
    expect(invokeMock).toHaveBeenCalledWith("qwen_platform_login_poll", { accountId: "a1" });
  });

  it("logout -> qwen_platform_logout with { accountId }", async () => {
    invokeMock.mockResolvedValueOnce(null);

    await qwenPlatformCommands.logout("a1");
    expect(invokeMock).toHaveBeenCalledWith("qwen_platform_logout", { accountId: "a1" });
  });

  it("sync -> qwen_platform_sync with a network timeout and camelCase result", async () => {
    const synced = {
      accountId: "a1",
      balance: 12.5,
      currency: "CNY",
      syncedAt: "2026-11-10T05:00:00Z",
      rawScrapedJson: "{}",
    };
    invokeMock.mockResolvedValueOnce(synced);

    const result = await qwenPlatformCommands.sync("a1");

    expect(invokeMock).toHaveBeenCalledWith(
      "qwen_platform_sync",
      { accountId: "a1" },
      60_000,
    );
    expect(result).toEqual(synced);
    expect(result.syncedAt).toBe("2026-11-10T05:00:00Z");
    expect(result.rawScrapedJson).toBe("{}");
  });

  it("wraps failures into a typed AppError code", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));

    await expect(qwenPlatformCommands.status("a1")).rejects.toMatchObject({
      code: "qwen_platform_status_failed",
      message: "Error: boom",
    });
  });
});