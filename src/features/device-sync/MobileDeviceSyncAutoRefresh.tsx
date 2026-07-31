import { useMobileDeviceSyncBackground } from "./useMobileDeviceSync";

/**
 * 挂载一次后台同步事件监听，不渲染任何内容。
 * 在 MobileShell 中挂载，确保所有页面共享同一份监听。
 */
export function MobileDeviceSyncAutoRefresh() {
  useMobileDeviceSyncBackground();
  return null;
}
