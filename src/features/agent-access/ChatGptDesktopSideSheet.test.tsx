import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CodexAccountsReport } from "../../domains/agent/types";
import { ChatGptDesktopSideSheet } from "./ChatGptDesktopSideSheet";

const cachedAccounts: CodexAccountsReport = {
  accounts: [{
    account_id: "user-1",
    signed_in: true,
    auth_mode: "chatgpt",
    email: "cached@example.com",
    plan_type: "plus",
    primary: { used_percent: 38, window_duration_mins: 10_080, resets_at: 1_789_200_000 },
    secondary: null,
    credits: null,
    rate_limit_reset_credits: null,
    rate_limit_reached_type: null,
    source: "oauth",
    updated_at: "2026-07-18T10:00:00Z",
    stale: false,
    error: null,
  }],
};

const noop = vi.fn();

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

describe("ChatGptDesktopSideSheet cached account state", () => {
  it("keeps cached usage visible while a live refresh is running", () => {
    render(
      <ChatGptDesktopSideSheet
        visible
        accounts={cachedAccounts}
        accountLoading
        onRefresh={noop}
        onRefreshAccount={noop}
        onAuthorizeAccount={noop}
        onClose={noop}
        onCopy={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText("cached@example.com")).toBeInTheDocument();
    expect(screen.getByText("正在刷新，当前展示上次更新的数据")).toBeInTheDocument();
    expect(screen.getByText("剩余 62%")).toBeInTheDocument();
  });

  it("keeps cached usage visible when the live refresh fails", () => {
    render(
      <ChatGptDesktopSideSheet
        visible
        accounts={cachedAccounts}
        accountError="network timeout"
        onRefresh={noop}
        onRefreshAccount={noop}
        onAuthorizeAccount={noop}
        onClose={noop}
        onCopy={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText("cached@example.com")).toBeInTheDocument();
    expect(screen.getByText("刷新失败，当前展示上次更新的数据：network timeout")).toBeInTheDocument();
    expect(screen.queryByText("账号信息查询失败：network timeout")).not.toBeInTheDocument();
  });
});
