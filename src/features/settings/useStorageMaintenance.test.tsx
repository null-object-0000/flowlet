import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const statusMock = vi.fn();
const stopMock = vi.fn();
const startMock = vi.fn();
const compactMock = vi.fn();

vi.mock("../../domains/proxy/commands", () => ({
  proxyCommands: {
    status: () => statusMock(),
    stop: () => stopMock(),
    start: () => startMock(),
  },
}));

vi.mock("../../domains/settings/commands", () => ({
  compactDatabase: () => compactMock(),
}));

import { isProxyAutoStartSuspended } from "../proxy-lifecycle/proxyAutoStartSuspension";
import { useStorageMaintenance } from "./useStorageMaintenance";

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useStorageMaintenance", () => {
  it("pauses and restores a running proxy around compaction", async () => {
    statusMock.mockResolvedValue({ running: true });
    stopMock.mockResolvedValue(undefined);
    startMock.mockResolvedValue(undefined);
    compactMock.mockResolvedValue({ reclaimedBytes: 1024 });
    const { result } = renderHook(() => useStorageMaintenance(), { wrapper: createWrapper() });

    await act(async () => {
      await expect(result.current.mutateAsync()).resolves.toEqual({ reclaimedBytes: 1024 });
    });

    expect(stopMock).toHaveBeenCalledOnce();
    expect(compactMock).toHaveBeenCalledOnce();
    expect(startMock).toHaveBeenCalledOnce();
    expect(isProxyAutoStartSuspended()).toBe(false);
  });

  it("restores the proxy even when compaction fails", async () => {
    statusMock.mockResolvedValue({ running: true });
    stopMock.mockResolvedValue(undefined);
    startMock.mockResolvedValue(undefined);
    compactMock.mockRejectedValue(new Error("vacuum failed"));
    const { result } = renderHook(() => useStorageMaintenance(), { wrapper: createWrapper() });

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow("vacuum failed");
    });

    expect(startMock).toHaveBeenCalledOnce();
    expect(isProxyAutoStartSuspended()).toBe(false);
  });
});
