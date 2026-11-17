import { DesktopBridgeUnavailableError, getDesktopBridge, type DesktopDialogOptions } from "../desktop/bridge";

function dialogBridge() {
  const bridge = getDesktopBridge();
  if (bridge?.mode === "client") {
    throw new DesktopBridgeUnavailableError("客户端模式不提供本机文件对话框");
  }
  if (!bridge?.dialog) throw new DesktopBridgeUnavailableError("window.flowletDesktop.dialog 未注入");
  return bridge.dialog;
}

/** File paths are only available to the local desktop Host, never Web/client mode. */
export async function open(options: DesktopDialogOptions = {}): Promise<string | string[] | null> {
  return dialogBridge().open(options);
}

export async function save(options: DesktopDialogOptions = {}): Promise<string | null> {
  return dialogBridge().save(options);
}
