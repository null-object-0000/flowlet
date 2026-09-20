import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commandMocks = vi.hoisted(() => ({
  openScrapeConsole: vi.fn(),
  closeScrapeConsole: vi.fn(),
  probeScrapeLogin: vi.fn(),
  scrapeBalance: vi.fn(),
}));

vi.mock("../../domains/account/commands", () => ({
  accountCommands: commandMocks,
}));

vi.mock("../../app/preferences/AppPreferences", () => ({
  useAppPreferences: () => ({ t: (source: string) => source }),
}));

import { useScrapeConsole } from "./useScrapeConsole";

describe("useScrapeConsole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commandMocks.openScrapeConsole.mockResolvedValue(undefined);
    commandMocks.closeScrapeConsole.mockResolvedValue(undefined);
  });

  it("opens an actionable console state without treating capture timeout as logged out", async () => {
    commandMocks.probeScrapeLogin.mockResolvedValue({
      is_logged_in: false,
      channel_id: "qwen",
      account_hint: null,
      probe_state: "console_action_required",
      message: "未捕获到套餐接口响应，已打开控制台窗口。请重新抓取。",
    });
    const { result } = renderHook(() => useScrapeConsole());

    await act(async () => {
      await result.current.startScrape("account-qwen");
    });

    expect(result.current.needLogin).toBe(false);
    expect(result.current.state).toBe("need-console-action");
    expect(result.current.error).toBeNull();
    expect(result.current.consoleActionMessage).toBe("未捕获到套餐接口响应，已打开控制台窗口。请重新抓取。");
    expect(commandMocks.openScrapeConsole).not.toHaveBeenCalled();
    expect(commandMocks.scrapeBalance).not.toHaveBeenCalled();
    expect(commandMocks.closeScrapeConsole).not.toHaveBeenCalled();
  });

  it("keeps listener initialization failure as an error", async () => {
    commandMocks.probeScrapeLogin.mockResolvedValue({
      is_logged_in: false,
      channel_id: "qwen",
      account_hint: null,
      probe_state: "capture_timeout",
      message: "控制台页面监听初始化失败，请重新抓取。",
    });
    const { result } = renderHook(() => useScrapeConsole());

    await act(async () => {
      await result.current.startScrape("account-qwen");
    });

    expect(result.current.state).toBe("error");
    expect(result.current.error).toBe("控制台页面监听初始化失败，请重新抓取。");
    expect(result.current.consoleActionMessage).toBeNull();
    expect(commandMocks.closeScrapeConsole).toHaveBeenCalledWith("account-qwen");
  });

  it("requests login only for an explicit login page", async () => {
    commandMocks.probeScrapeLogin.mockResolvedValue({
      is_logged_in: false,
      channel_id: "qwen",
      account_hint: null,
      probe_state: "login_required",
      message: "检测到控制台登录页。",
    });
    const { result } = renderHook(() => useScrapeConsole());

    await act(async () => {
      await result.current.startScrape("account-qwen");
    });

    expect(result.current.needLogin).toBe(true);
    expect(result.current.state).toBe("need-login");
    expect(result.current.error).toBeNull();
    expect(commandMocks.scrapeBalance).not.toHaveBeenCalled();
    expect(commandMocks.closeScrapeConsole).not.toHaveBeenCalled();
  });

  it("releases the kept console window when the drawer unmounts", async () => {
    commandMocks.probeScrapeLogin.mockResolvedValue({
      is_logged_in: false,
      channel_id: "qwen",
      account_hint: null,
      probe_state: "login_required",
      message: "检测到控制台登录页。",
    });
    const { result, unmount } = renderHook(() => useScrapeConsole());

    await act(async () => {
      await result.current.startScrape("account-qwen");
    });
    // 登录窗口是故意保留的，此时不能关。
    expect(commandMocks.closeScrapeConsole).not.toHaveBeenCalled();

    // 用户放弃登录并关闭抽屉：必须释放窗口，否则 Rust 侧会把这个账号永久标记为
    // “等待人工处理”，后台同步从此每轮跳过它。
    unmount();
    await act(async () => {});
    expect(commandMocks.closeScrapeConsole).toHaveBeenCalledWith("account-qwen");
  });

  it("does not close anything on mount/unmount without a scrape", async () => {
    // StrictMode 的“挂载 → 卸载 → 再挂载”不得误关窗口。
    const { unmount } = renderHook(() => useScrapeConsole());
    unmount();
    await act(async () => {});
    expect(commandMocks.closeScrapeConsole).not.toHaveBeenCalled();
  });

  it("releases the kept console window when the user dismisses it", async () => {
    commandMocks.probeScrapeLogin.mockResolvedValue({
      is_logged_in: false,
      channel_id: "qwen",
      account_hint: null,
      probe_state: "console_action_required",
      message: "请在已打开的控制台中检查页面后重新抓取。",
    });
    const { result } = renderHook(() => useScrapeConsole());

    await act(async () => {
      await result.current.startScrape("account-qwen");
    });
    expect(commandMocks.closeScrapeConsole).not.toHaveBeenCalled();

    await act(async () => {
      result.current.dismiss();
    });
    expect(commandMocks.closeScrapeConsole).toHaveBeenCalledWith("account-qwen");
    expect(result.current.state).toBe("idle");
  });
});
