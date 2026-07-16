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
  resource_mode: "token_pack",
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
      />,
    );

    expect(screen.getByText(/渠道账号管理/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "编辑账号 主账号" }));
    expect(await screen.findByText("编辑渠道账号")).toBeInTheDocument();
    expect(screen.queryByText(/渠道账号管理/)).not.toBeInTheDocument();
    expect(screen.queryByText("选择渠道")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /LongCat/ })).not.toBeInTheDocument();
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

  it("opens the full create drawer and saves manual resource information", async () => {
    const user = userEvent.setup();
    const onSaveAccounts = vi.fn<(accounts: ChannelAccount[]) => Promise<void>>().mockResolvedValue();
    const onSaveBalanceSnapshot = vi.fn().mockResolvedValue(undefined);

    render(
      <AccountManagementSideSheet
        request={{ kind: "create", channelId: "longcat" }}
        accounts={[]}
        snapshots={[]}
        presets={[preset]}
        busy={false}
        onClose={vi.fn()}
        onSaveAccounts={onSaveAccounts}
        onTestConnection={vi.fn().mockResolvedValue(undefined)}
        onSaveBalanceSnapshot={onSaveBalanceSnapshot}
        onSyncBalance={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByText("新增渠道账号")).toBeInTheDocument();
    expect(screen.queryByText(/渠道账号管理/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /LongCat/ })).toBeEnabled();
    await user.type(screen.getByPlaceholderText("请输入渠道 API Key"), "sk-test");
    await user.click(screen.getByRole("button", { name: "管理资源包" }));
    expect(await screen.findByText("LongCat 资源包管理")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /添加资源包/ }));
    await user.type(screen.getByLabelText("资源包 1 总量"), "1000");
    await user.type(screen.getByLabelText("资源包 1 已消耗"), "250");
    await user.type(screen.getByLabelText("资源包 1 剩余"), "750");
    await user.click(screen.getByRole("button", { name: "保存资源包" }));
    expect(screen.getByText("已维护 1 个资源包")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存账号" }));

    expect(onSaveAccounts).toHaveBeenCalledWith([expect.objectContaining({ channel_id: "longcat", api_key: "sk-test", resource_mode: "token_pack" })]);
    expect(onSaveBalanceSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      token_pack_total: 1000,
      token_pack_used: 250,
      token_pack_remaining: 750,
      token_packs: expect.stringContaining('"totalToken":1000'),
    }));
  });
  it("repairs a timezone-shifted snapshot expiry from the stored package data", async () => {
    const user = userEvent.setup();
    const onSaveBalanceSnapshot = vi.fn().mockResolvedValue(undefined);
    const tokenPacks = JSON.stringify([
      { lotId: 151724, totalToken: 50_000_000, consumedToken: 22_071_022, remainingToken: 27_928_978, expireTime: "2026-07-30 01:00:31", status: "ACTIVE" },
      { lotId: 159869, totalToken: 10_000_000, consumedToken: 0, remainingToken: 10_000_000, expireTime: "2026-07-30 09:42:47", status: "ACTIVE" },
      { lotId: 160795, totalToken: 5_000_000, consumedToken: 0, remainingToken: 5_000_000, expireTime: "2026-07-30 11:48:49", status: "ACTIVE" },
    ]);

    render(
      <AccountManagementSideSheet
        request={{ kind: "edit", accountId: account.id }}
        accounts={[account]}
        snapshots={[{
          id: "snapshot-1",
          account_id: account.id,
          balance: null,
          currency: null,
          token_pack_total: 65_000_000,
          token_pack_used: 22_071_022,
          token_pack_remaining: 42_928_978,
          token_pack_expire_at: "2026-07-29T16:00:00.000Z",
          token_packs: tokenPacks,
          source: "manual",
          synced_at: "2026-07-15T00:00:00.000Z",
          remark: null,
          created_at: "2026-07-15T00:00:00.000Z",
          updated_at: "2026-07-15T00:00:00.000Z",
        }]}
        presets={[preset]}
        busy={false}
        onClose={vi.fn()}
        onSaveAccounts={vi.fn().mockResolvedValue(undefined)}
        onTestConnection={vi.fn().mockResolvedValue(undefined)}
        onSaveBalanceSnapshot={onSaveBalanceSnapshot}
        onSyncBalance={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByText("2026-07-30")).toBeInTheDocument();
    expect(screen.queryByText("2026-07-29")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    expect(onSaveBalanceSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      token_pack_expire_at: "2026-07-30T23:59:59",
    }));
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
      />,
    );

    await user.click(await screen.findByRole("button", { name: "编辑账号 DeepSeek 主账号" }));
    await user.click(await screen.findByRole("button", { name: /刷新/ }));
    expect(onSyncBalance).toHaveBeenCalledWith(deepSeekAccount.id);
    expect(await screen.findByText("余额已同步")).toBeInTheDocument();
  });
});
