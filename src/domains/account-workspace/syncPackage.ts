import { parseS3ConnectionPackage } from "../device-sync/s3ConnectionPackage";
import type { S3SyncConfigInput } from "../device-sync/types";
import type { DesktopAccountWorkspacePackage } from "./types";

export const DESKTOP_WORKSPACE_PACKAGE_FORMAT = "flowlet-desktop-account-workspace";
const DESKTOP_WORKSPACE_PACKAGE_VERSION = 1;

/** 「连接新设备」可导入的两类接入包：普通 S3 连接包，或其超集「账号工作区接入包」。 */
export type ParsedSyncPackage =
  | { kind: "connection"; config: S3SyncConfigInput }
  | { kind: "workspace"; package: DesktopAccountWorkspacePackage };

/**
 * 按格式嗅探解析接入包。账号工作区接入包内嵌完整 S3 连接配置，
 * 导入后由 Rust 端同时完成「配置 S3 同步 + 加入工作区」。
 */
export function parseSyncPackage(text: string): ParsedSyncPackage {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("连接文本不能为空");
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new Error("连接文本不是有效的 JSON");
  }
  if (isRecord(value) && value.format === DESKTOP_WORKSPACE_PACKAGE_FORMAT) {
    return { kind: "workspace", package: parseDesktopWorkspacePackage(value) };
  }
  return { kind: "connection", config: parseS3ConnectionPackage(trimmed) };
}

export function serializeDesktopWorkspacePackage(
  accountPackage: DesktopAccountWorkspacePackage,
  compact = false,
): string {
  return JSON.stringify(accountPackage, null, compact ? undefined : 2);
}

function parseDesktopWorkspacePackage(
  value: Record<string, unknown>,
): DesktopAccountWorkspacePackage {
  if (value.version !== DESKTOP_WORKSPACE_PACKAGE_VERSION) {
    throw new Error("不是受支持的 Flowlet 账号工作区接入包版本");
  }
  const s3 = value.s3;
  if (!isRecord(s3)) {
    throw new Error("账号工作区接入包缺少 S3 连接配置");
  }
  if (typeof s3.pathStyle !== "boolean") {
    throw new Error("账号工作区接入包中的 Path-style 配置无效");
  }
  return {
    format: DESKTOP_WORKSPACE_PACKAGE_FORMAT,
    version: DESKTOP_WORKSPACE_PACKAGE_VERSION,
    s3: {
      endpoint: workspaceRequiredString(s3.endpoint, "Endpoint"),
      region: workspaceRequiredString(s3.region, "Region"),
      bucket: workspaceRequiredString(s3.bucket, "Bucket"),
      prefix: typeof s3.prefix === "string" ? s3.prefix.trim() : "",
      accessKeyId: workspaceRequiredString(s3.accessKeyId, "Access Key ID"),
      secretAccessKey: workspaceRequiredString(s3.secretAccessKey, "Secret Access Key"),
      pathStyle: s3.pathStyle,
    },
    accountWorkspaceKey: workspaceRequiredString(value.accountWorkspaceKey, "工作区解密密钥"),
  };
}

function workspaceRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`账号工作区接入包缺少 ${label}`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
