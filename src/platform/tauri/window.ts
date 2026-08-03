import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

export const windowCommands = {
  startDragging: (): Promise<void> => appWindow.startDragging(),
  minimize: (): Promise<void> => appWindow.minimize(),
  isMaximized: (): Promise<boolean> => appWindow.isMaximized(),
  onResized: (handler: () => void): Promise<() => void> => appWindow.onResized(handler),
  toggleMaximize: (): Promise<void> => appWindow.toggleMaximize(),
  close: (): Promise<void> => appWindow.close(),
};
