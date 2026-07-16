import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

export const windowCommands = {
  startDragging: (): Promise<void> => appWindow.startDragging(),
  minimize: (): Promise<void> => appWindow.minimize(),
  close: (): Promise<void> => appWindow.close(),
};
