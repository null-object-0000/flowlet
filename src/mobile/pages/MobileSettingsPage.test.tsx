import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scannerMocks = vi.hoisted(() => ({
  backHandler: null as (() => void) | null,
  cancel: vi.fn<() => Promise<void>>(),
  scan: vi.fn<() => Promise<{ content: string }>>(),
  unregister: vi.fn<() => Promise<void>>(),
}));

const syncMocks = vi.hoisted(() => ({
  refreshS3: vi.fn<() => Promise<void>>(),
  saveS3Config: vi.fn<() => Promise<void>>(),
  testS3Connection: vi.fn<() => Promise<{ message: string }>>(),
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
    saveS3Config: { isPending: false, mutateAsync: syncMocks.saveS3Config },
    testS3Connection: { isPending: false, mutateAsync: syncMocks.testS3Connection },
    refreshS3: { isPending: false, mutateAsync: syncMocks.refreshS3 },
  }),
}));

vi.mock("../../shared/ui/FlowletLogo", () => ({
  FlowletLogo: () => <div data-testid="flowlet-logo" />,
}));

import { MobileSettingsPage } from "./MobileSettingsPage";

const connectionPackage = JSON.stringify({
  type: "flowlet.s3-connection",
  version: 1,
  config: {
    endpoint: "https://s3.example.com",
    region: "auto",
    bucket: "flowlet-sync",
    prefix: "users/me",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    pathStyle: false,
  },
});

describe("MobileSettingsPage scanner", () => {
  beforeEach(() => {
    vi.stubEnv("TAURI_ENV_PLATFORM", "android");
    scannerMocks.backHandler = null;
    scannerMocks.cancel.mockReset().mockImplementation(() => new Promise<void>(() => undefined));
    scannerMocks.scan.mockReset().mockImplementation(() => new Promise<never>(() => undefined));
    scannerMocks.unregister.mockReset().mockResolvedValue(undefined);
    syncMocks.refreshS3.mockReset().mockResolvedValue(undefined);
    syncMocks.saveS3Config.mockReset().mockResolvedValue(undefined);
    syncMocks.testS3Connection.mockReset().mockResolvedValue({ message: "连接成功" });
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

  it("does not focus the connection text input after scanning", async () => {
    scannerMocks.scan.mockResolvedValueOnce({ content: connectionPackage });
    render(<MobileSettingsPage />);

    fireEvent.click(screen.getByRole("button", { name: "扫描二维码" }));

    const input = await screen.findByPlaceholderText("粘贴 Flowlet S3 连接包 JSON");
    expect(input).not.toHaveFocus();
    expect(screen.getByText("flowlet-sync")).toBeInTheDocument();
  });

  it("refreshes remote data immediately after testing and saving a connection", async () => {
    render(<MobileSettingsPage />);

    fireEvent.click(screen.getByRole("button", { name: "粘贴连接文本" }));
    const input = await screen.findByPlaceholderText("粘贴 Flowlet S3 连接包 JSON");
    fireEvent.change(input, { target: { value: connectionPackage } });
    fireEvent.click(screen.getByRole("button", { name: "测试并保存" }));

    await waitFor(() => expect(syncMocks.refreshS3).toHaveBeenCalledOnce());
    expect(syncMocks.testS3Connection).toHaveBeenCalledOnce();
    expect(syncMocks.saveS3Config).toHaveBeenCalledOnce();
    expect(syncMocks.saveS3Config.mock.invocationCallOrder[0])
      .toBeLessThan(syncMocks.refreshS3.mock.invocationCallOrder[0]);
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
      failureDetails: ["设备 device-1：不支持的设备用量快照版本：5"],
    };

    render(<MobileSettingsPage />);

    expect(screen.getByText("失败详情")).toBeInTheDocument();
    expect(screen.getByText("设备 device-1：不支持的设备用量快照版本：5")).toBeInTheDocument();
  });
});
