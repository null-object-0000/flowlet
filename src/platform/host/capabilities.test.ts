import { afterEach, describe, expect, it, vi } from "vitest";
import { open, save } from "./dialog";
import { listen } from "./events";

afterEach(() => { delete window.flowletDesktop; });

describe("local Host capabilities", () => {
  it("forwards file options and keeps cancellation distinct from errors", async () => {
    const dialog = { open: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue("/export.json") };
    window.flowletDesktop = { mode: "host", dialog };
    const options = { defaultPath: "export.json", filters: [{ name: "JSON", extensions: ["json"] }] };
    await expect(open(options)).resolves.toBeNull();
    await expect(save(options)).resolves.toBe("/export.json");
    expect(dialog.open).toHaveBeenCalledWith(options);
    expect(dialog.save).toHaveBeenCalledWith(options);
    dialog.open.mockRejectedValue(new Error("dialog failed"));
    await expect(open()).rejects.toThrow("dialog failed");
  });
  it("rejects local file access in browsers and client mode, even with an injected dialog", async () => {
    await expect(open()).rejects.toThrow(/桌面桥不可用/);
    const dialog = { open: vi.fn(), save: vi.fn() };
    window.flowletDesktop = { mode: "client", dialog };
    await expect(open()).rejects.toThrow(/客户端模式/);
    await expect(save()).rejects.toThrow(/客户端模式/);
    expect(dialog.open).not.toHaveBeenCalled();
    expect(dialog.save).not.toHaveBeenCalled();
  });
  it("subscribes to the two fixed Host events and releases listeners", async () => {
    const unsubscribe = vi.fn();
    const events = { onAgentSourceChanged: vi.fn().mockReturnValue(unsubscribe), onStorageUsageProgress: vi.fn().mockReturnValue(unsubscribe) };
    window.flowletDesktop = { mode: "host", events };
    const changed = vi.fn();
    const progress = vi.fn();
    const stopChanges = await listen("agent-source-changed", changed);
    const stopProgress = await listen("storage-usage-progress", progress);
    events.onAgentSourceChanged.mock.calls[0][0]({ source: "watch" });
    events.onStorageUsageProgress.mock.calls[0][0]({ scanId: "s", summary: {} });
    expect(changed).toHaveBeenCalledWith({ payload: { source: "watch" } });
    expect(progress).toHaveBeenCalledWith({ payload: { scanId: "s", summary: {} } });
    stopChanges(); stopProgress();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
  it("does not subscribe to local events in Web/client mode", async () => {
    await expect(listen("agent-source-changed", vi.fn())).resolves.toBeTypeOf("function");
    const events = { onAgentSourceChanged: vi.fn(), onStorageUsageProgress: vi.fn() };
    window.flowletDesktop = { mode: "client", events };
    await listen("storage-usage-progress", vi.fn());
    expect(events.onStorageUsageProgress).not.toHaveBeenCalled();
  });
  it("fails visibly when a local Host preload is incomplete", async () => {
    window.flowletDesktop = { mode: "host" };
    await expect(listen("storage-usage-progress", vi.fn())).rejects.toThrow(/events 未注入/);
  });
});
