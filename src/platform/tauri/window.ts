import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

/** `@tauri-apps/api` 未导出 ResizeDirection 类型，这里保持与其内部定义一致。 */
export type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

export const windowCommands = {
  startDragging: (): Promise<void> => appWindow.startDragging(),
  startResizeDragging: (direction: ResizeDirection): Promise<void> => appWindow.startResizeDragging(direction),
  minimize: (): Promise<void> => appWindow.minimize(),
  isMaximized: (): Promise<boolean> => appWindow.isMaximized(),
  onResized: (handler: () => void): Promise<() => void> => appWindow.onResized(handler),
  toggleMaximize: (): Promise<void> => appWindow.toggleMaximize(),
  close: (): Promise<void> => appWindow.close(),
};
