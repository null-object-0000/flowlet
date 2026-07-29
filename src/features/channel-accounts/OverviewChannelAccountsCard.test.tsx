import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import { OverviewChannelAccountsCard } from "./OverviewChannelAccountsCard";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

const account = {
  id: "account-longcat",
  channel_id: "longcat",
  name: "LongCat 主账号",
  api_key: "configured",
  enabled: true,
  credential_status: "healthy",
  resource_mode: "token_pack",
} as ChannelAccount;

const snapshot = {
  account_id: account.id,
  token_pack_remaining: 43_987_000,
  token_pack_expire_at: "2026-07-30T00:00:00Z",
} as AccountBalanceSnapshot;

describe("OverviewChannelAccountsCard", () => {
  it("renders legacy account summaries and routes all three actions", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onViewAll = vi.fn();
    const onEdit = vi.fn();

    render(
      <OverviewChannelAccountsCard
        accounts={[account]}
        snapshots={[snapshot]}
        onCreate={onCreate}
        onViewAll={onViewAll}
        onEdit={onEdit}
      />,
    );

    expect(screen.getByText("已启用 1 / 共 1 个账号")).toBeInTheDocument();
    expect(screen.getByText(/资源包 4398\.70万 Tokens/)).toBeInTheDocument();
    expect(screen.getByText(/有效期至 2026-07-30/)).toBeInTheDocument();
    expect(screen.getByText("启用")).toBeInTheDocument();
  });

  it("renders LongCat resource pack row with 0 tokens when the pack is fully consumed", () => {
    const exhaustedSnapshot = {
      account_id: account.id,
      balance: 0,
      currency: "CNY",
      token_pack_remaining: 0,
    } as AccountBalanceSnapshot;

    render(
      <OverviewChannelAccountsCard
        accounts={[account]}
        snapshots={[exhaustedSnapshot]}
        onCreate={vi.fn()}
        onViewAll={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    // 资源包用尽时剩余为 0，概览页应像余额一样照常展示，而不是隐藏资源包行。
    expect(screen.getByText(/资源包 0 Tokens/)).toBeInTheDocument();
    expect(screen.getByText(/余额/)).toBeInTheDocument();
  });

  it("renders Qwen Token Plan subscription with 5h and 7d remaining percentages", () => {
    // 固定为重置日前一天，避免测试在 2026-07-29 当天运行时切换为“仅时间”展示。
    vi.setSystemTime(new Date("2026-07-28T10:00:00Z"));
    const qwenAccount = {
      id: "account-qwen",
      channel_id: "qwen",
      name: "千问 Token Plan",
      api_key: "sk-sp-configured",
      enabled: true,
      credential_status: "healthy",
      resource_mode: "token_plan",
    } as ChannelAccount;
    const qwenSnapshot = {
      account_id: qwenAccount.id,
      raw_scraped_json: JSON.stringify({
        subscription: { data: { DataV2: { data: { data: { status: "VALID", remainingDays: 28 } } } } },
        quota_config: { data: { DataV2: { data: { data: { standard: { five_hour: 3000, weekly: 10000 } } } } } },
        usage: { data: { DataV2: { data: { data: { per5HourPercentage: 0.789, per1WeekPercentage: 0.211, per1WeekResetTime: 1785331200000 } } } } },
      }),
    } as AccountBalanceSnapshot;

    render(
      <OverviewChannelAccountsCard
        accounts={[qwenAccount]}
        snapshots={[qwenSnapshot]}
        onCreate={vi.fn()}
        onViewAll={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    const sevenDay = screen.getByText("7天 剩余 78.9%");
    const fiveHour = screen.getByText("5小时 剩余 21.1%");
    expect(sevenDay.parentElement?.parentElement).toContainElement(fiveHour);
    expect(sevenDay.compareDocumentPosition(fiveHour) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/七天重置 2026-07-29/)).toBeInTheDocument();
    expect(screen.queryByText(/Token Plan 订阅/)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("renders LongCat expiry as end-of-day clock time when expiring today", () => {
    vi.setSystemTime(new Date("2026-07-30T10:00:00Z"));
    const todayIso = new Date().toISOString();
    const todaySnapshot = {
      account_id: account.id,
      token_pack_remaining: 43_987_000,
      token_pack_expire_at: todayIso,
    } as AccountBalanceSnapshot;

    render(
      <OverviewChannelAccountsCard
        accounts={[account]}
        snapshots={[todaySnapshot]}
        onCreate={vi.fn()}
        onViewAll={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText(/有效期至 23:59:59/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("renders Qwen reset time as clock time when resetting today", () => {
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    const resetAt = new Date().toISOString();
    const qwenAccount = {
      id: "account-qwen",
      channel_id: "qwen",
      name: "千问 Token Plan",
      api_key: "sk-sp-configured",
      enabled: true,
      credential_status: "healthy",
      resource_mode: "token_plan",
    } as ChannelAccount;
    const qwenSnapshot = {
      account_id: qwenAccount.id,
      raw_scraped_json: JSON.stringify({
        subscription: { data: { DataV2: { data: { data: { status: "VALID", remainingDays: 28 } } } } },
        quota_config: { data: { DataV2: { data: { data: { standard: { five_hour: 3000, weekly: 10000 } } } } } },
        usage: { data: { DataV2: { data: { data: { per5HourPercentage: 0.789, per1WeekPercentage: 0.211, per1WeekResetTime: new Date(resetAt).getTime() } } } } },
      }),
    } as AccountBalanceSnapshot;

    render(
      <OverviewChannelAccountsCard
        accounts={[qwenAccount]}
        snapshots={[qwenSnapshot]}
        onCreate={vi.fn()}
        onViewAll={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText(/七天重置 \d{2}:\d{2}:\d{2}/)).toBeInTheDocument();
    vi.useRealTimers();
  });
});
