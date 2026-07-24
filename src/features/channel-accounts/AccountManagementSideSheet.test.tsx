import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import { AccountManagementSideSheet } from "./AccountManagementSideSheet";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

const account = {
  id: "account-1",
  channel_id: "longcat",
  name: "主账号",
  api_key: "secret-key",
  enabled: true,
  credential_status: "healthy",
  resource_mode: "hybrid",
  resource_sync_mode: "manual",
} as ChannelAccount;

const preset = {
  id: "longcat",
  name: "LongCat",
  openai_base_url: "https://example.com",
} as ChannelPreset;

describe("AccountManagementSideSheet", () => {
  it("edits in the drawer flow and preserves an unchanged API key", async () => {
    const user = userEvent.setup();
    const onSaveAccounts = vi.fn<(accounts: ChannelAccount[]) => Promise<void>>().mockResolvedValue();

    render(
      <AccountManagementSideSheet
        request={{ kind: "list" }}
        accounts={[account]}
        snapshots={[]}
        presets={[preset]}
        busy={false}
        onClose={vi.fn()}
        onSaveAccounts={onSaveAccounts}
        onTestConnection={vi.fn().mockResolvedValue(undefined)}
        onSaveBalanceSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSyncBalance={vi.fn().mockResolvedValue(undefined)}
        onScrape={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText(/渠道账号管理/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "编辑账号 主账号" }));
    expect(await screen.findByText("编辑渠道账号")).toBeInTheDocument();
    expect(screen.queryByText(/渠道账号管理/)).not.toBeInTheDocument();
    expect(screen.queryByText("选择渠道")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^LongCat$/ })).not.toBeInTheDocument();
    const apiKeyInput = screen.getByLabelText("API Key");
    expect(apiKeyInput).toHaveValue("secret-key");
    expect(apiKeyInput).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(apiKeyInput).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接成功，API Key 有效")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(onSaveAccounts).toHaveBeenCalledWith([
      expect.objectContaining({ id: account.id, api_key: "secret-key" }),
    ]);
  });

  it("shows LongCat resource package details saved by automatic synchronization", async () => {
    const autoAccount: ChannelAccount = { ...account, resource_sync_mode: "auto" };
    const tokenPacks = JSON.stringify([
      { lotId: 151724, source: "FREE_PACK", totalToken: 50_000_000, consumedToken: 36_679_022, remainingToken: 13_320_978, expireTime: "2026-07-30 01:00:31", status: "ACTIVE" },
      { lotId: 159869, source: "FREE_PACK", totalToken: 10_000_000, consumedToken: 0, remainingToken: 10_000_000, expireTime: "2026-07-30 09:42:47", status: "ACTIVE" },
    ]);

    render(
      <AccountManagementSideSheet
        request={{ kind: "edit", accountId: autoAccount.id }}
        accounts={[autoAccount]}
        snapshots={[{
          id: "snapshot-scrape",
          account_id: autoAccount.id,
          balance: 123.45,
          currency: "CNY",
          token_pack_total: 60_000_000,
          token_pack_used: 36_679_022,
          token_pack_remaining: 23_320_978,
          token_pack_expire_at: "2026-07-30 01:00:31",
          token_packs: tokenPacks,
          raw_scraped_json: null,
          source: "scrape",
          synced_at: "2026-07-23T04:35:26Z",
          remark: "控制台抓取",
          created_at: "2026-07-23T04:35:26Z",
          updated_at: "2026-07-23T04:35:26Z",
        }]}
        presets={[{ ...preset, supports_scrape_balance: true, supports_balance_query: false }]}
        busy={false}
        onClose={vi.fn()}
        onSaveAccounts={vi.fn().mockResolvedValue(undefined)}
        onTestConnection={vi.fn().mockResolvedValue(undefined)}
        onSaveBalanceSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSyncBalance={vi.fn().mockResolvedValue(undefined)}
        onScrape={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByText("资源包明细")).toBeInTheDocument();
    expect(screen.getByText("剩余 38.9%")).toBeInTheDocument();
    expect(screen.getByText("151724")).toBeInTheDocument();
    expect(screen.getByText("159869")).toBeInTheDocument();
    expect(screen.getAllByText("FREE_PACK")).toHaveLength(2);
    expect(screen.getByText("生效中")).toBeInTheDocument();
    expect(screen.getByText("待使用")).toBeInTheDocument();
    // hybrid 模式下余额也展示。
    expect(screen.getByText("123.45 CNY")).toBeInTheDocument();
  });

  it("shows the complete Qwen Token Plan subscription and both quota windows", async () => {
    const qwenAccount: ChannelAccount = {
      ...account,
      id: "account-qwen-auto",
      channel_id: "qwen",
      name: "千问 Token Plan",
      resource_mode: "token_plan",
      resource_sync_mode: "auto",
    };
    const raw = JSON.stringify({
      subscription: qwenResponse({
        specCode: "standard",
        remainingDays: 28,
        startTime: 1784512320000,
        endTime: 1787241600000,
        autoRenewFlag: false,
        status: "VALID",
      }),
      quota_config: qwenResponse({
        standard: { five_hour: 3000, weekly: 10000 },
      }),
      usage: qwenResponse({
        per5HourPercentage: 0,
        per1WeekPercentage: 0.789,
        per1WeekResetTime: 1785130440000,
      }),
    });

    render(
      <AccountManagementSideSheet
        request={{ kind: "edit", accountId: qwenAccount.id }}
        accounts={[qwenAccount]}
        snapshots={[{
          id: "snapshot-qwen",
          account_id: qwenAccount.id,
          balance: null,
          currency: null,
          token_pack_total: 10000,
          token_pack_used: 7890,
          token_pack_remaining: 2110,
          token_pack_expire_at: new Date(1787241600000).toISOString(),
          token_packs: null,
          raw_scraped_json: raw,
          source: "scrape",
          synced_at: "2026-07-23T05:33:04Z",
          remark: "控制台抓取",
          created_at: "2026-07-23T05:33:04Z",
          updated_at: "2026-07-23T05:33:04Z",
        }]}
        presets={[{
          ...preset,
          id: "qwen",
          name: "千问 Qwen",
          supports_scrape_balance: true,
          supports_balance_query: false,
        }]}
        busy={false}
        onClose={vi.fn()}
        onSaveAccounts={vi.fn().mockResolvedValue(undefined)}
        onTestConnection={vi.fn().mockResolvedValue(undefined)}
        onSaveBalanceSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSyncBalance={vi.fn().mockResolvedValue(undefined)}
        onScrape={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByText("个人版 Standard 套餐")).toBeInTheDocument();
    expect(screen.getByText("生效中")).toBeInTheDocument();
    expect(screen.getByText("28 天")).toBeInTheDocument();
    expect(screen.getByText("每 5 小时额度")).toBeInTheDocument();
    expect(screen.getByText("每 7 天额度")).toBeInTheDocument();
    expect(screen.getByText("100.0%")).toBeInTheDocument();
    expect(screen.getByText("21.1%")).toBeInTheDocument();
    expect(screen.getAllByText("3,000 Credits")).toHaveLength(2);
    expect(screen.getByText("2,110 Credits")).toBeInTheDocument();
  });

  it("shows balance refresh feedback in a toast", async () => {
    const user = userEvent.setup();
    const onSyncBalance = vi.fn().mockResolvedValue(undefined);
    const deepSeekAccount: ChannelAccount = { ...account, id: "account-deepseek", channel_id: "deepseek", name: "DeepSeek 主账号", resource_mode: "pay_as_you_go" };
    const deepSeekPreset: ChannelPreset = { ...preset, id: "deepseek", name: "DeepSeek", supports_balance_query: true };

    render(
      <AccountManagementSideSheet
        request={{ kind: "list" }}
        accounts={[deepSeekAccount]}
        snapshots={[]}
        presets={[deepSeekPreset]}
        busy={false}
        onClose={vi.fn()}
        onSaveAccounts={vi.fn().mockResolvedValue(undefined)}
        onTestConnection={vi.fn().mockResolvedValue(undefined)}
        onSaveBalanceSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSyncBalance={onSyncBalance}
        onScrape={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "编辑账号 DeepSeek 主账号" }));
    await user.click(await screen.findByRole("button", { name: /刷新/ }));
    expect(onSyncBalance).toHaveBeenCalledWith(deepSeekAccount.id);
    expect(await screen.findByText("余额已同步")).toBeInTheDocument();
  });

  it("fills Token Plan endpoints when selecting the Qwen subscription mode", async () => {
    const user = userEvent.setup();
    const onSaveAccounts = vi.fn<(accounts: ChannelAccount[]) => Promise<void>>().mockResolvedValue();
    const onSaveBalanceSnapshot = vi.fn().mockResolvedValue(undefined);
    const qwenPreset = {
      id: "qwen",
      name: "千问 Qwen",
      openai_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      anthropic_base_url: "https://dashscope.aliyuncs.com/apps/anthropic",
    } as ChannelPreset;

    render(
      <AccountManagementSideSheet
        request={{ kind: "create", channelId: "qwen" }}
        accounts={[]}
        snapshots={[]}
        presets={[qwenPreset]}
        busy={false}
        onClose={vi.fn()}
        onSaveAccounts={onSaveAccounts}
        onTestConnection={vi.fn().mockResolvedValue(undefined)}
        onSaveBalanceSnapshot={onSaveBalanceSnapshot}
        onSyncBalance={vi.fn().mockResolvedValue(undefined)}
        onScrape={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByText("新增渠道账号")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("请输入渠道 API Key"), "sk-sp-test");
    await user.click(screen.getByRole("button", { name: /Token Plan/ }));
    expect(screen.getByText("Token Plan 订阅信息")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存账号" }));

    expect(onSaveAccounts).toHaveBeenCalledWith([expect.objectContaining({
      channel_id: "qwen",
      api_key: "sk-sp-test",
      resource_mode: "token_plan",
      base_url_override: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      anthropic_base_url_override: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
    })]);
    // Token Plan 额度只在官方控制台查看，本地不保存资源快照
    expect(onSaveBalanceSnapshot).not.toHaveBeenCalled();
  });

  it("keeps the saved resource mode and Token Plan endpoints immutable while editing", async () => {
    const user = userEvent.setup();
    const onSaveAccounts = vi.fn<(accounts: ChannelAccount[]) => Promise<void>>().mockResolvedValue();
    const planAccount: ChannelAccount = {
      ...account,
      id: "account-qwen-plan",
      channel_id: "qwen",
      name: "千问 Token Plan",
      resource_mode: "token_plan",
      base_url_override: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      anthropic_base_url_override: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
    };
    const qwenPreset = {
      id: "qwen",
      name: "千问 Qwen",
      openai_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      anthropic_base_url: "https://dashscope.aliyuncs.com/apps/anthropic",
    } as ChannelPreset;

    render(
      <AccountManagementSideSheet
        request={{ kind: "edit", accountId: planAccount.id }}
        accounts={[planAccount]}
        snapshots={[]}
        presets={[qwenPreset]}
        busy={false}
        onClose={vi.fn()}
        onSaveAccounts={onSaveAccounts}
        onTestConnection={vi.fn().mockResolvedValue(undefined)}
        onSaveBalanceSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSyncBalance={vi.fn().mockResolvedValue(undefined)}
        onScrape={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByText("Token Plan 订阅信息")).toBeInTheDocument();
    expect(screen.getByText("计费模式")).toBeInTheDocument();
    expect(screen.getByText("Token Plan")).toBeInTheDocument();
    expect(screen.getByText("创建后不可修改")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /API 按量付费/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(onSaveAccounts).toHaveBeenCalledWith([expect.objectContaining({
      id: planAccount.id,
      resource_mode: "token_plan",
      base_url_override: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      anthropic_base_url_override: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
    })]);
  });
});

function qwenResponse(data: Record<string, unknown>) {
  return { data: { DataV2: { data: { data } } } };
}
