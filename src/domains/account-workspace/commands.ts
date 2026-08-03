import { invokeCommand } from "../../platform/tauri/client";
import type {
  AccountWorkspaceStatus,
  AccountWorkspaceSyncResult,
  DesktopAccountWorkspacePackage,
} from "./types";

export const accountWorkspaceCommands = {
  status: () => invokeCommand<AccountWorkspaceStatus>("get_account_workspace_status"),
  initialize: () => invokeCommand<AccountWorkspaceSyncResult>("initialize_account_workspace", undefined, Number.POSITIVE_INFINITY),
  sync: () => invokeCommand<AccountWorkspaceSyncResult>("sync_account_workspace", undefined, Number.POSITIVE_INFINITY),
  exportDesktopPackage: () => invokeCommand<DesktopAccountWorkspacePackage>("export_desktop_account_workspace"),
  importDesktopPackage: (accountPackage: DesktopAccountWorkspacePackage) =>
    invokeCommand<AccountWorkspaceSyncResult>("import_desktop_account_workspace", { package: accountPackage }, Number.POSITIVE_INFINITY),
};
