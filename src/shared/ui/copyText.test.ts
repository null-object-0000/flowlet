import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copyText";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setClipboard(value: Clipboard | undefined) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "clipboard");
  Reflect.deleteProperty(document as unknown as Record<string, unknown>, "execCommand");
});

describe("copyText", () => {
  it("uses the Clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText } as unknown as Clipboard);
    await copyText("flowlet pull --server=https://example.test");
    expect(writeText).toHaveBeenCalledWith("flowlet pull --server=https://example.test");
  });

  it("falls back to execCommand on insecure HTTP deployments without navigator.clipboard", async () => {
    setClipboard(undefined);
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    await copyText("DOCKHAND_NA_TOKEN");
    expect(execCommand).toHaveBeenCalledWith("copy");
    // 临时 textarea 必须被清理，不能留在 DOM 里。
    expect(document.querySelectorAll("textarea").length).toBe(0);
  });

  it("falls back when the Clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    setClipboard({ writeText } as unknown as Clipboard);
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    await copyText("fallback");
    expect(writeText).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("rejects when neither clipboard path works", async () => {
    setClipboard(undefined);
    const execCommand = vi.fn().mockReturnValue(false);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    await expect(copyText("nope")).rejects.toThrow("Copy unavailable");
  });
});