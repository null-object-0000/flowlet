// 安装实例身份（flowlet-device.json）读写。Owner: desktop-device。
//
// 权威实现：src-tauri/src/core/device_identity.rs（DeviceIdentity::update_display_name /
// validate_display_name / load_or_create）。该文件必须留在 SQLite 之外，且格式与 Rust
// 完全一致（camelCase）：{ schemaVersion, deviceId, createdAt, displayName, platform }。
// 注意：不做 app_version 写回（Rust 反序列化结构里没有该字段，写回去会被忽略但会污染文件）。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { charCount, hasControlChars, isUuid } from "./bundle.ts";

export const DEVICE_IDENTITY_FILE = "flowlet-device.json";
export const DEVICE_IDENTITY_SCHEMA_VERSION = 1;

/** 与 Rust `DeviceIdentity` 对齐的进程内结构（snake_case）。 */
export interface DeviceIdentityRecord {
  schema_version: number;
  device_id: string;
  created_at: string;
  display_name: string;
  platform: string;
}

interface SerializedDeviceIdentity {
  schemaVersion: number;
  deviceId: string;
  createdAt: string;
  displayName: string;
  platform: string;
}

/** Rust `validate_display_name`，错误文案保留 `设备名称无效: ` 前缀。 */
export function validateDisplayName(displayName: string): void {
  const count = charCount(displayName);
  if (count === 0) throw new Error("设备名称无效: 名称不能为空");
  if (count > 64) throw new Error("设备名称无效: 名称不能超过 64 个字符");
  if (hasControlChars(displayName)) throw new Error("设备名称无效: 名称不能包含控制字符");
}

/** 读取并校验身份文件；文件缺失/格式不对时返回 null（调用方决定是否重建）。 */
export function readDeviceIdentityFile(dataDir: string): DeviceIdentityRecord | null {
  const file = path.join(dataDir, DEVICE_IDENTITY_FILE);
  let raw: Partial<SerializedDeviceIdentity>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Partial<SerializedDeviceIdentity>;
  } catch {
    return null;
  }
  if (raw.schemaVersion !== DEVICE_IDENTITY_SCHEMA_VERSION) return null;
  const deviceId = String(raw.deviceId ?? "");
  if (!isUuid(deviceId)) return null;
  return {
    schema_version: DEVICE_IDENTITY_SCHEMA_VERSION,
    device_id: deviceId,
    created_at: String(raw.createdAt ?? ""),
    display_name: String(raw.displayName ?? ""),
    platform: String(raw.platform ?? ""),
  };
}

/**
 * Rust `DeviceIdentity::update_display_name`：临时文件 + 备份 + rename 的原子替换。
 * 只更新 displayName，device_id / createdAt 保持不变。
 */
export function updateDisplayName(
  dataDir: string,
  identity: DeviceIdentityRecord,
  displayName: string,
): void {
  const trimmed = displayName.trim();
  validateDisplayName(trimmed);

  mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, DEVICE_IDENTITY_FILE);
  const temporary = path.join(dataDir, `.flowlet-device-${randomUUID().replace(/-/g, "")}.tmp`);
  const backup = path.join(dataDir, `.flowlet-device-${randomUUID().replace(/-/g, "")}.backup`);
  const updated: DeviceIdentityRecord = { ...identity, display_name: trimmed };
  const serialized: SerializedDeviceIdentity = {
    schemaVersion: updated.schema_version,
    deviceId: updated.device_id,
    createdAt: updated.created_at,
    displayName: updated.display_name,
    platform: updated.platform,
  };
  writeFileSync(temporary, `${JSON.stringify(serialized, null, 2)}\n`, { flag: "wx" });

  let targetExists = false;
  try {
    readFileSync(target, "utf8");
    targetExists = true;
  } catch {
    targetExists = false;
  }
  if (targetExists) {
    renameSync(target, backup);
  }
  try {
    renameSync(temporary, target);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
      if (targetExists) renameSync(backup, target);
    } catch {
      /* 恢复失败时保留 backup，交给用户人工处理 */
    }
    throw error;
  }
  try {
    rmSync(backup, { force: true });
  } catch {
    /* 备份清理失败不影响重命名结果 */
  }
  identity.display_name = trimmed;
}

/** Rust `resolve_device_display_name`（空白时按平台 + 设备 ID 后缀生成）。 */
export function defaultDisplayNameFallback(
  resolveDisplayName: (displayName: string, platform: string, deviceId: string) => string,
  identity: DeviceIdentityRecord,
): string {
  return resolveDisplayName("", identity.platform, identity.device_id);
}