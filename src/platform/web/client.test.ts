import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminToken,
  setAdminToken,
  verifyAdminToken,
  invokeWebCommand,
} from "./client";

describe("web command transport", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());
  it("uses the management token and POST arguments without putting the token in a URL", async () => {
    setAdminToken("test-management-token");
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([{ id: "account" }]), { status: 200 }),
    );
    expect(
      await invokeWebCommand("list_channel_accounts", { enabled: true }),
    ).toEqual([{ id: "account" }]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/commands/list_channel_accounts",
      expect.objectContaining({
        method: "POST",
        body: '{"enabled":true}',
        cache: "no-store",
        headers: expect.objectContaining({
          Authorization: "Bearer test-management-token",
        }),
      }),
    );
  });
  it("clears the session and notifies the shell after an expired credential", async () => {
    setAdminToken("expired-token");
    const expired = vi.fn();
    window.addEventListener("flowlet-web-unauthorized", expired);
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: "管理凭据无效" }), {
        status: 401,
      }),
    );
    await expect(invokeWebCommand("list_channel_accounts")).rejects.toThrow(
      "管理凭据无效",
    );
    expect(adminToken()).toBe("");
    expect(expired).toHaveBeenCalledOnce();
    window.removeEventListener("flowlet-web-unauthorized", expired);
  });
  it("rejects invalid login without saving the submitted credential", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(verifyAdminToken("incorrect-token")).rejects.toThrow(
      "管理凭据无效",
    );
    expect(adminToken()).toBe("");
  });
});
