import { Toast } from "@douyinfe/semi-ui-19";
import { useState } from "react";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import {
  useMobileDeviceRefresh,
  useMobileDevices,
  useMobileDeviceSyncActions,
  useMobileS3Settings,
} from "../features/device-sync/useMobileDeviceSync";
import { errorMessage } from "../shared/errors/AppError";

export type MobileRefreshController = {
  refresh: () => Promise<void>;
  loading: boolean;
  disabled: boolean;
  lastSuccessAt: string | null;
};

export function useMobileRefreshController(deviceId?: string | null): MobileRefreshController {
  const { t } = useAppPreferences();
  const settings = useMobileS3Settings();
  const devices = useMobileDevices();
  const actions = useMobileDeviceSyncActions();
  const deviceRefresh = useMobileDeviceRefresh(deviceId ?? null);
  const scoped = deviceId !== undefined;
  const scopeKey = scoped ? `device:${deviceId ?? "none"}` : "all";
  const [completedRefresh, setCompletedRefresh] = useState<{ scopeKey: string; at: string } | null>(null);
  const sourceLastSuccessAt = scoped
    ? devices.data?.find((device) => device.deviceId === deviceId)?.lastSeenAt ?? null
    : settings.data?.status.lastSuccessAt ?? null;

  const refresh = async () => {
    try {
      if (scoped) {
        const result = await deviceRefresh.mutateAsync();
        Toast.success(result.source === "lan" ? t("已通过局域网直连刷新") : t("已从 S3 刷新当前设备"));
      } else {
        await actions.refreshS3.mutateAsync();
      }
      setCompletedRefresh({ scopeKey, at: new Date().toISOString() });
    } catch (error) {
      Toast.error(t("刷新失败：{message}", { message: errorMessage(error) }));
    }
  };

  return {
    refresh,
    loading: scoped ? deviceRefresh.isPending : actions.refreshS3.isPending,
    disabled: scoped ? !deviceId : !settings.data?.config,
    lastSuccessAt: completedRefresh?.scopeKey === scopeKey
      ? completedRefresh.at
      : sourceLastSuccessAt,
  };
}
