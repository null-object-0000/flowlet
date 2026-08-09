import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CodexAccountReport, CodexAccountsReport } from "../../domains/agent/types";
import { CodexAccountSideSheet } from "./CodexAccountSideSheet";

const account: CodexAccountReport = {
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
};

const accounts: CodexAccountsReport = {
  accounts: [
    account,
    { ...account, account_id: "user-2", email: "other@example.com" },
  ],
};

const noop = vi.fn();

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

function renderSheet(overrides: Partial<React.ComponentProps<typeof CodexAccountSideSheet>> = {}) {
  return render(
    <CodexAccountSideSheet
      visible
      accounts={accounts}
      accountId="user-1"
      onRefreshAccount={noop}
      onAuthorizeAccount={noop}
      onClose={noop}
      {...overrides}
    />,
  );
}

describe("CodexAccountSideSheet single-account details", () => {
  it("only renders the selected account and no longer exposes the old account list", () => {
    renderSheet();

    expect(screen.getAllByText("cached@example.com").length).toBeGreaterThan(0);
    expect(screen.queryByText("other@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "全部账号" })).not.toBeInTheDocument();
    expect(screen.getByText("Codex 账号详情")).toBeInTheDocument();
  });

  it("provides one refresh action and a reauthorization action", async () => {
    const user = userEvent.setup();
    const onRefreshAccount = vi.fn();
    const onAuthorizeAccount = vi.fn();
    renderSheet({ onRefreshAccount, onAuthorizeAccount });

    const refreshButtons = screen.getAllByRole("button", { name: /刷新用量/ });
    expect(refreshButtons).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /立即刷新/ })).not.toBeInTheDocument();

    await user.click(refreshButtons[0]);
    await user.click(screen.getByRole("button", { name: "重新授权" }));
    expect(onRefreshAccount).toHaveBeenCalledTimes(1);
    expect(onAuthorizeAccount).toHaveBeenCalledTimes(1);
  });

  it("keeps cached data visible while the selected account refreshes", () => {
    renderSheet({ accountLoading: true });

    expect(screen.getAllByText("cached@example.com").length).toBeGreaterThan(0);
    expect(screen.getByText("正在刷新，当前展示上次更新的数据")).toBeInTheDocument();
    expect(screen.getByText("7 天 62%")).toBeInTheDocument();
  });

  it("shows an expired authorization status and the persisted OAuth error", () => {
    const expired: CodexAccountsReport = {
      accounts: [{
        ...account,
        stale: true,
        error: "OAuth 会话：官方用量接口返回 HTTP 401 Unauthorized",
      }],
    };
    renderSheet({ accounts: expired });

    expect(screen.getByRole("alert")).toHaveTextContent("账号授权已过期");
    expect(screen.getByRole("alert")).toHaveTextContent("需要重新授权");
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP 401 Unauthorized");
    expect(screen.getByText("授权状态")).toBeInTheDocument();
    expect(screen.getByText("已过期")).toBeInTheDocument();
  });

  it("distinguishes non-authentication sync failures from expired authorization", () => {
    const failed: CodexAccountsReport = {
      accounts: [{ ...account, stale: true, error: "network timeout" }],
    };
    renderSheet({ accounts: failed });

    expect(screen.queryByText("账号授权已过期")).not.toBeInTheDocument();
    expect(screen.getByText("用量同步失败")).toBeInTheDocument();
    expect(screen.getByText("network timeout")).toBeInTheDocument();
  });
});
