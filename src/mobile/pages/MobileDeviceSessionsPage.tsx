import { useState } from "react";
import { useParams } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useMobileDevices } from "../../features/device-sync/useMobileDeviceSync";
import { useMobileRefreshController } from "../useMobileRefreshController";
import { MobileSessionList } from "../MobileSessionList";
import { MobileSubpageShell } from "../MobileSubpageShell";

/** 设备二级页：指定设备的会话列表，无底部 Tab，返回回到设备页。 */
export function MobileDeviceSessionsPage() {
  const { deviceId = "" } = useParams();
  const { t } = useAppPreferences();
  const devices = useMobileDevices();
  const deviceName = devices.data?.find((item) => item.deviceId === deviceId)?.displayName;
  const refreshController = useMobileRefreshController(deviceId);
  const [refreshDisabled, setRefreshDisabled] = useState(false);

  return (
    <MobileSubpageShell
      title={deviceName ? `${deviceName} ${t("会话")}` : t("会话")}
      description={t("查看该设备同步的最近会话与实时运行状态")}
      refreshController={refreshController}
      refreshDisabled={refreshDisabled}
    >
      <MobileSessionList deviceId={deviceId} onRefreshDisabledChange={setRefreshDisabled} />
    </MobileSubpageShell>
  );
}