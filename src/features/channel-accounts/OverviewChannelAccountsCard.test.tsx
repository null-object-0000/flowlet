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
    expect(screen.getByText(/资源包 4398\.7万 Tokens.*有效期至 2026-07-30/)).toBeInTheDocument();
    expect(screen.getByText("启用")).toBeInTheDocument();
  });

  it("renders Qwen Token Plan subscription with 5h and 7d remaining percentages", async () => {
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
        usage: { data: { DataV2: { data: { data: { per5HourPercentage: 0.789, per1WeekPercentage: 0.211 } } } } },
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

    expect(screen.getByText(/Token Plan 订阅.*5小时 剩余 21\.1%.*7天 剩余 78\.9%/)).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /新增账号/ }));
    await user.click(screen.getByRole("link", { name: /管理账号/ }));
    await user.click(screen.getByRole("button", { name: "编辑账号 LongCat 主账号" }));

    expect(onCreate).toHaveBeenCalledOnce();
    expect(onViewAll).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledWith(account.id);
  });
});
