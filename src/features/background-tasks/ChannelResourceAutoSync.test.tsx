import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  syncChannelResources: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("../../domains/account/commands", () => ({
  accountCommands: { syncChannelResources: mocks.syncChannelResources },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

import { ChannelResourceAutoSync } from "./ChannelResourceAutoSync";

describe("ChannelResourceAutoSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.syncChannelResources.mockResolvedValue({
      started: true,
      jobId: "job-1",
      accounts: 1,
      synced: 1,
      failed: 0,
      message: "ok",
    });
    mocks.invalidateQueries.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("starts after 30 seconds and refreshes resource snapshots", async () => {
    render(<ChannelResourceAutoSync />);
    expect(mocks.syncChannelResources).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(mocks.syncChannelResources).toHaveBeenCalledWith("foreground");
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(2);
  });
});
