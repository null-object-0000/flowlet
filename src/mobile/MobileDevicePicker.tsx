import { IconChevronDown } from "@douyinfe/semi-icons";
import { Button, Dropdown } from "@douyinfe/semi-ui-19";
import { useEffect } from "react";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import { useMobileDevices } from "../features/device-sync/useMobileDeviceSync";
import { useMobileDeviceSelection } from "./MobileDeviceSelection";
import styles from "./MobileDevicePicker.module.css";

export function useMobileDevicePickerState({ allowAll = true }: { allowAll?: boolean } = {}) {
  const devices = useMobileDevices();
  const { deviceId, setDeviceId } = useMobileDeviceSelection();
  const selectedDevice = devices.data?.find((device) => device.deviceId === deviceId) ?? null;
  const effectiveDeviceId = allowAll
    ? deviceId
    : (selectedDevice?.deviceId ?? devices.data?.[0]?.deviceId ?? null);

  useEffect(() => {
    if (!devices.data || selectedDevice) return;
    if (allowAll) {
      if (deviceId != null) setDeviceId(null);
    } else if (effectiveDeviceId != null && effectiveDeviceId !== deviceId) {
      setDeviceId(effectiveDeviceId);
    }
  }, [allowAll, deviceId, devices.data, effectiveDeviceId, selectedDevice, setDeviceId]);

  return {
    devices: devices.data ?? [],
    deviceId,
    effectiveDeviceId,
    selectedDevice,
    setDeviceId,
  };
}

export type MobileDevicePickerState = ReturnType<typeof useMobileDevicePickerState>;

/** 紧凑按钮形态（其他页面共用）。 */
export function MobileDevicePicker() {
  const { t } = useAppPreferences();
  const { devices, deviceId, selectedDevice, setDeviceId } = useMobileDevicePickerState();
  const selectedName = selectedDevice?.displayName ?? t("全部设备");

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
          {devices.map((device) => (
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

/** 标题形态：标题本身作为设备切换器；allowAll=true 时保留「全部设备」选项。 */
export function MobileDeviceTitlePicker({
  state,
  formatTitle,
  allowAll = false,
}: {
  state: MobileDevicePickerState;
  /** 由页面决定标题文案：指定设备收到设备名，全部设备（仅 allowAll）收到 null。 */
  formatTitle: (deviceName: string | null) => string;
  allowAll?: boolean;
}) {
  const { t } = useAppPreferences();
  const deviceName = state.selectedDevice?.displayName ?? null;
  const ariaName = deviceName ?? (allowAll ? t("全部设备") : "…");

  return (
    <Dropdown
      position="bottomLeft"
      trigger="click"
      clickToHide
      render={(
        <Dropdown.Menu>
          {allowAll ? (
            <Dropdown.Item active={state.deviceId == null} onClick={() => state.setDeviceId(null)}>
              {t("全部设备")}
            </Dropdown.Item>
          ) : null}
          {state.devices.map((device) => (
            <Dropdown.Item
              active={device.deviceId === state.deviceId}
              key={device.deviceId}
              onClick={() => state.setDeviceId(device.deviceId)}
            >
              {device.displayName}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      )}
    >
      <button
        type="button"
        className={styles.titleTrigger}
        aria-label={t("切换设备，当前：{name}", { name: ariaName })}
      >
        <span>{formatTitle(deviceName)}</span>
        <IconChevronDown />
      </button>
    </Dropdown>
  );
}
