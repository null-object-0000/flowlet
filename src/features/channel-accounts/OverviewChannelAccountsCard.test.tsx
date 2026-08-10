import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import type { CodexAccountReport } from "../../domains/agent/types";
import type { ChannelPreset } from "../../domains/channel/types";
import { formatFullTimestamp, formatTime } from "../../shared/formatters/datetime";
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

const channels = [
  { id: "longcat", name: "LongCat", supports_balance_query: false, supports_scrape_balance: true },
  { id: "deepseek", name: "DeepSeek", supports_balance_query: true, supports_scrape_balance: false },
  { id: "kimi", name: "Kimi", supports_balance_query: true, supports_scrape_balance: false },
  { id: "qwen", name: "Qwen", supports_balance_query: false, supports_scrape_balance: true },
] as ChannelPreset[];

describe("OverviewChannelAccountsCard", () => {
  it("renders provider choices inside the empty card", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();

    render(
      <OverviewChannelAccountsCard
        accounts={[]}
        channels={channels}
        snapshots={[]}
        onCreate={onCreate}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText("选择一个渠道添加首个账号")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加 LongCat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加 DeepSeek" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加 Kimi" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加 Qwen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加 Z.AI" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加 OpenRouter" })).toBeInTheDocument();
    expect(screen.queryByText("管理账号")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "添加 Qwen" }));
    expect(onCreate).toHaveBeenCalledWith("qwen");
  });

  it("offers ChatGPT authorization in the empty card", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();

    render(
      <OverviewChannelAccountsCard
        accounts={[]}
        channels={channels}
        snapshots={[]}
        onCreate={onCreate}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "ChatGPT 授权登录" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ChatGPT 授权登录" }));
    expect(onCreate).toHaveBeenCalledWith("chatgpt");
  });

  it("opens the Codex detail drawer scoped to the clicked pseudo account", async () => {
    const user = userEvent.setup();
    const onOpenCodexAgent = vi.fn();
    const codexAccounts: CodexAccountReport[] = [{
      account_id: "acc-1",
      signed_in: true,
      auth_mode: "chatgpt",
      email: "one@example.com",
      plan_type: "plus",
      primary: { used_percent: 25, window_duration_mins: 300, resets_at: 1_779_459_394 },
      secondary: { used_percent: 22, window_duration_mins: 10_080, resets_at: 1_779_632_194 },
      credits: null,
      rate_limit_reset_credits: null,
      rate_limit_reached_type: null,
      source: "oauth",
      updated_at: "2026-07-18T10:00:00Z",
      stale: false,
      error: null,
    }];

    render(
      <OverviewChannelAccountsCard
        accounts={[]}
        channels={channels}
        snapshots={[]}
        codexAccounts={codexAccounts}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onOpenCodexAgent={onOpenCodexAgent}
      />,
    );

    expect(screen.getByText("one@example.com")).toBeInTheDocument();
    expect(screen.getByText("Plus")).toBeInTheDocument();
    expect(screen.getByText("7天剩余 78%")).toBeInTheDocument();
    expect(screen.getByText(formatFullTimestamp(new Date(1_779_632_194 * 1000).toISOString(), "zh-CN"))).toBeInTheDocument();
    expect(screen.queryByText(/用量剩余/)).not.toBeInTheDocument();
    await user.click(screen.getByText("one@example.com").closest("button")!);
    expect(onOpenCodexAgent).toHaveBeenCalledWith("acc-1");
  });

  it("hides empty Codex pseudo accounts with no observable data (API Key login)", () => {
    const emptyApiKeyAccount: CodexAccountReport = {
      account_id: "unknown-account",
      signed_in: true,
      auth_mode: "apiKey",
      email: null,
      plan_type: null,
      primary: null,
      secondary: null,
      credits: null,
      rate_limit_reset_credits: null,
      rate_limit_reached_type: null,
      source: "app_server",
      updated_at: "2026-07-18T10:00:00Z",
      stale: false,
      error: null,
    };

    render(
      <OverviewChannelAccountsCard
        accounts={[]}
        channels={channels}
        snapshots={[]}
        codexAccounts={[emptyApiKeyAccount]}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onOpenCodexAgent={vi.fn()}
      />,
    );

    expect(screen.queryByText("ChatGPT 账号")).not.toBeInTheDocument();
    expect(screen.queryByText("unknown-account")).not.toBeInTheDocument();
  });

  it("keeps account operations in the row overflow menu", async () => {
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onEdit = vi.fn();
    const onToggle = vi.fn();
    const onDelete = vi.fn();

    render(
      <OverviewChannelAccountsCard
        accounts={[account]}
        channels={channels}
        snapshots={[snapshot]}
        onCreate={onCreate}
        onEdit={onEdit}
        onToggle={onToggle}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByText("已启用 1 / 共 1 个账号")).toBeInTheDocument();
    expect(screen.getByText(/资源包 4398\.70万 Tokens/)).toBeInTheDocument();
    expect(screen.getByText(/有效期至 2026-07-30/)).toBeInTheDocument();
    expect(screen.getByText("启用")).toBeInTheDocument();
    expect(screen.queryByText("管理账号")).not.toBeInTheDocument();

    await user.click(screen.getByText("LongCat 主账号").closest("button")!);
    expect(onEdit).toHaveBeenCalledWith(account.id);
    onEdit.mockClear();

    await user.click(screen.getByRole("button", { name: "账号操作：LongCat 主账号" }));
    await user.click(await screen.findByText("编辑账号"));
    expect(onEdit).toHaveBeenCalledWith(account.id);

    await user.click(screen.getByRole("button", { name: "账号操作：LongCat 主账号" }));
    await user.click(await screen.findByText("停用账号"));
    expect(onToggle).toHaveBeenCalledWith(account.id, false);

    await user.click(screen.getByRole("button", { name: "账号操作：LongCat 主账号" }));
    await user.click(await screen.findByText("删除账号"));
    expect(onDelete).toHaveBeenCalledWith(account.id);
    vi.useRealTimers();
  });

  it("hides disabled accounts by default and reveals them with the header filter", async () => {
    const user = userEvent.setup();
    const disabledAccount = {
      ...account,
      id: "account-disabled",
      name: "已停用账号",
      enabled: false,
    } as ChannelAccount;

    render(
      <OverviewChannelAccountsCard
        accounts={[account, disabledAccount]}
        channels={channels}
        snapshots={[]}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText("已启用 1 / 共 2 个账号")).toBeInTheDocument();
    expect(screen.queryByText("已停用账号")).not.toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "显示停用账号" }));

    expect(screen.getByText("已停用账号")).toBeInTheDocument();
    expect(screen.getByText("停用")).toBeInTheDocument();
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
        channels={channels}
        snapshots={[exhaustedSnapshot]}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    // 资源包用尽时剩余为 0，概览页应像余额一样照常展示，而不是隐藏资源包行。
    expect(screen.getByText(/资源包 0 Tokens/)).toBeInTheDocument();
    expect(screen.getByText(/余额/)).toBeInTheDocument();
  });

  it("renders Qwen Token Plan name, 7d remaining percentage and full reset timestamp", () => {
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
        channels={channels}
        snapshots={[qwenSnapshot]}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    const resetAt = new Date(1_785_331_200_000).toISOString();
    const sevenDay = screen.getByText("7天剩余 78.9%");
    const resetTime = screen.getByText(formatFullTimestamp(resetAt, "zh-CN"));
    expect(sevenDay.parentElement?.parentElement).toContainElement(resetTime);
    expect(screen.getByText("个人版 Standard 套餐")).toBeInTheDocument();
    expect(screen.queryByText(/5小时 剩余/)).not.toBeInTheDocument();
    expect(screen.queryByText(/七天重置/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Token Plan 订阅/)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("renders LongCat expiry using the source clock time when expiring today", () => {
    vi.setSystemTime(new Date("2026-07-30T10:00:00Z"));
    const todayIso = "2026-07-30T11:42:47Z";
    const todaySnapshot = {
      account_id: account.id,
      token_pack_remaining: 43_987_000,
      token_pack_expire_at: todayIso,
    } as AccountBalanceSnapshot;

    render(
      <OverviewChannelAccountsCard
        accounts={[account]}
        channels={channels}
        snapshots={[todaySnapshot]}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText(`有效期至 ${formatTime(todayIso, "zh-CN")}`)).toBeInTheDocument();
    expect(screen.queryByText(/有效期至 23:59:59/)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("keeps the full Qwen reset timestamp when resetting today", () => {
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
        channels={channels}
        snapshots={[qwenSnapshot]}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText("个人版 Standard 套餐")).toBeInTheDocument();
    expect(screen.getByText(formatFullTimestamp(resetAt, "zh-CN"))).toBeInTheDocument();
    expect(screen.queryByText(/七天重置/)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows a green badge on the logo when an auto-sync account is freshly synced", () => {
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    const autoAccount = {
      id: "account-longcat-auto",
      channel_id: "longcat",
      name: "LongCat 自动同步",
      api_key: "configured",
      enabled: true,
      credential_status: "healthy",
      resource_mode: "hybrid",
      resource_sync_mode: "auto",
    } as ChannelAccount;
    const freshSnapshot = {
      account_id: autoAccount.id,
      synced_at: "2026-07-29T09:58:00Z",
    } as AccountBalanceSnapshot;

    const { container } = render(
      <OverviewChannelAccountsCard
        accounts={[autoAccount]}
        channels={channels}
        snapshots={[freshSnapshot]}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(container.querySelector(".semi-badge-dot.semi-badge-success")).toBeTruthy();
    expect(container.querySelector(".semi-badge-dot.semi-badge-warning")).toBeNull();
    vi.useRealTimers();
  });

  it("shows a yellow badge on the logo when an auto-sync account missed a sync cycle", () => {
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    const autoAccount = {
      id: "account-longcat-auto",
      channel_id: "longcat",
      name: "LongCat 自动同步",
      api_key: "configured",
      enabled: true,
      credential_status: "healthy",
      resource_mode: "hybrid",
      resource_sync_mode: "auto",
    } as ChannelAccount;
    const staleSnapshot = {
      account_id: autoAccount.id,
      synced_at: "2026-07-29T09:00:00Z",
    } as AccountBalanceSnapshot;

    const { container } = render(
      <OverviewChannelAccountsCard
        accounts={[autoAccount]}
        channels={channels}
        snapshots={[staleSnapshot]}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(container.querySelector(".semi-badge-dot.semi-badge-warning")).toBeTruthy();
    expect(container.querySelector(".semi-badge-dot.semi-badge-success")).toBeNull();
    vi.useRealTimers();
  });

  it("shows a yellow badge when an auto-sync account has never been synced", () => {
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    const autoAccount = {
      id: "account-longcat-auto",
      channel_id: "longcat",
      name: "LongCat 自动同步",
      api_key: "configured",
      enabled: true,
      credential_status: "healthy",
      resource_mode: "hybrid",
      resource_sync_mode: "auto",
    } as ChannelAccount;

    const { container } = render(
      <OverviewChannelAccountsCard
        accounts={[autoAccount]}
        channels={channels}
        snapshots={[]}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(container.querySelector(".semi-badge-dot.semi-badge-warning")).toBeTruthy();
    vi.useRealTimers();
  });

  it("shows a green badge for DeepSeek official-balance-api accounts without a base URL override", () => {
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    const deepseekAccount = {
      id: "account-deepseek",
      channel_id: "deepseek",
      name: "DeepSeek 主账号",
      api_key: "configured",
      enabled: true,
      credential_status: "healthy",
      resource_mode: "pay_as_you_go",
      resource_sync_mode: "manual",
      base_url_override: null,
      workspace_default_base_url: null,
    } as ChannelAccount;
    const freshSnapshot = {
      account_id: deepseekAccount.id,
      synced_at: "2026-07-29T09:58:00Z",
    } as AccountBalanceSnapshot;

    const { container } = render(
      <OverviewChannelAccountsCard
        accounts={[deepseekAccount]}
        channels={channels}
        snapshots={[freshSnapshot]}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(container.querySelector(".semi-badge-dot.semi-badge-success")).toBeTruthy();
    vi.useRealTimers();
  });

  it("does not show a badge for manual-sync accounts", () => {
    const manualAccount = {
      id: "account-longcat-manual",
      channel_id: "longcat",
      name: "LongCat 手动维护",
      api_key: "configured",
      enabled: true,
      credential_status: "healthy",
      resource_mode: "hybrid",
      resource_sync_mode: "manual",
    } as ChannelAccount;

    const { container } = render(
      <OverviewChannelAccountsCard
        accounts={[manualAccount]}
        channels={channels}
        snapshots={[]}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(container.querySelector(".semi-badge-dot")).toBeNull();
  });

  it("shows a green badge on the logo when a Codex account was freshly synced", () => {
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    const codexAccounts: CodexAccountReport[] = [{
      account_id: "acc-codex",
      signed_in: true,
      auth_mode: "chatgpt",
      email: "codex@example.com",
      plan_type: "plus",
      primary: { used_percent: 25, window_duration_mins: 300, resets_at: 1_779_459_394 },
      secondary: null,
      credits: null,
      rate_limit_reset_credits: null,
      rate_limit_reached_type: null,
      source: "oauth",
      updated_at: "2026-07-29T09:58:00Z",
      stale: false,
      error: null,
    }];

    const { container } = render(
      <OverviewChannelAccountsCard
        accounts={[]}
        channels={channels}
        snapshots={[]}
        codexAccounts={codexAccounts}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onOpenCodexAgent={vi.fn()}
      />,
    );

    expect(container.querySelector(".semi-badge-dot.semi-badge-success")).toBeTruthy();
    expect(container.querySelector(".semi-badge-dot.semi-badge-warning")).toBeNull();
    vi.useRealTimers();
  });

  it("shows a yellow badge on the logo when a Codex account refresh failed", () => {
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    const codexAccounts: CodexAccountReport[] = [{
      account_id: "acc-codex",
      signed_in: true,
      auth_mode: "chatgpt",
      email: "codex@example.com",
      plan_type: "plus",
      primary: { used_percent: 25, window_duration_mins: 300, resets_at: 1_779_459_394 },
      secondary: null,
      credits: null,
      rate_limit_reset_credits: null,
      rate_limit_reached_type: null,
      source: "oauth",
      updated_at: "2026-07-29T09:58:00Z",
      stale: true,
      error: "Codex 账号刷新失败。OAuth 会话：登录已过期",
    }];

    const { container } = render(
      <OverviewChannelAccountsCard
        accounts={[]}
        channels={channels}
        snapshots={[]}
        codexAccounts={codexAccounts}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onOpenCodexAgent={vi.fn()}
      />,
    );

    expect(container.querySelector(".semi-badge-dot.semi-badge-warning")).toBeTruthy();
    expect(container.querySelector(".semi-badge-dot.semi-badge-success")).toBeNull();
    vi.useRealTimers();
  });

  it("shows a yellow badge on the logo when a Codex account missed a sync cycle", () => {
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    const codexAccounts: CodexAccountReport[] = [{
      account_id: "acc-codex",
      signed_in: true,
      auth_mode: "chatgpt",
      email: "codex@example.com",
      plan_type: "plus",
      primary: { used_percent: 25, window_duration_mins: 300, resets_at: 1_779_459_394 },
      secondary: null,
      credits: null,
      rate_limit_reset_credits: null,
      rate_limit_reached_type: null,
      source: "oauth",
      updated_at: "2026-07-29T09:00:00Z",
      stale: false,
      error: null,
    }];

    const { container } = render(
      <OverviewChannelAccountsCard
        accounts={[]}
        channels={channels}
        snapshots={[]}
        codexAccounts={codexAccounts}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onOpenCodexAgent={vi.fn()}
      />,
    );

    expect(container.querySelector(".semi-badge-dot.semi-badge-warning")).toBeTruthy();
    vi.useRealTimers();
  });

  it("shows an explicit unlimited-key state for OpenRouter after a successful sync", () => {
    const openRouterAccount: ChannelAccount = {
      ...account,
      id: "account-openrouter",
      channel_id: "openrouter",
      name: "OpenRouter 主账号",
      resource_mode: "pay_as_you_go",
      management_key: null,
    };
    const syncedAt = "2026-08-10T04:55:17Z";

    render(
      <OverviewChannelAccountsCard
        accounts={[openRouterAccount]}
        channels={[...channels, { id: "openrouter", name: "OpenRouter", supports_balance_query: true } as ChannelPreset]}
        snapshots={[{
          account_id: openRouterAccount.id,
          balance: null,
          currency: "USD",
          synced_at: syncedAt,
        } as AccountBalanceSnapshot]}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText("未设置 Key 限额")).toBeInTheDocument();
    expect(screen.queryByText("尚未同步")).not.toBeInTheDocument();
  });
});
