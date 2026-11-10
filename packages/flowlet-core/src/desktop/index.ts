// 桌面命令层公开入口。Owner: lead。
export { dispatchDesktop, hasDesktopCommand, desktopCommandNames } from "./commands.ts";
export type {
  DesktopContext,
  DesktopHandler,
  DesktopHandlerMap,
  DesktopHostBridge,
  DesktopRuntime,
} from "./types.ts";