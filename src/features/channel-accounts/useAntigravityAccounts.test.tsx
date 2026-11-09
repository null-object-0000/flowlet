import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useAntigravityAccountActions } from "./useAntigravityAccounts";
import { authorizeAntigravityAccount, deleteAntigravityAccount, type AntigravityAccountReport, type AntigravityAccountsReport } from "../../domains/agent/antigravity";
import { queryKeys } from "../../shared/query-keys";

vi.mock("../../domains/agent/antigravity", () => ({ authorizeAntigravityAccount: vi.fn(), deleteAntigravityAccount: vi.fn(), queryAntigravityAccounts: vi.fn() }));
const report = (id: string, source: "local" | "oauth" = "oauth"): AntigravityAccountReport => ({
  account_id: id, email: id, source, stale: false, reauthorization_required: false,
  plan: null, quotas: [], quota_source: null, updated_at: "2026-11-06T00:00:00Z", error: null,
});
function setup(accounts: AntigravityAccountReport[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const key = queryKeys.agent.antigravityAccounts();
  client.setQueryData(key, { accounts });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, key, ...renderHook(() => useAntigravityAccountActions(), { wrapper }) };
}

describe("Antigravity account cache mutations", () => {
  it("replaces matching local identity after authorization while preserving other accounts", async () => {
    const local = { ...report("same@example.test", "local"), account_id: "local-123" };
    const { client, key, result } = setup([local, report("other@example.test")]);
    vi.mocked(authorizeAntigravityAccount).mockResolvedValue(report("same@example.test"));
    await act(async () => { await result.current.authorize.mutateAsync(); });
    const accounts = client.getQueryData<AntigravityAccountsReport>(key)!.accounts;
    expect(accounts.map((a) => a.account_id)).toEqual(["other@example.test", "same@example.test"]);
    expect(accounts[1].source).toBe("oauth");
  });

  it("a late refresh cannot resurrect deleted authorization or remove unrelated accounts", async () => {
    const saved = report("delete@example.test");
    const other = report("keep@example.test");
    const { client, key, result } = setup([saved, other]);
    let resolve!: (report: AntigravityAccountsReport) => void;
    const request = client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: () => new Promise<AntigravityAccountsReport>((r) => { resolve = r; }) }).catch(() => undefined);
    vi.mocked(deleteAntigravityAccount).mockResolvedValue(undefined);
    await act(async () => { await result.current.remove.mutateAsync(saved.account_id); });
    resolve({ accounts: [saved, other] });
    await request;
    expect(client.getQueryData<AntigravityAccountsReport>(key)!.accounts).toEqual([other]);
  });
});
