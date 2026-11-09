import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AntigravityAccountReport } from "../../domains/agent/antigravity";
import { AntigravityAccountSideSheet } from "./AntigravityAccountView";
import { OverviewChannelAccountsCard } from "./OverviewChannelAccountsCard";

const account: AntigravityAccountReport = {
  account_id: "person@example.test", source: "oauth", stale: false, reauthorization_required: false, email: "person@example.test", plan: "Ultra", quota_source: "summary",
  updated_at: "2026-11-06T00:00:00Z", error: null,
  quotas: [
    { id: "weekly", label: "Gemini Weekly", remaining_fraction: 0.25, reset_at: "2026-11-07T00:00:00Z", description: "Weekly allowance", disabled: false },
    { id: "unknown", label: "Claude", remaining_fraction: null, reset_at: null, description: null, disabled: false },
    { id: "disabled", label: "Disabled", remaining_fraction: 0, reset_at: null, description: null, disabled: true },
  ],
};

vi.mock("lottie-web", () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) } }));

describe("Antigravity quota observation", () => {
  it("shows observation accounts without proxy accounts and opens their details without edit actions", async () => {
    const onOpen = vi.fn();
    const onEdit = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OverviewChannelAccountsCard accounts={[]} channels={[]} snapshots={[]} antigravityAccounts={[account]}
        onCreate={vi.fn()} onEdit={onEdit} onOpenAntigravity={onOpen} />
    </QueryClientProvider>);
    expect(screen.getByText("Gemini Weekly · 剩余 25%")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Antigravity · person@example.test · Ultra"));
    expect(onOpen).toHaveBeenCalledWith(account.account_id);
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/账号操作/)).not.toBeInTheDocument();
  });

  it("preserves unknown and disabled quota and exposes reset, refresh and stale data", async () => {
    const refresh = vi.fn();
    render(<AntigravityAccountSideSheet accounts={[account]} accountId={account.account_id} loading={false}
      error="Local service unavailable" onRefresh={refresh} onClose={vi.fn()} />);
    expect(screen.getByText("额度未知")).toBeInTheDocument();
    expect(screen.getByText("不可用")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByRole("progressbar", { name: "Gemini Weekly" })).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText(/重置时间/)).toBeInTheDocument();
    expect(screen.getByText(/Local service unavailable/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "刷新用量" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("provides a retry path when no server is running", async () => {
    const refresh = vi.fn();
    render(<AntigravityAccountSideSheet accounts={[]} accountId={null} loading={false}
      onRefresh={refresh} onClose={vi.fn()} />);
    expect(screen.getByText(/尚未添加 Antigravity 授权账号/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "刷新用量" }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});

it("offers browser authorization without a running client and locks refresh while waiting", async () => {
  const authorize = vi.fn();
  const { rerender } = render(<AntigravityAccountSideSheet accounts={[]} accountId={null} loading={false}
    onRefresh={vi.fn()} onClose={vi.fn()} onAuthorize={authorize} />);
  await userEvent.click(screen.getByRole("button", { name: "授权登录" }));
  expect(authorize).toHaveBeenCalledOnce();
  rerender(<AntigravityAccountSideSheet accounts={[]} accountId={null} loading={false}
    onRefresh={vi.fn()} onClose={vi.fn()} onAuthorize={authorize} authorizationBusy />);
  expect(screen.getByText("等待浏览器授权…")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "刷新用量" })).toHaveAttribute("aria-disabled", "true");
});

it("requires confirmation to remove saved OAuth and offers reauthorization for expired grants", async () => {
  const remove = vi.fn();
  const authorize = vi.fn();
  render(<AntigravityAccountSideSheet accounts={[{ ...account, reauthorization_required: true, stale: true }]}
    accountId={account.account_id} loading={false} onRefresh={vi.fn()} onClose={vi.fn()}
    onDelete={remove} onAuthorize={authorize} />);
  expect(screen.getByText("Google 授权")).toBeInTheDocument();
  expect(screen.getByText("当前展示上次成功查询的数据")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "重新授权" }));
  expect(authorize).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole("button", { name: "移除授权" }));
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByText(/将移除 Flowlet 保存的 person@example.test/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /确定|确认/ }));
  expect(remove).toHaveBeenCalledWith(account.account_id);
});
