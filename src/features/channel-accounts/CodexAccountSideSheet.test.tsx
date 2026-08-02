import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CodexAccountsReport } from "../../domains/agent/types";
import { CodexAccountSideSheet } from "./CodexAccountSideSheet";
import { CODEX_ACCOUNT_SYNC_INTERVAL_MS } from "../background-tasks/CodexAccountAutoSync";

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

describe("CodexAccountSideSheet cached account state", () => {
  it("keeps cached usage visible while a live refresh is running", () => {
    render(
      <CodexAccountSideSheet
        visible
        accounts={cachedAccounts}
        accountLoading
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
      <CodexAccountSideSheet
        visible
        accounts={cachedAccounts}
        accountError="network timeout"
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

describe("CodexAccountSideSheet last-updated tooltip", () => {
  const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  it("shows the estimated next refresh time when hovering the last-updated time", async () => {
    const updatedAt = new Date(Date.now() - 60_000);
    render(
      <CodexAccountSideSheet
        visible
        accounts={{ accounts: [{ ...cachedAccounts.accounts[0], updated_at: updatedAt.toISOString() }] }}
        onRefreshAccount={noop}
        onAuthorizeAccount={noop}
        onClose={noop}
        onCopy={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const user = userEvent.setup();
    await user.hover(screen.getByText(timeFormatter.format(updatedAt)));

    const expectedNext = timeFormatter.format(new Date(updatedAt.getTime() + CODEX_ACCOUNT_SYNC_INTERVAL_MS));
    expect(await screen.findByText(`预计下次刷新：${expectedNext}`)).toBeInTheDocument();
  });

  it("shows a refresh-soon hint when the estimated next refresh has already passed", async () => {
    render(
      <CodexAccountSideSheet
        visible
        accounts={cachedAccounts}
        onRefreshAccount={noop}
        onAuthorizeAccount={noop}
        onClose={noop}
        onCopy={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const user = userEvent.setup();
    await user.hover(screen.getByText(timeFormatter.format(new Date("2026-07-18T10:00:00Z"))));

    expect(await screen.findByText("数据即将自动刷新")).toBeInTheDocument();
  });
});
