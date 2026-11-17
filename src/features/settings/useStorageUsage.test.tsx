import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageUsageSummary } from "../../domains/settings/types";

const mocks = vi.hoisted(() => ({ get: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("../../domains/settings/commands", () => ({ getStorageUsage: mocks.get }));
vi.mock("../../platform/host/events", () => ({ listen: mocks.listen }));
import { useStorageUsage } from "./useStorageUsage";

const summary: StorageUsageSummary = {
  totalBytes: 100, databaseBytes: 80, reclaimableBytes: 0, autoVacuumMode: 2,
  walBytes: 0, sharedMemoryBytes: 0, configBytes: 20, captureBytes: 0,
  categorizedBytes: 0, categories: [],
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => { vi.resetAllMocks(); });

describe("storage usage Host progress", () => {
  it("filters progress by scanId, keeps final HTTP results authoritative, and unsubscribes", async () => {
    let onProgress!: (event: { payload: { scanId: string; summary: StorageUsageSummary } }) => void;
    let finish!: (value: StorageUsageSummary) => void;
    mocks.listen.mockImplementation(async (_name, listener) => { onProgress = listener; return mocks.unlisten; });
    mocks.get.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderHook(() => useStorageUsage(), { wrapper });
    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
    const scanId = mocks.get.mock.calls[0][0] as string;
    expect(mocks.listen).toHaveBeenCalledWith("storage-usage-progress", expect.any(Function));
    act(() => onProgress({ payload: { scanId: "another-scan", summary } }));
    expect(view.result.current.progress.totalBytes).toBe(0);
    act(() => onProgress({ payload: { scanId, summary } }));
    await waitFor(() => expect(view.result.current.progress.totalBytes).toBe(100));
    await act(async () => { finish({ ...summary, totalBytes: 120 }); });
    await waitFor(() => expect(view.result.current.data?.totalBytes).toBe(120));
    expect(view.result.current.progress.totalBytes).toBe(120);
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("unsubscribes when the HTTP scan fails instead of retaining a dangling listener", async () => {
    mocks.listen.mockResolvedValue(mocks.unlisten);
    mocks.get.mockRejectedValue(new Error("scan failed"));
    const view = renderHook(() => useStorageUsage(), { wrapper });
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    view.unmount();
  });
});
