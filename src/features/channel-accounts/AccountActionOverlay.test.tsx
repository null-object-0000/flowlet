import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { AccountActionOverlay } from "./AccountActionOverlay";

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

describe("AccountActionOverlay", () => {
  it("edits in the drawer flow and preserves an unchanged API key", async () => {
    const user = userEvent.setup();
    const onSaveAccounts = vi.fn<(accounts: ChannelAccount[]) => Promise<void>>().mockResolvedValue();

    render(
      <AccountActionOverlay
        request={{ kind: "edit", accountId: account.id }}
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

    expect(await screen.findByText("编辑 LongCat 渠道账号")).toBeInTheDocument();
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
      { lotId: "2071803119104245853", packageName: "问卷Token包", totalToken: 5_000_000, consumedToken: 5_000_000, remainingToken: 0, expireTime: "2026-07-30T03:48:49.000+00:00", statusCode: 4, statusText: "已用尽", _fromList: true },
    ]);

    render(
      <AccountActionOverlay
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
    const detailsTable = screen.getByRole("table");
    expect(within(detailsTable).getByRole("columnheader", { name: "总量 Token" })).toBeInTheDocument();
    expect(within(detailsTable).getByRole("columnheader", { name: "已用 Token" })).toBeInTheDocument();
    expect(within(detailsTable).getAllByText("500.00万")).toHaveLength(2);
    expect(screen.getByText("剩余 38.9%")).toBeInTheDocument();
    expect(screen.getByText("151724")).toBeInTheDocument();
    expect(screen.getByText("159869")).toBeInTheDocument();
    expect(screen.getAllByText("FREE_PACK")).toHaveLength(2);
    expect(screen.getByText("生效中")).toBeInTheDocument();
    expect(screen.getByText("待使用")).toBeInTheDocument();
    expect(screen.getByText("2071803119104245853")).toBeInTheDocument();
    expect(screen.getByText("问卷Token包")).toBeInTheDocument();
    expect(screen.getByText("已用尽")).toBeInTheDocument();
    // hybrid 模式下余额也展示。
    expect(screen.getByText("123.45 CNY")).toBeInTheDocument();
  });

  it("shows the complete Qwen Token Plan subscription and both quota windows", async () => {
    const user = userEvent.setup();
    const onSaveAccounts = vi.fn<(accounts: ChannelAccount[]) => Promise<void>>().mockResolvedValue();
    const qwenAccount: ChannelAccount = {
      ...account,
      id: "account-qwen-auto",
      channel_id: "qwen",
      name: "千问 Token Plan",
      resource_mode: "token_plan",
      resource_sync_mode: "manual",
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
        per5HourResetTime: 1785112440000,
        per1WeekPercentage: 0.789,
        per1WeekResetTime: 1785130440000,
      }),
    });

    render(
      <AccountActionOverlay
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
          name: "Qwen",
          supports_scrape_balance: true,
          supports_balance_query: false,
        }]}
        busy={false}
        onClose={vi.fn()}
        onSaveAccounts={onSaveAccounts}
        onTestConnection={vi.fn().mockResolvedValue(undefined)}
        onSaveBalanceSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSyncBalance={vi.fn().mockResolvedValue(undefined)}
        onScrape={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByText("个人版 Standard 套餐")).toBeInTheDocument();
    expect(screen.getByText("自动同步")).toBeInTheDocument();
    expect(screen.getByText("5 小时 100.0%")).toBeInTheDocument();
    expect(screen.getByText("总量 3,000 Credits")).toBeInTheDocument();
    expect(screen.getByLabelText("5 小时额度")).toBeInTheDocument();
    expect(screen.getByText("7 天 21.1%")).toBeInTheDocument();
    expect(screen.getByText("总量 10,000 Credits")).toBeInTheDocument();
    expect(screen.getByLabelText("7 天额度")).toBeInTheDocument();
    expect(screen.getAllByText("额度重置时间")).toHaveLength(2);
    expect(screen.getByText("套餐到期")).toBeInTheDocument();
    expect(screen.getByText("最近同步")).toBeInTheDocument();
    expect(screen.getByText("套餐到期").parentElement?.parentElement)
      .toBe(screen.getByText("最近同步").parentElement?.parentElement);
    expect(screen.queryByText("手动维护")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存修改" }));
    expect(onSaveAccounts).toHaveBeenCalledWith([
      expect.objectContaining({
        id: qwenAccount.id,
        resource_sync_mode: "auto",
      }),
    ]);
  });

  it("shows balance refresh feedback in a toast", async () => {
    const user = userEvent.setup();
    const onSyncBalance = vi.fn().mockResolvedValue(undefined);
    const deepSeekAccount: ChannelAccount = { ...account, id: "account-deepseek", channel_id: "deepseek", name: "DeepSeek 主账号", resource_mode: "pay_as_you_go" };
    const deepSeekPreset: ChannelPreset = { ...preset, id: "deepseek", name: "DeepSeek", supports_balance_query: true };
    const syncedAt = "2026-07-23T04:35:26Z";

    render(
      <AccountActionOverlay
        request={{ kind: "edit", accountId: deepSeekAccount.id }}
        accounts={[deepSeekAccount]}
        snapshots={[{
          id: "snapshot-deepseek",
          account_id: deepSeekAccount.id,
          balance: 88.5,
          currency: "CNY",
          token_pack_total: null,
          token_pack_used: null,
          token_pack_remaining: null,
          token_pack_expire_at: null,
          source: "sync",
          synced_at: syncedAt,
          remark: "官方余额接口同步",
          created_at: syncedAt,
          updated_at: syncedAt,
        }]}
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

    expect(screen.getByText("88.50 CNY")).toBeInTheDocument();
    expect(screen.getByText(`最近同步：${formatFullTimestamp(syncedAt, "zh-CN")}`)).toBeInTheDocument();
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
      name: "Qwen",
      openai_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      anthropic_base_url: "https://dashscope.aliyuncs.com/apps/anthropic",
    } as ChannelPreset;

    render(
      <AccountActionOverlay
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
      resource_sync_mode: "auto",
      base_url_override: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      anthropic_base_url_override: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
    })]);
    // Token Plan 额度只在官方控制台查看，本地不保存资源快照
    expect(onSaveBalanceSnapshot).not.toHaveBeenCalled();
  });

  it("creates a Qwen API pay-as-you-go account by default without Token Plan endpoint overrides", async () => {
    const user = userEvent.setup();
    const onSaveAccounts = vi.fn<(accounts: ChannelAccount[]) => Promise<void>>().mockResolvedValue();
    const onSaveBalanceSnapshot = vi.fn().mockResolvedValue(undefined);
    const qwenPreset = {
      id: "qwen",
      name: "Qwen",
      openai_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      anthropic_base_url: "https://dashscope.aliyuncs.com/apps/anthropic",
    } as ChannelPreset;

    render(
      <AccountActionOverlay
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
    // 默认资源模式为 API 按量付费，同时提供 Token Plan 订阅选项。
    expect(screen.getByRole("button", { name: /API 按量付费/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Token Plan/ })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("请输入渠道 API Key"), "sk-test");
    await user.click(screen.getByRole("button", { name: "保存账号" }));

    expect(onSaveAccounts).toHaveBeenCalledWith([expect.objectContaining({
      channel_id: "qwen",
      api_key: "sk-test",
      resource_mode: "pay_as_you_go",
      resource_sync_mode: "manual",
      base_url_override: null,
      anthropic_base_url_override: null,
    })]);
    // API 按量付费账号没有订阅快照，不触发余额快照保存。
    expect(onSaveBalanceSnapshot).not.toHaveBeenCalled();
  });

  it("shows the ChatGPT authorization panel instead of the API-key form for a chatgpt create", async () => {
    const user = userEvent.setup();
    const onAuthorizeChatGpt = vi.fn().mockResolvedValue(undefined);

    render(
      <AccountActionOverlay
        request={{ kind: "create", channelId: "chatgpt" }}
        accounts={[]}
        snapshots={[]}
        presets={[]}
        busy={false}
        onClose={vi.fn()}
        onSaveAccounts={vi.fn().mockResolvedValue(undefined)}
        onTestConnection={vi.fn().mockResolvedValue(undefined)}
        onSaveBalanceSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSyncBalance={vi.fn().mockResolvedValue(undefined)}
        onScrape={vi.fn().mockResolvedValue(undefined)}
        onAuthorizeChatGpt={onAuthorizeChatGpt}
      />,
    );

    expect(await screen.findByText("ChatGPT 账号授权")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    expect(document.querySelector('img[src="/icons/lobe/openai.svg"]')).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "授权登录" })).toBeEnabled();
    // 非表单创建：没有 API Key 输入，也没有保存按钮。
    expect(screen.queryByPlaceholderText("请输入渠道 API Key")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存账号" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "授权登录" }));
    expect(onAuthorizeChatGpt).toHaveBeenCalledTimes(1);
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
      name: "Qwen",
      openai_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      anthropic_base_url: "https://dashscope.aliyuncs.com/apps/anthropic",
    } as ChannelPreset;

    render(
      <AccountActionOverlay
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

  it("confirms deletion without opening an account-list drawer", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSaveAccounts = vi.fn<(accounts: ChannelAccount[]) => Promise<void>>().mockResolvedValue();

    render(
      <AccountActionOverlay
        request={{ kind: "delete", accountId: account.id }}
        accounts={[account]}
        snapshots={[]}
        presets={[preset]}
        busy={false}
        onClose={onClose}
        onSaveAccounts={onSaveAccounts}
        onTestConnection={vi.fn().mockResolvedValue(undefined)}
        onSaveBalanceSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSyncBalance={vi.fn().mockResolvedValue(undefined)}
        onScrape={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.queryByText(/^渠道账号$/)).not.toBeInTheDocument();
    expect(screen.getByText("确认删除账号")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    expect(onSaveAccounts).toHaveBeenCalledWith([]);
    expect(onClose).toHaveBeenCalled();
  });
});

function qwenResponse(data: Record<string, unknown>) {
  return { data: { DataV2: { data: { data } } } };
}
