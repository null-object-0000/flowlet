import { IconChevronDown } from "@douyinfe/semi-icons";
import { Dropdown } from "@douyinfe/semi-ui-19";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import styles from "./DeviceUsageTitlePicker.module.css";

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

  return (
    <Dropdown
      position="bottomLeft"
      trigger="click"
      clickToHide
      render={(
        <Dropdown.Menu>
          <Dropdown.Item active={deviceId == null} onClick={() => onChange(null)}>
            {t("全部设备")}
          </Dropdown.Item>
          {devices.map((device) => (
            <Dropdown.Item
              key={device.deviceId}
              active={device.deviceId === deviceId}
              onClick={() => onChange(device.deviceId)}
            >
              {device.displayName}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      )}
    >
      <button
        type="button"
        className={styles.trigger}
        aria-label={t("切换设备，当前：{name}", { name: selectedName })}
      >
        <span>{selectedDevice ? `${selectedDevice.displayName} · ${localizedTitle}` : localizedTitle}</span>
        <IconChevronDown />
      </button>
    </Dropdown>
  );
}
