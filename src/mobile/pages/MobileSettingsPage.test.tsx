import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scannerMocks = vi.hoisted(() => ({
  backHandler: null as (() => void) | null,
  cancel: vi.fn<() => Promise<void>>(),
  scan: vi.fn<() => Promise<never>>(),
  unregister: vi.fn<() => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  onBackButtonPress: vi.fn(async (handler: () => void) => {
    scannerMocks.backHandler = handler;
    return { unregister: scannerMocks.unregister };
  }),
}));

vi.mock("@tauri-apps/plugin-barcode-scanner", () => ({
  Format: { QRCode: "QR_CODE" },
  cancel: scannerMocks.cancel,
  scan: scannerMocks.scan,
  checkPermissions: vi.fn().mockResolvedValue("granted"),
  requestPermissions: vi.fn().mockResolvedValue("granted"),
  openAppSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

vi.mock("../../features/device-sync/useMobileDeviceSync", () => ({
  useMobileS3Settings: () => ({
    data: { config: null },
  }),
  useMobileDeviceSyncActions: () => ({
    saveS3Config: { isPending: false, mutateAsync: vi.fn() },
    testS3Connection: { isPending: false, mutateAsync: vi.fn() },
    refreshS3: { isPending: false, mutateAsync: vi.fn() },
  }),
}));

vi.mock("../../shared/ui/FlowletLogo", () => ({
  FlowletLogo: () => <div data-testid="flowlet-logo" />,
}));

import { MobileSettingsPage } from "./MobileSettingsPage";

describe("MobileSettingsPage scanner", () => {
  beforeEach(() => {
    vi.stubEnv("TAURI_ENV_PLATFORM", "android");
    scannerMocks.backHandler = null;
    scannerMocks.cancel.mockReset().mockImplementation(() => new Promise<void>(() => undefined));
    scannerMocks.scan.mockReset().mockImplementation(() => new Promise<never>(() => undefined));
    scannerMocks.unregister.mockReset().mockResolvedValue(undefined);
    delete document.body.dataset.flowletScanning;
  });

  it("closes the scanner UI immediately even when native cancellation never settles", async () => {
    render(<MobileSettingsPage />);

    fireEvent.click(screen.getByRole("button", { name: "扫描二维码" }));
    const scanner = await screen.findByRole("dialog", { name: "扫描连接二维码" });
    await waitFor(() => expect(scannerMocks.scan).toHaveBeenCalledOnce());
    fireEvent.click(within(scanner).getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog", { name: "扫描连接二维码" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveAttribute("data-flowlet-scanning");
    expect(scannerMocks.cancel).toHaveBeenCalledOnce();
  });

  it("uses the same immediate exit path for the Android back gesture", async () => {
    render(<MobileSettingsPage />);

    fireEvent.click(screen.getByRole("button", { name: "扫描二维码" }));
    await screen.findByRole("dialog", { name: "扫描连接二维码" });
    await waitFor(() => expect(scannerMocks.backHandler).not.toBeNull());
    await waitFor(() => expect(scannerMocks.scan).toHaveBeenCalledOnce());

    act(() => scannerMocks.backHandler?.());

    expect(screen.queryByRole("dialog", { name: "扫描连接二维码" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveAttribute("data-flowlet-scanning");
    expect(scannerMocks.cancel).toHaveBeenCalledOnce();
  });
});
