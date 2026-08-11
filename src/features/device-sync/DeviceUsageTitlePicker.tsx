import { DesktopDeviceTitlePickerView } from "@flowlet/product-ui";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

type DeviceOption = {
  deviceId: string;
  displayName: string;
};

export function DeviceUsageTitlePicker({ devices, deviceId, title, onChange }: {
  devices: DeviceOption[];
  deviceId: string | null;
  title: string;
  onChange: (deviceId: string | null) => void;
}) {
  const { t } = useAppPreferences();
  const selectedDevice = devices.find((device) => device.deviceId === deviceId) ?? null;
  const selectedName = selectedDevice?.displayName ?? t("全部设备");
  const localizedTitle = t(title);

  return <DesktopDeviceTitlePickerView title={localizedTitle} selectedValue={deviceId} selectedLabel={selectedDevice?.displayName} allLabel={t("全部设备")} options={devices.map((device) => ({ value: device.deviceId, label: device.displayName }))} ariaLabel={t("切换设备，当前：{name}", { name: selectedName })} onChange={onChange} />;
}
