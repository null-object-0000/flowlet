import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  client: { invalidateQueries: vi.fn() },
  listen: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock("../../domains/background-task/commands", () => ({
  backgroundTaskCommands: { syncAgentData: mocks.sync },
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => mocks.client }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { AgentDataAutoSync, getNextAgentSyncAt } from "./AgentDataAutoSync";

let sourceChanged: () => void;
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
function visibility(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}

describe("AgentDataAutoSync scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T00:00:00Z"));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    mocks.sync.mockResolvedValue({ started: true });
    mocks.client.invalidateQueries.mockResolvedValue(undefined);
    mocks.listen.mockImplementation(async (_event, callback) => {
      sourceChanged = callback;
      return mocks.unlisten;
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.resetAllMocks();
    Reflect.deleteProperty(document, "hidden");
  });

  it("keeps one periodic timer under StrictMode and stops on unmount", async () => {
    const view = render(<StrictMode><AgentDataAutoSync /></StrictMode>);
    await advance(3_000);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.sync).toHaveBeenLastCalledWith(false, "foreground");
    await advance(60_000);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    view.unmount();
    await advance(300_000);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    expect(getNextAgentSyncAt()).toBeNull();
    expect(mocks.unlisten).toHaveBeenCalledTimes(2);
  });

  it("slows down immediately when hidden and checks once after returning", async () => {
    render(<AgentDataAutoSync />);
    await advance(3_000);
    visibility(true);
    await advance(299_999);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mocks.sync).toHaveBeenLastCalledWith(false, "background");
    visibility(false);
    visibility(false);
    await advance(1_000);
    expect(mocks.sync).toHaveBeenCalledTimes(3);
    expect(mocks.sync).toHaveBeenLastCalledWith(false, "foreground");
  });

  it("coalesces file and focus triggers during a slow scan without overlapping calls", async () => {
    let finish!: (value: { started: boolean }) => void;
    mocks.sync.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<AgentDataAutoSync />);
    await advance(3_000);
    visibility(false);
    act(() => sourceChanged());
    await advance(8_000);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ started: true }); });
    await advance(1_000);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    await advance(60_000);
    expect(mocks.sync).toHaveBeenCalledTimes(3);
  });

  it("debounces bursts and retains file changes received during the cooldown", async () => {
    render(<AgentDataAutoSync />);
    await advance(3_000);
    act(() => sourceChanged());
    await advance(4_000);
    act(() => sourceChanged());
    await advance(7_999);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mocks.sync).toHaveBeenLastCalledWith(false, "file-watch");
    act(() => sourceChanged());
    await advance(29_999);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(mocks.sync).toHaveBeenCalledTimes(3);
  });

  it("does not rearm or invalidate queries after an in-flight scan is unmounted", async () => {
    let finish!: (value: { started: boolean }) => void;
    mocks.sync.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<AgentDataAutoSync />);
    await advance(3_000);
    view.unmount();
    await act(async () => { finish({ started: true }); });
    await advance(300_000);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.client.invalidateQueries).not.toHaveBeenCalled();
    expect(getNextAgentSyncAt()).toBeNull();
  });

  it("measures file cooldown from the actual follow-up scan, including already queued events", async () => {
    let finish!: (value: { started: boolean }) => void;
    mocks.sync.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<AgentDataAutoSync />);
    await advance(3_000);
    act(() => sourceChanged());
    await advance(8_000);
    act(() => sourceChanged());
    await act(async () => { finish({ started: true }); });
    await advance(1_000);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    expect(mocks.sync).toHaveBeenLastCalledWith(false, "file-watch");
    await advance(29_999);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(mocks.sync).toHaveBeenCalledTimes(3);
  });

  it("continues the normal cadence after failure", async () => {
    mocks.sync.mockRejectedValueOnce(new Error("scan failed"));
    render(<AgentDataAutoSync />);
    await advance(3_000);
    await advance(60_000);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    expect(mocks.client.invalidateQueries).toHaveBeenCalledTimes(3);
  });
});
