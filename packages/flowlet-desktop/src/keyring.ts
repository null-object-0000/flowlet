// OS 凭据库：Electron `safeStorage` + 自管理密文文件；兼容读取 Rust keyring 旧条目。
//
// 迁移背景（docs/migration/platform-gap-matrix.md HG-4）：`safeStorage` 读不到
// `keyring` crate 写入的 Generic Password 条目，因此首次读取时按平台调用系统 CLI
// 读旧条目并重新加密写入新存储；迁移失败只告警，不阻塞调用方（下次重试）。
//
// Rust 旧条目（权威实现）：
// - Linux Secret Service：attributes `service` + `username`（zbus-secret-service-keyring-store）；
// - macOS Keychain：service + account（即 username）；
// - Windows Credential Manager：generic credential，target 兼容 `service.username` / `service`。
//
// 新存储：`<dataDir>/desktop-secrets.json`，值是用 safeStorage 加密后的 base64。
// 不落盘明文、不写日志明文。Linux 无 Secret Service 时 safeStorage 会退化为
// `basic_text`（弱加密），启动诊断里会显式标注。
import { safeStorage } from "electron";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { DesktopLogger } from "./logger.ts";

const execFileAsync = promisify(execFile);

interface SecretFile {
  version: 1;
  entries: Record<string, string>;
}

function entryKey(service: string, username: string): string {
  return `${service}\u0000${username}`;
}

function emptyFile(): SecretFile {
  return { version: 1, entries: {} };
}

export interface KeyringOptions {
  readonly dataDir: string;
  readonly logger: DesktopLogger;
}

export class DesktopKeyring {
  private readonly file: string;
  private readonly logger: DesktopLogger;
  private cache: SecretFile | null = null;

  constructor(options: KeyringOptions) {
    this.file = join(options.dataDir, "desktop-secrets.json");
    this.logger = options.logger;
    mkdirSync(dirname(this.file), { recursive: true });
  }

  storageBackend(): string {
    try {
      return safeStorage.getSelectedStorageBackend();
    } catch {
      return "unknown";
    }
  }

  isEncryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async get(service: string, username: string): Promise<string | null> {
    this.assertArguments(service, username);
    const stored = await this.getNew(service, username);
    if (stored !== null) return stored;
    const legacy = await this.readLegacy(service, username);
    if (legacy === null) return null;
    // 迁移失败只告警：旧条目仍然可用，下次读取会重试。
    try {
      await this.setNew(service, username, legacy);
      this.logger.info("已把旧 keyring 条目迁移到 safeStorage 密文存储", { service });
    } catch (error) {
      this.logger.warn("旧 keyring 条目迁移失败（不阻塞读取）", {
        service,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return legacy;
  }

  async set(service: string, username: string, secret: string): Promise<void> {
    this.assertArguments(service, username);
    if (typeof secret !== "string" || secret === "") {
      throw new Error("凭据内容不能为空");
    }
    await this.setNew(service, username, secret);
  }

  async delete(service: string, username: string): Promise<void> {
    this.assertArguments(service, username);
    const file = this.loadFile();
    const key = entryKey(service, username);
    if (file.entries[key] !== undefined) {
      delete file.entries[key];
      this.saveFile(file);
    }
    // 同步删除旧条目，避免下次 get 时又从 keyring 复活。失败只告警。
    await this.deleteLegacy(service, username).catch((error: unknown) => {
      this.logger.warn("删除旧 keyring 条目失败", {
        service,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private assertArguments(service: string, username: string): void {
    if (typeof service !== "string" || service.trim() === "") throw new Error("凭据 service 不能为空");
    if (typeof username !== "string" || username.trim() === "") throw new Error("凭据 username 不能为空");
  }

  private async getNew(service: string, username: string): Promise<string | null> {
    const encoded = this.loadFile().entries[entryKey(service, username)];
    if (encoded === undefined) return null;
    let plain: string;
    try {
      plain = await decrypt(Buffer.from(encoded, "base64"));
    } catch (error) {
      // 密文损坏或系统密钥变化：明确抛错而不是当作“没有凭据”静默失效。
      throw new Error(
        `读取凭据失败（safeStorage 无法解密 ${service}/${username}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return plain;
  }

  private async setNew(service: string, username: string, secret: string): Promise<void> {
    if (!this.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用（safeStorage 未就绪），无法保存凭据");
    }
    const ciphertext = await encrypt(secret);
    const file = this.loadFile();
    file.entries[entryKey(service, username)] = ciphertext.toString("base64");
    this.saveFile(file);
  }

  private loadFile(): SecretFile {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = emptyFile();
      return this.cache;
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<SecretFile>;
      if (raw.version !== 1 || raw.entries === undefined || typeof raw.entries !== "object") {
        throw new Error(`凭据文件版本不受支持：${String(raw.version)}`);
      }
      this.cache = { version: 1, entries: { ...raw.entries } };
      return this.cache;
    } catch (error) {
      // 文件损坏不能静默清空（否则用户凭据被悄悄删除），抛错让上层提示。
      throw new Error(
        `凭据文件损坏：${this.file}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  }

  private saveFile(file: SecretFile): void {
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* Windows 上 chmod 无意义，忽略 */
    }
    renameSync(tmp, this.file);
    this.cache = file;
  }

  // ─── Rust keyring 旧条目读取 ──────────────────────────────────────────────

  private async readLegacy(service: string, username: string): Promise<string | null> {
    try {
      switch (process.platform) {
        case "linux":
          return await this.readLegacyLinux(service, username);
        case "darwin":
          return await this.readLegacyMac(service, username);
        case "win32":
          return await this.readLegacyWindows(service, username);
        default:
          return null;
      }
    } catch (error) {
      this.logger.warn("读取旧 keyring 条目失败", {
        service,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async readLegacyLinux(service: string, username: string): Promise<string | null> {
    // zbus-secret-service-keyring-store 使用 attributes service+username。
    const result = await runCandidates([
      ["secret-tool", ["lookup", "service", service, "username", username]],
      ["secret-tool", ["lookup", "service", service, "account", username]],
    ]);
    return result;
  }

  private async readLegacyMac(service: string, username: string): Promise<string | null> {
    const result = await runCandidates([
      ["security", ["find-generic-password", "-s", service, "-a", username, "-w"]],
    ]);
    return result;
  }

  private async readLegacyWindows(service: string, username: string): Promise<string | null> {
    const script = WINDOWS_CRED_READ_SCRIPT.replace("@TARGETS@", () =>
      JSON.stringify([`${service}.${username}`, service]),
    );
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const decoded = decodeWindowsCredential(stdout);
    return decoded === "" ? null : decoded;
  }

  private async deleteLegacy(service: string, username: string): Promise<void> {
    if (process.platform === "linux") {
      await runCandidates([
        ["secret-tool", ["clear", "service", service, "username", username]],
        ["secret-tool", ["clear", "service", service, "account", username]],
      ]);
    } else if (process.platform === "darwin") {
      await runCandidates([["security", ["delete-generic-password", "-s", service, "-a", username]]]);
    } else if (process.platform === "win32") {
      await runCandidates([
        ["cmdkey", ["/delete", `${service}.${username}`]],
        ["cmdkey", ["/delete", service]],
      ]);
    }
  }
}

async function encrypt(plain: string): Promise<Buffer> {
  // Electron 44 仍有同步 API；46 起移除。用运行时探测保持向后兼容。
  const api = safeStorage as unknown as {
    encryptString?: (value: string) => Buffer;
    encryptStringAsync?: (value: string) => Promise<Buffer>;
  };
  if (typeof api.encryptString === "function") return api.encryptString(plain);
  if (typeof api.encryptStringAsync === "function") return await api.encryptStringAsync(plain);
  throw new Error("当前 Electron 版本不提供 safeStorage 加密 API");
}

async function decrypt(ciphertext: Buffer): Promise<string> {
  const api = safeStorage as unknown as {
    decryptString?: (value: Buffer) => string;
    decryptStringAsync?: (value: Buffer) => Promise<string>;
  };
  if (typeof api.decryptString === "function") return api.decryptString(ciphertext);
  if (typeof api.decryptStringAsync === "function") return await api.decryptStringAsync(ciphertext);
  throw new Error("当前 Electron 版本不提供 safeStorage 解密 API");
}

/** 依次尝试命令；ENOENT/非零退出都视为“没有”，全部失败返回 null。 */
async function runCandidates(candidates: [string, string[]][]): Promise<string | null> {
  for (const [command, args] of candidates) {
    try {
      const { stdout } = await execFileAsync(command, args, {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      const value = stdout.replace(/\r?\n$/, "");
      if (value !== "") return value;
    } catch {
      // 继续下一个候选；系统工具缺失（ENOENT）也走这里。
    }
  }
  return null;
}

/** PowerShell CredRead 脚本：输出 UTF-8 明文；找不到或失败时输出空。 */
const WINDOWS_CRED_READ_SCRIPT = `
$ErrorActionPreference = 'Stop'
$targets = ConvertFrom-Json '@TARGETS@'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags;
  public int Type;
  public string TargetName;
  public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public int CredentialBlobSize;
  public IntPtr CredentialBlob;
  public int Persist;
  public int AttributeCount;
  public IntPtr Attributes;
  public string TargetAlias;
  public string UserName;
}
public static class CredApi {
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int reserved, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
}
"@
foreach ($t in $targets) {
  $ptr = [IntPtr]::Zero
  if ([CredApi]::CredRead($t, 1, 0, [ref]$ptr)) {
    try {
      $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CREDENTIAL])
      $bytes = New-Object byte[] $cred.CredentialBlobSize
      [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $bytes.Length)
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      Write-Output ([System.Text.Encoding]::Unicode.GetString($bytes))
    } finally {
      [CredApi]::CredFree($ptr) | Out-Null
    }
    exit 0
  }
}
exit 0
`;

function decodeWindowsCredential(stdout: string): string {
  const value = stdout.replace(/\r?\n$/, "");
  if (value === "") return "";
  // PowerShell 若按 UTF-8 输出则直接用；CredentialBlob 本身是 UTF-16LE，
  // 脚本已解码，这里只做一次兜底 trim。
  return value.replace(/\u0000+$/, "");
}