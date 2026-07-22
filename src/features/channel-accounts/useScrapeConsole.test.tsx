import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commandMocks = vi.hoisted(() => ({
  openScrapeConsole: vi.fn(),
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
    expect(commandMocks.scrapeBalance).not.toHaveBeenCalled();
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
  });
});
