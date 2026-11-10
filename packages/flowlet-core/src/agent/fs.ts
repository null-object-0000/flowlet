// Agent 全局配置的文件原语：读取、原子写入、事务回滚、备份快照。
//
// 权威实现：`src-tauri/src/core/agent_global_config.rs`（read_settings /
// write_bytes_file / write_files_transactionally / capture_file / write_optional_file）。
// 行为要求（AGENTS.md §1）：任何失败都不得破坏原文件；写入必须原子（临时文件 + rename）；
// 多文件写入必须整体成功或回滚到写入前快照。
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { JsonRow } from "../types.ts";
import { displayPath } from "./paths.ts";

/** 与 `jsonc-parser` 共享：允许注释与尾逗号（Claude/OpenCode/Pi 的 JSON/JSONC）。 */
export interface JsoncEdit {
  offset: number;
  length: number;
  content: string;
}

export function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function fileExists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function directoryExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`读取 ${displayPath(file)} 失败：${errorText(error)}`);
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}


/**
 * 读取并校验 Agent 设置文件（Rust `read_settings`）。
 *
 * 使用 JSONC 解析以保留/接受注释（桌面端配置外科手术必须保注释），顶层必须是对象；
 * `env` 若存在必须是对象（Claude Code settings.json 语义）。
 */
/** `serde_json::to_string_pretty` + 末尾换行（Rust `json_file_bytes`）。 */
export function jsonFileBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** 写入 JSON 文件（原子写入，Rust `write_json_file`）。 */
export function writeJsonFile(file: string, value: unknown): void {
  writeBytesFile(file, jsonFileBytes(value));
}

/** 文本文件内容，保证末尾换行（Rust `text_file_bytes`）。 */
export function textFileBytes(content: string): Buffer {
  return Buffer.from(content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

/**
 * 受管文件内容比较：忽略 CRLF 差异与尾部空行（Rust `managed_text_file_matches`）。
 * 未安装/不可读时返回 false。
 */
export function managedTextFileMatches(file: string, expected: string): boolean {
  const actual = readTextOrNull(file);
  if (actual === null) return false;
  return normalizeManagedText(actual) === normalizeManagedText(expected);
}

function normalizeManagedText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n+$/u, "");
}

/** 原子写入：同目录临时文件 + rename；Unix 上权限 0600（Rust `write_bytes_file`）。 */
export function writeBytesFile(file: string, content: Buffer): void {
  const parent = path.dirname(file);
  try {
    mkdirSync(parent, { recursive: true });
  } catch (error) {
    throw new Error(`创建配置目录 ${displayPath(parent)} 失败：${errorText(error)}`);
  }
  const extension = path.extname(file).replace(/^\./u, "") || "json";
  const temporary = path.join(
    parent,
    `${path.basename(file, path.extname(file))}.${extension}.flowlet-tmp-${randomUUID()}`,
  );
  try {
    writeFileSync(temporary, content);
  } catch (error) {
    throw new Error(`写入临时配置 ${displayPath(temporary)} 失败：${errorText(error)}`);
  }
  try {
    setPrivatePermissions(temporary);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // 忽略清理失败：原始错误更有价值。
    }
    throw error;
  }
  try {
    renameSync(temporary, file);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // 忽略清理失败。
    }
    throw new Error(`替换配置 ${displayPath(file)} 失败：${errorText(error)}`);
  }
}

/** Unix 权限 0600；Windows 无等价操作（Rust 侧同样是空实现）。 */
export function setPrivatePermissions(file: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(file, 0o600);
  } catch (error) {
    throw new Error(`设置配置文件权限失败：${errorText(error)}`);
  }
}

/** 事务写入失败信息；`rolledBack` 表示此前写入的文件已恢复。 */
export class TransactionFailure extends Error {
  readonly rolledBack: boolean;

  constructor(message: string, rolledBack: boolean) {
    super(message);
    this.rolledBack = rolledBack;
  }
}

/**
 * 依次写入多个文件；任一失败时把此前写入的文件恢复到写入前快照
 * （Rust `write_files_transactionally`）。`content === null` 表示删除该文件。
 */
export function writeFilesTransactionally(
  description: string,
  writes: ReadonlyArray<readonly [string, Buffer | null]>,
): void {
  const snapshots: Array<Buffer | null> = [];
  for (const [file] of writes) {
    snapshots.push(captureFile(file));
  }
  for (let index = 0; index < writes.length; index += 1) {
    const [file, content] = writes[index];
    try {
      writeOptionalFile(file, content);
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (let rollback = 0; rollback < index; rollback += 1) {
        try {
          writeOptionalFile(writes[rollback][0], snapshots[rollback]);
        } catch (rollbackError) {
          rollbackErrors.push(errorText(rollbackError));
        }
      }
      if (rollbackErrors.length === 0) {
        throw new TransactionFailure(`${errorText(error)}；已回滚 ${description}`, true);
      }
      throw new TransactionFailure(
        `${errorText(error)}；自动回滚失败：${rollbackErrors.join("；")}`,
        false,
      );
    }
  }
}

/** 读取文件快照；不存在返回 null（Rust `capture_file`）。 */
export function captureFile(file: string): Buffer | null {
  if (!fileExists(file)) return null;
  try {
    return readFileSync(file);
  } catch (error) {
    throw new Error(`读取事务快照 ${displayPath(file)} 失败：${errorText(error)}`);
  }
}

function writeOptionalFile(file: string, content: Buffer | null): void {
  if (content !== null) {
    writeBytesFile(file, content);
    return;
  }
  if (fileExists(file)) {
    try {
      rmSync(file);
    } catch (error) {
      throw new Error(`删除配置文件 ${displayPath(file)} 失败：${errorText(error)}`);
    }
  }
}

/** 删除文件并忽略不存在；其它错误带上 Rust 对齐的前缀。 */
export function removeFileIfExists(file: string, description: string): void {
  try {
    rmSync(file, { force: true });
  } catch (error) {
    throw new Error(`${description}：${errorText(error)}`);
  }
}

/** 写入备份/快照类 JSON（原子、0600）。 */
export function writePrivateJson(file: string, value: unknown): void {
  writeJsonFile(file, value);
}

/** 当前时间 RFC3339（Rust `chrono::Utc::now().to_rfc3339()` 的可解析等价形式）。 */
export function rfc3339Now(): string {
  return new Date().toISOString();
}

/** 文件是否存在且为非目录（供调用方判断 `settings_exists`）。 */
export function isFile(file: string): boolean {
  return fileExists(file);
}

export { existsSync };