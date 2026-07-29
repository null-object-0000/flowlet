import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scannerMocks = vi.hoisted(() => ({
  backHandler: null as (() => void) | null,
  cancel: vi.fn<() => Promise<void>>(),
  scan: vi.fn<() => Promise<never>>(),
  unregister: vi.fn<() => Promise<void>>(),
}));

const syncMocks = vi.hoisted(() => ({
  settings: {
    config: null,
    status: {
      status: "never",
      lastAttemptAt: null as string | null,
      lastSuccessAt: null as string | null,
      message: "尚未同步",
      remoteDevices: 0,
      importedDevices: 0,
      importedDays: 0,
      failedObjects: 0,
      failureDetails: [] as string[],
    },
  },
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
    data: syncMocks.settings,
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
    syncMocks.settings.status = {
      status: "never",
      lastAttemptAt: null,
      lastSuccessAt: null,
      message: "尚未同步",
      remoteDevices: 0,
      importedDevices: 0,
      importedDays: 0,
      failedObjects: 0,
      failureDetails: [],
    };
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

  it("shows the concrete object failure returned by the latest refresh", () => {
    syncMocks.settings.status = {
      status: "partial",
      lastAttemptAt: "2026-07-29T19:20:54Z",
      lastSuccessAt: "2026-07-29T19:20:54Z",
      message: "刷新完成：读取 2 台设备；1 个对象失败",
      remoteDevices: 2,
      importedDevices: 1,
      importedDays: 0,
      failedObjects: 1,
      failureDetails: ["设备 device-1：不支持的设备用量快照版本：3"],
    };

    render(<MobileSettingsPage />);

    expect(screen.getByText("失败详情")).toBeInTheDocument();
    expect(screen.getByText("设备 device-1：不支持的设备用量快照版本：3")).toBeInTheDocument();
  });
});
