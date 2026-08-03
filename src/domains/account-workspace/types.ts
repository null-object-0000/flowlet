import type { S3SyncConfigInput } from "../device-sync/types";

export type AccountWorkspaceStatus = {
  enabled: boolean;
  linkedAccounts: number;
};

export type AccountWorkspaceSyncResult = {
  revision: number;
  accountCount: number;
  linkedAccounts: number;
  createdLocalAccounts: number;
  uploaded: boolean;
};

export type DesktopAccountWorkspacePackage = {
  format: "flowlet-desktop-account-workspace";
  version: number;
  s3: S3SyncConfigInput;
  accountWorkspaceKey: string;
};
