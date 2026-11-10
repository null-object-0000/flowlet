// 桌面运行模式配置的读写（Electron 侧）。
//
// 磁盘位置：`<userData>/desktop-config.json`（不依赖 SQLite，客户端模式没有本地库）。
// 管理凭据：token 用 Electron `safeStorage` 加密后写 `tokenEnc`；若当前平台没有可用的
// 加密后端（Linux 无 Secret Service），退化为 `plain:` 前缀并告警——绝不静默以明文
// 冒充密文。OIDC 会话不落这个文件，持久化在 Electron 的远端会话分区里。
import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_DESKTOP_CONFIG,
  parseDesktopConfig,
  serializeDesktopConfig,
  type DesktopConfig,
} from "./client/config.ts";

interface StoredFile {
  version?: unknown;
  mode?: unknown;
  client?: {
    baseUrl?: unknown;
    auth?: { kind?: unknown };
    tokenEnc?: unknown;
  };
}

export interface StoredDesktopConfig {
  readonly config: DesktopConfig;
  /** 解密后的管理 token；未配置/解密失败为 null。 */
  readonly token: string | null;
  /** token 是否可用（`plain:` 降级也会返回 true，但会记录告警）。 */
  readonly tokenDecryptable: boolean;
}

export function desktopConfigPath(): string {
  return join(app.getPath("userData"), "desktop-config.json");
}

export function readStoredDesktopConfig(): StoredDesktopConfig {
  const file = desktopConfigPath();
  if (!existsSync(file)) {
    return { config: { ...DEFAULT_DESKTOP_CONFIG }, token: null, tokenDecryptable: true };
  }
  let raw: StoredFile;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as StoredFile;
  } catch {
    return { config: { ...DEFAULT_DESKTOP_CONFIG }, token: null, tokenDecryptable: true };
  }
  const config = parseDesktopConfig(raw);
  const tokenEnc = typeof raw.client?.tokenEnc === "string" ? raw.client.tokenEnc : null;
  if (tokenEnc === null) return { config, token: null, tokenDecryptable: true };
  if (tokenEnc.startsWith("plain:")) {
    return { config, token: Buffer.from(tokenEnc.slice("plain:".length), "base64").toString("utf8"), tokenDecryptable: false };
  }
  try {
    const token = safeStorage.decryptString(Buffer.from(tokenEnc.replace(/^safe:/, ""), "base64"));
    return { config, token, tokenDecryptable: true };
  } catch {
    // 密钥环变更/换机器后无法解密：视为未配置，让用户重新填。
    return { config, token: null, tokenDecryptable: false };
  }
}

export function writeStoredDesktopConfig(config: DesktopConfig, token: string | null): void {
  const file = desktopConfigPath();
  mkdirSync(dirname(file), { recursive: true });
  let tokenEnc: string | null = null;
  if (token !== null && token !== "") {
    if (safeStorage.isEncryptionAvailable()) {
      tokenEnc = `safe:${safeStorage.encryptString(token).toString("base64")}`;
    } else {
      // 无加密后端（部分 Linux）：只能降级；调用方负责告警。
      tokenEnc = `plain:${Buffer.from(token, "utf8").toString("base64")}`;
    }
  }
  const text = serializeDesktopConfig(config, tokenEnc);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, text, "utf8");
  renameSync(temporary, file);
}

export function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}
