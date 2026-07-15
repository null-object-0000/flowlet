import { describe, expect, it, vi } from "vitest";
import { toAppError, InvokeError } from "./client";

// The proxy commands adapter lives under domains/proxy; test the shared
// error-mapping primitive here since adapter commands hit the network/IPC
// and are exercised at the integration level.

describe("toAppError", () => {
  it("passes through an already-shaped AppError", () => {
    const err = {
      code: "proxy_already_running",
      message: "已经在运行",
      retryable: false,
    };
    expect(toAppError(err)).toEqual(err);
  });

  it("wraps an Error with its message and defaults the code", () => {
    const out = toAppError(new Error("boom"));
    expect(out.message).toBe("boom");
    expect(out.code).toBe("unknown");
    expect(out.retryable).toBe(true);
  });

  it("treats InvokeError timeouts as retryable and others as non-retryable", () => {
    const timeout = toAppError(new InvokeError("proxy_status", "invoke timeout: proxy_status", true));
    expect(timeout.retryable).toBe(true);
    expect(timeout.code).toBe("unknown");
    expect(timeout.detail).toBe("proxy_status");

    const fatal = toAppError(new InvokeError("start_proxy", "监听地址无效", false));
    expect(fatal.retryable).toBe(false);
  });

  it("uses the provided fallback code when input is not an Error", () => {
    const out = toAppError("raw-string", "proxy_start_failed");
    expect(out.code).toBe("proxy_start_failed");
    expect(out.message).toBe("raw-string");
  });

vi.clearAllMocks();
});
