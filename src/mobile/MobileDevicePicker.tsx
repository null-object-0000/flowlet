import { IconChevronDown } from "@douyinfe/semi-icons";
import { Button, Dropdown } from "@douyinfe/semi-ui-19";
import { useEffect } from "react";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import { useMobileDevices } from "../features/device-sync/useMobileDeviceSync";
import { useMobileDeviceSelection } from "./MobileDeviceSelection";
import styles from "./MobileDevicePicker.module.css";

export function MobileDevicePicker() {
  const { t } = useAppPreferences();
  const devices = useMobileDevices();
  const { deviceId, setDeviceId } = useMobileDeviceSelection();
  const selectedDevice = devices.data?.find((device) => device.deviceId === deviceId) ?? null;
  const selectedName = selectedDevice?.displayName ?? t("全部设备");

  useEffect(() => {
    if (deviceId && devices.data && !selectedDevice) setDeviceId(null);
  }, [deviceId, devices.data, selectedDevice, setDeviceId]);

  return (
    <Dropdown
      position="bottomRight"
      trigger="click"
      clickToHide
      render={(
        <Dropdown.Menu>
          <Dropdown.Item active={deviceId == null} onClick={() => setDeviceId(null)}>
            {t("全部设备")}
          </Dropdown.Item>
          {(devices.data ?? []).map((device) => (
            <Dropdown.Item
              active={device.deviceId === deviceId}
              key={device.deviceId}
              onClick={() => setDeviceId(device.deviceId)}
            >
              {device.displayName}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      )}
    >
      <Button
        className={styles.trigger}
        theme="borderless"
        size="small"
        aria-label={t("切换设备，当前：{name}", { name: selectedName })}
      >
        <span>{selectedName}</span>
        <IconChevronDown />
      </Button>
    </Dropdown>
  );
}
