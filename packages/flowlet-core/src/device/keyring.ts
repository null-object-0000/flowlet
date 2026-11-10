// OS 凭据库访问（S3 Secret Access Key / 设备工作区密钥）。Owner: desktop-device。
//
// 平台能力只走宿主桥：`ctx.desktop.host.invoke("keyring.get|set|delete", { service, username })`。
// 绝不允许把 Secret 写入 SQLite / app_meta / 明文文件。Rust 使用 `keyring` crate，
// service 固定为 "Flowlet Device Sync"（src-tauri/src/core/device_sync.rs::KEYRING_SERVICE），
// Node 端沿用同一个 service + credential username，因此旧版 Rust 写下的凭据可以被直接读取。
import type { DesktopHostBridge } from "../desktop/types.ts";

export const KEYRING_SERVICE = "Flowlet Device Sync";

interface KeyringGetResult {
  secret?: string | null;
}

async function invokeKeyring<T>(
  host: DesktopHostBridge,
  channel: string,
  payload: { service: string; username: string; secret?: string },
): Promise<T> {
  return host.invoke<T>(channel, payload);
}

/** Rust `read_secret`：任何读取失败（含凭据不存在）都映射为同一句可操作提示。 */
export async function readSecret(
  host: DesktopHostBridge,
  username: string,
): Promise<string> {
  let result: KeyringGetResult;
  try {
    result = await invokeKeyring<KeyringGetResult>(host, "keyring.get", {
      service: KEYRING_SERVICE,
      username,
    });
  } catch {
    throw new Error("未找到 S3 Secret Access Key，请重新填写并保存");
  }
  const secret = typeof result?.secret === "string" ? result.secret : null;
  if (secret === null || secret === "") {
    throw new Error("未找到 S3 Secret Access Key，请重新填写并保存");
  }
  return secret;
}

/** Rust `has_secret`：只探测是否存在，不把错误暴露给设置页。 */
export async function hasSecret(host: DesktopHostBridge, username: string): Promise<boolean> {
  try {
    const result = await invokeKeyring<KeyringGetResult>(host, "keyring.get", {
      service: KEYRING_SERVICE,
      username,
    });
    return typeof result?.secret === "string" && result.secret !== "";
  } catch {
    return false;
  }
}

/** Rust `credential_entry(...).set_password` 的错误归一。 */
export async function writeSecret(
  host: DesktopHostBridge,
  username: string,
  secret: string,
): Promise<void> {
  try {
    await invokeKeyring<unknown>(host, "keyring.set", {
      service: KEYRING_SERVICE,
      username,
      secret,
    });
  } catch {
    throw new Error("保存 S3 Secret Access Key 到系统凭据库失败");
  }
}

/** 尽力删除旧凭据；失败不阻断保存流程（Rust `let _ = entry.delete_credential()`）。 */
export async function deleteSecret(
  host: DesktopHostBridge,
  username: string,
): Promise<void> {
  try {
    await invokeKeyring<unknown>(host, "keyring.delete", {
      service: KEYRING_SERVICE,
      username,
    });
  } catch {
    /* 旧凭据清理失败不影响新配置保存 */
  }
}