import { useParams } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useMobileDevices } from "../../features/device-sync/useMobileDeviceSync";
import { useMobileRefreshController } from "../useMobileRefreshController";
import { MobileAgentList } from "../MobileAgentList";
import { MobileSubpageShell } from "../MobileSubpageShell";

/** 设备二级页：指定设备的已安装 Agent 列表，无底部 Tab，返回回到设备页。 */
export function MobileDeviceAgentsPage() {
  const { deviceId = "" } = useParams();
  const { t } = useAppPreferences();
  const devices = useMobileDevices();
  const deviceName = devices.data?.find((item) => item.deviceId === deviceId)?.displayName;
  const refreshController = useMobileRefreshController(deviceId);

  return (
    <MobileSubpageShell
      title={deviceName ? `${deviceName} ${t("Agent")}` : t("Agent")}
      description={t("该设备已安装的 Agent 及其 Flowlet 接入状态")}
      refreshController={refreshController}
    >
      <MobileAgentList deviceId={deviceId} />
    </MobileSubpageShell>
  );
}