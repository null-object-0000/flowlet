import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn<(command: string, args?: unknown) => Promise<unknown>>());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function setBridge(bridge: unknown) {
  (window as { flowletDesktop?: unknown }).flowletDesktop = bridge;
}

async function loadCommandClient(mode: "desktop" | "production") {
  vi.stubEnv("MODE", mode);
  vi.resetModules();
  return import("../tauri/client");
}

describe("invokeCommand desktop transport", () => {
  beforeEach(() => {
    sessionStorage.clear();
    invokeMock.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    setBridge(undefined);
  });

  it("posts commands to the Node Host with the preload admin token", async () => {
    setBridge({ adminToken: "preload-admin-token" });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([{ id: "account" }]), { status: 200 }),
    );

    const { invokeCommand } = await loadCommandClient("desktop");
    const result = await invokeCommand("list_channel_accounts", { enabled: true });

    expect(result).toEqual([{ id: "account" }]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/commands/list_channel_accounts",
      expect.objectContaining({
        method: "POST",
        body: '{"enabled":true}',
        cache: "no-store",
        headers: expect.objectContaining({
          Authorization: "Bearer preload-admin-token",
        }),
      }),
    );
    const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("prefers a session token over the preload token (web semantics unchanged)", async () => {
    setBridge({ adminToken: "preload-admin-token" });
    sessionStorage.setItem("flowlet.web.admin-token", "session-token");
    vi.mocked(fetch).mockResolvedValue(new Response("null", { status: 200 }));

    const { invokeCommand } = await loadCommandClient("desktop");
    await invokeCommand("proxy_status");

    const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer session-token");
  });

  it("throws a retryable error on 401 without clearing user data or redirecting", async () => {
    setBridge({ adminToken: "preload-admin-token" });
    const unauthorized = vi.fn();
    window.addEventListener("flowlet-web-unauthorized", unauthorized);
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: "管理凭据无效" }), { status: 401 }),
    );

    const { invokeCommand } = await loadCommandClient("desktop");
    await expect(invokeCommand("list_channel_accounts")).rejects.toMatchObject({
      name: "InvokeError",
      message: "管理凭据无效",
      retryable: true,
    });

    expect(unauthorized).not.toHaveBeenCalled();
    // desktop token 由主进程注入，401 不应清掉用户数据/凭据。
    expect(sessionStorage.getItem("flowlet.web.admin-token")).toBeNull();
    expect((window.flowletDesktop as { adminToken?: string }).adminToken).toBe("preload-admin-token");
    window.removeEventListener("flowlet-web-unauthorized", unauthorized);
  });

  it("runs through Tauri IPC, not HTTP, outside the desktop/web modes", async () => {
    invokeMock.mockResolvedValue({ running: true });

    const { invokeCommand } = await loadCommandClient("production");
    await expect(invokeCommand("proxy_status")).resolves.toEqual({ running: true });

    expect(invokeMock).toHaveBeenCalledWith("proxy_status", undefined);
    expect(fetch).not.toHaveBeenCalled();
  });
});