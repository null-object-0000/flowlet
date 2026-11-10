import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const commandMocks = vi.hoisted(() => ({
  status: vi.fn(),
  loginStart: vi.fn(),
  loginPoll: vi.fn(),
  logout: vi.fn(),
  sync: vi.fn(),
}));

vi.mock("../../domains/account/qwenPlatform", () => ({
  qwenPlatformCommands: commandMocks,
}));

const openExternalMock = vi.hoisted(() => vi.fn());
vi.mock("../../platform/openExternal", () => ({
  openExternalUrl: openExternalMock,
}));

const preferencesMock = vi.hoisted(() => ({
  // 真实的 useAppPreferences 会 memo 化 t；测试里也必须保持同一引用，否则
  // 状态读取 effect 会因 t 变化反复重置。
  t: (source: string, variables?: Record<string, string | number>) =>
    variables
      ? source.replace(/\{(\w+)\}/g, (match, key: string) => String(variables[key] ?? match))
      : source,
}));

vi.mock("../../app/preferences/AppPreferences", () => ({
  useAppPreferences: () => preferencesMock,
}));

import { useQwenPlatformLogin } from "./useQwenPlatformLogin";

const LOGGED_OUT = {
  accountId: "acc-1",
  loggedIn: false,
  aliyunId: null,
  email: null,
  expiresAt: null,
};

const LOGGED_IN = {
  accountId: "acc-1",
  loggedIn: true,
  aliyunId: "aliyun-user",
  email: "user@example.com",
  expiresAt: "2026-12-01T00:00:00Z",
};

const SYNCED = {
  accountId: "acc-1",
  balance: 12.34,
  currency: "CNY",
  syncedAt: "2026-11-10T05:00:00Z",
  rawScrapedJson: "{\"fq_instance\":{}}",
};

const LOGIN_START = {
  verificationUrl: "https://account.aliyun.com/device",
  expiresInSeconds: 300,
  intervalSeconds: 2,
};

/** 让 effect / promise 链跑完一轮。 */
function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function advance(ms: number): Promise<void> {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  commandMocks.status.mockResolvedValue(LOGGED_OUT);
  commandMocks.loginStart.mockResolvedValue(LOGIN_START);
  commandMocks.loginPoll.mockResolvedValue({ status: "pending" });
  commandMocks.logout.mockResolvedValue(null);
  commandMocks.sync.mockResolvedValue(SYNCED);
  openExternalMock.mockResolvedValue("opened");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useQwenPlatformLogin", () => {
  it("loads the platform status on mount", async () => {
    const { result } = renderHook(() => useQwenPlatformLogin({ accountId: "acc-1" }));
    await flush();

    expect(commandMocks.status).toHaveBeenCalledWith("acc-1");
    expect(result.current.status).toEqual(LOGGED_OUT);
    expect(result.current.statusLoading).toBe(false);
    expect(result.current.isLoggedIn).toBe(false);
  });

  it("does not read status for an unsaved account", async () => {
    const { result } = renderHook(() =>
      useQwenPlatformLogin({ accountId: "draft-1", enabled: false }),
    );
    await flush();

    expect(commandMocks.status).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
    expect(result.current.phase).toBe("idle");
  });

  it("starts login, opens the browser, polls, then syncs once on completion", async () => {
    const onSynced = vi.fn();
    commandMocks.status
      .mockResolvedValueOnce(LOGGED_OUT)
      .mockResolvedValue(LOGGED_IN);
    commandMocks.loginPoll
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "complete" });

    const { result } = renderHook(() =>
      useQwenPlatformLogin({ accountId: "acc-1", onSynced }),
    );
    await flush();

    await act(async () => {
      await result.current.startLogin();
    });

    expect(commandMocks.loginStart).toHaveBeenCalledWith("acc-1");
    expect(openExternalMock).toHaveBeenCalledWith(LOGIN_START.verificationUrl);
    expect(result.current.phase).toBe("waiting");
    expect(result.current.waitingForBrowser).toBe(true);
    expect(commandMocks.loginPoll).not.toHaveBeenCalled();

    await advance(2000);
    expect(commandMocks.loginPoll).toHaveBeenCalledTimes(1);

    await advance(2000);
    expect(commandMocks.loginPoll).toHaveBeenCalledTimes(2);
    expect(commandMocks.sync).toHaveBeenCalledWith("acc-1");
    expect(onSynced).toHaveBeenCalledWith(SYNCED);
    expect(result.current.phase).toBe("success");
    expect(result.current.lastSync).toEqual(SYNCED);
    expect(result.current.status?.loggedIn).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("honours slow_down by increasing the poll interval", async () => {
    commandMocks.loginPoll
      .mockResolvedValueOnce({ status: "slow_down" })
      .mockResolvedValueOnce({ status: "pending" });

    const { result } = renderHook(() => useQwenPlatformLogin({ accountId: "acc-1" }));
    await flush();
    await act(async () => {
      await result.current.startLogin();
    });

    await advance(2000);
    expect(commandMocks.loginPoll).toHaveBeenCalledTimes(1);

    // slow_down 后间隔变为 7 秒，2 秒内不得再次轮询。
    await advance(2000);
    expect(commandMocks.loginPoll).toHaveBeenCalledTimes(1);

    await advance(5000);
    expect(commandMocks.loginPoll).toHaveBeenCalledTimes(2);
  });

  it("surfaces an expired login and stops polling", async () => {
    commandMocks.loginPoll.mockResolvedValue({ status: "expired" });

    const { result } = renderHook(() => useQwenPlatformLogin({ accountId: "acc-1" }));
    await flush();
    await act(async () => {
      await result.current.startLogin();
    });

    await advance(2000);

    expect(result.current.phase).toBe("error");
    expect(result.current.errorScope).toBe("login");
    expect(result.current.error).toBe("登录已过期请重新登录");
    expect(result.current.loginStart).toBeNull();

    await advance(20_000);
    expect(commandMocks.loginPoll).toHaveBeenCalledTimes(1);
  });

  it("surfaces a denied authorization as a readable error", async () => {
    commandMocks.loginPoll.mockResolvedValue({ status: "denied" });

    const { result } = renderHook(() => useQwenPlatformLogin({ accountId: "acc-1" }));
    await flush();
    await act(async () => {
      await result.current.startLogin();
    });
    await advance(2000);

    expect(result.current.phase).toBe("error");
    expect(result.current.error).toBe("登录授权被拒绝，请重新登录");
  });

  it("cancels polling and clears the waiting state", async () => {
    const { result } = renderHook(() => useQwenPlatformLogin({ accountId: "acc-1" }));
    await flush();
    await act(async () => {
      await result.current.startLogin();
    });

    act(() => {
      result.current.cancelLogin();
    });
    await advance(10_000);

    expect(commandMocks.loginPoll).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
    expect(result.current.loginStart).toBeNull();
  });

  it("stops polling when unmounted (StrictMode-safe cleanup)", async () => {
    const { result, unmount } = renderHook(() => useQwenPlatformLogin({ accountId: "acc-1" }));
    await flush();
    await act(async () => {
      await result.current.startLogin();
    });

    unmount();
    await advance(10_000);

    expect(commandMocks.loginPoll).not.toHaveBeenCalled();
  });

  it("drops in-flight polling when accountId changes", async () => {
    const { result, rerender } = renderHook(
      (props: { accountId: string }) => useQwenPlatformLogin(props),
      { initialProps: { accountId: "acc-1" } },
    );
    await flush();
    await act(async () => {
      await result.current.startLogin();
    });

    rerender({ accountId: "acc-2" });
    await flush();
    await advance(10_000);

    expect(commandMocks.loginPoll).not.toHaveBeenCalled();
    expect(commandMocks.status).toHaveBeenLastCalledWith("acc-2");
    expect(result.current.phase).toBe("idle");
  });

  it("syncs on demand and reports sync failures with a sync scope", async () => {
    const onSynced = vi.fn();
    commandMocks.status.mockResolvedValue(LOGGED_IN);

    const { result } = renderHook(() =>
      useQwenPlatformLogin({ accountId: "acc-1", onSynced }),
    );
    await flush();

    await act(async () => {
      await result.current.syncNow();
    });
    expect(commandMocks.sync).toHaveBeenCalledWith("acc-1");
    expect(onSynced).toHaveBeenCalledWith(SYNCED);
    expect(result.current.lastSync).toEqual(SYNCED);
    expect(result.current.phase).toBe("success");

    commandMocks.sync.mockRejectedValueOnce(new Error("network down"));
    await act(async () => {
      await result.current.syncNow();
    });

    expect(result.current.phase).toBe("error");
    expect(result.current.errorScope).toBe("sync");
    expect(result.current.error).toContain("network down");
  });

  it("logs out and clears the platform status", async () => {
    commandMocks.status.mockResolvedValue(LOGGED_IN);
    const { result } = renderHook(() => useQwenPlatformLogin({ accountId: "acc-1" }));
    await flush();
    expect(result.current.isLoggedIn).toBe(true);

    await act(async () => {
      await result.current.logout();
    });

    expect(commandMocks.logout).toHaveBeenCalledWith("acc-1");
    expect(result.current.status).toEqual({
      accountId: "acc-1",
      loggedIn: false,
      aliyunId: null,
      email: null,
      expiresAt: null,
    });
    expect(result.current.isLoggedIn).toBe(false);
  });
});