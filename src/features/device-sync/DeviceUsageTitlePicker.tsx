import { DesktopDeviceTitlePickerView } from "@flowlet/product-ui";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

type DeviceOption = {
  deviceId: string;
  displayName: string;
  isCurrent?: boolean;
};

/** 页面主标题上的设备切换器。`allowAll = false` 时不允许“全部设备”，
 *  必须选中一台具体设备（`deviceId` 为 null 时回退到当前设备/首台设备）。 */
export function DeviceUsageTitlePicker({ devices, deviceId, title, onChange, allowAll = true }: {
  devices: DeviceOption[];
  deviceId: string | null;
  title: string;
  onChange: (deviceId: string | null) => void;
  allowAll?: boolean;
}) {
  const { t } = useAppPreferences();
  const effectiveDeviceId = deviceId
    ?? (allowAll ? null : (devices.find((device) => device.isCurrent)?.deviceId ?? devices[0]?.deviceId ?? null));
  const selectedDevice = devices.find((device) => device.deviceId === effectiveDeviceId) ?? null;
  const selectedName = selectedDevice?.displayName ?? t("全部设备");
  const localizedTitle = t(title);

  return <DesktopDeviceTitlePickerView title={localizedTitle} selectedValue={effectiveDeviceId} selectedLabel={selectedDevice?.displayName} allLabel={t("全部设备")} options={devices.map((device) => ({ value: device.deviceId, label: device.displayName }))} ariaLabel={t("切换设备，当前：{name}", { name: selectedName })} onChange={onChange} allowAll={allowAll} />;
}
