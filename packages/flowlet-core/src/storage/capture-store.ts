// `.flcap` 外置请求捕获帧：与 Rust `src-tauri/src/core/request_capture.rs` 逐字节对齐。
//
// 帧布局（60 字节头 + zstd 压缩的 serde_json 记录）：
//   [0..8)   magic `FLCAP001`
//   [8..10)  format_version u16 LE（当前 1）
//   [10..12) flags u16 LE（当前恒 0）
//   [12..20) compressed_len u64 LE
//   [20..28) raw_len u64 LE
//   [28..60) sha256(raw json) 32 字节
//   [60..)   zstd(level=3) 压缩的记录 JSON
//
// 存储布局（root = <db 目录>/request-captures）：
//   sessions/<safe agent_type>/<YYYY>-<MM>/<sha256(agent_type\0session_id)[:32]>/<NNNNNN>.flcap
//   unassigned/<YYYY-MM-DD>/<sha256(request_id)[:2]>/<NNNNNN>.flcap
// 单段上限 32 MiB；写满后新建递增段；整理时写 `compacted-<uuid>.flcap` 后由调用方删旧段。
//
// 记录的 JSON 字段顺序必须与 Rust `RequestCaptureRecord` 的声明顺序一致（serde
// 按声明顺序序列化），否则无法与 Rust 产出的 raw 字节/checksum 对齐。
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { zstdCompressSync, zstdDecompressSync, constants as zlibConstants } from "node:zlib";
import type { JsonRow } from "../types.ts";

export const FRAME_MAGIC = Buffer.from("FLCAP001", "ascii");
export const FORMAT_VERSION = 1;
export const FRAME_HEADER_BYTES = 60;
export const DEFAULT_SEGMENT_BYTES = 32 * 1024 * 1024;
export const ZSTD_LEVEL = 3;

export type CaptureErrorKind =
  | "io"
  | "json"
  | "lock"
  | "invalid_path"
  | "invalid_frame"
  | "checksum_mismatch";

export class CaptureError extends Error {
  kind: CaptureErrorKind;
  constructor(kind: CaptureErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Rust `RequestCaptureRecord`（字段顺序即 serde JSON 序列化顺序）。 */
export interface RequestCaptureRecord {
  format_version: number;
  request_log_id: string;
  request_id: string;
  attempt_seq: number;
  captured_at: string;
  agent_type: string | null;
  agent_session_id: string | null;
  parent_agent_session_id: string | null;
  client_id: string | null;
  client_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  account_id: string | null;
  account_name: string | null;
  client_protocol: string;
  upstream_protocol: string;
  virtual_model: string | null;
  public_model: string | null;
  upstream_model: string | null;
  request_type: string;
  method: string;
  path: string;
  upstream_url: string | null;
  status: number | null;
  is_stream: boolean;
  error_message: string | null;
  route_reason: string | null;
  req_headers_json: string | null;
  req_body_b64: string | null;
  res_headers_json: string | null;
  res_body_b64: string | null;
  incomplete: boolean;
}

export interface RequestCapturePointer {
  storage_key: string;
  offset: number;
  length: number;
  checksum: string;
  format_version: number;
  req_body_bytes: number;
  res_body_bytes: number;
}

/** Rust `RequestCaptureRecord::from_log`（RequestLogInput → 记录）。 */
export function captureRecordFromLog(requestLogId: string, log: JsonRow): RequestCaptureRecord {
  const isStream = Boolean(log.is_stream);
  const durationMs = log.duration_ms === null || log.duration_ms === undefined ? null : Number(log.duration_ms);
  return {
    format_version: FORMAT_VERSION,
    request_log_id: requestLogId,
    request_id: String(log.request_id ?? ""),
    attempt_seq: Number(log.attempt_seq ?? 0),
    captured_at: new Date().toISOString(),
    agent_type: (log.agent_type as string | null) ?? null,
    agent_session_id: (log.agent_session_id as string | null) ?? null,
    parent_agent_session_id: (log.parent_agent_session_id as string | null) ?? null,
    client_id: (log.client_id as string | null) ?? null,
    client_name: (log.client_name as string | null) ?? null,
    channel_id: (log.channel_id as string | null) ?? null,
    channel_name: (log.channel_name as string | null) ?? null,
    account_id: (log.account_id as string | null) ?? null,
    account_name: (log.account_name as string | null) ?? null,
    client_protocol: String(log.client_protocol ?? "openai"),
    upstream_protocol: String(log.upstream_protocol ?? "openai"),
    virtual_model: (log.virtual_model as string | null) ?? null,
    public_model: (log.public_model as string | null) ?? null,
    upstream_model: (log.upstream_model as string | null) ?? null,
    request_type: String(log.request_type ?? "unknown"),
    method: String(log.method ?? ""),
    path: String(log.path ?? ""),
    upstream_url: (log.upstream_url as string | null) ?? null,
    status: log.status === null || log.status === undefined ? null : Number(log.status),
    is_stream: isStream,
    error_message: (log.error_message as string | null) ?? null,
    route_reason: (log.route_reason as string | null) ?? null,
    req_headers_json: (log.req_headers_json as string | null) ?? null,
    req_body_b64: (log.req_body_b64 as string | null) ?? null,
    res_headers_json: (log.res_headers_json as string | null) ?? null,
    res_body_b64: (log.res_body_b64 as string | null) ?? null,
    incomplete: isStream && durationMs === null,
  };
}

export function recordReqBodyBytes(record: RequestCaptureRecord): number {
  return record.req_body_b64 === null ? 0 : Buffer.byteLength(record.req_body_b64, "utf8");
}

export function recordResBodyBytes(record: RequestCaptureRecord): number {
  return record.res_body_b64 === null ? 0 : Buffer.byteLength(record.res_body_b64, "utf8");
}

/** 严格按 Rust 结构体声明顺序序列化（serde 逐字段、紧凑 JSON）。 */
export function serializeCaptureRecord(record: RequestCaptureRecord): Buffer {
  const ordered: Record<string, unknown> = {
    format_version: record.format_version,
    request_log_id: record.request_log_id,
    request_id: record.request_id,
    attempt_seq: record.attempt_seq,
    captured_at: record.captured_at,
    agent_type: record.agent_type,
    agent_session_id: record.agent_session_id,
    parent_agent_session_id: record.parent_agent_session_id,
    client_id: record.client_id,
    client_name: record.client_name,
    channel_id: record.channel_id,
    channel_name: record.channel_name,
    account_id: record.account_id,
    account_name: record.account_name,
    client_protocol: record.client_protocol,
    upstream_protocol: record.upstream_protocol,
    virtual_model: record.virtual_model,
    public_model: record.public_model,
    upstream_model: record.upstream_model,
    request_type: record.request_type,
    method: record.method,
    path: record.path,
    upstream_url: record.upstream_url,
    status: record.status,
    is_stream: record.is_stream,
    error_message: record.error_message,
    route_reason: record.route_reason,
    req_headers_json: record.req_headers_json,
    req_body_b64: record.req_body_b64,
    res_headers_json: record.res_headers_json,
    res_body_b64: record.res_body_b64,
    incomplete: record.incomplete,
  };
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

function sha256(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function hexLower(bytes: Buffer): string {
  return bytes.toString("hex");
}

function zstdCompress(bytes: Buffer): Buffer {
  return zstdCompressSync(bytes, {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
  });
}

function toCaptureError(error: unknown, fallbackKind: CaptureErrorKind = "io"): CaptureError {
  if (error instanceof CaptureError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CaptureError(fallbackKind, message);
}

/** Rust `safe_path_component`：仅保留 ASCII 字母数字与 `-_.`，其余替换为 `-`。 */
export function safePathComponent(value: string): string {
  let filtered = "";
  for (const character of value) {
    filtered += /[A-Za-z0-9\-_.]/.test(character) ? character : "-";
  }
  return filtered === "" ? "unknown" : filtered;
}

/** Rust `path_to_storage_key`：只保留正常路径分量并用 `/` 拼接。 */
function pathToStorageKey(relative: string): string {
  return relative
    .split(/[\\/]+/)
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

/** Rust `select_segment`：扫描目录已存在的 `NNNNNN.flcap`，按 32MiB 上限选择写入段。 */
function selectSegment(directory: string, maxBytes: number, incomingBytes: number): string {
  let highest = 0;
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".flcap")) continue;
      const stem = entry.slice(0, -".flcap".length);
      if (!/^\d+$/.test(stem)) continue;
      const number = Number.parseInt(stem, 10);
      if (!Number.isFinite(number) || number < 0 || number > 0xffffffff) continue;
      highest = Math.max(highest, number);
    }
  }
  if (highest === 0) return "000001.flcap";
  const current = `${String(highest).padStart(6, "0")}.flcap`;
  let currentBytes = 0;
  try {
    currentBytes = statSync(path.join(directory, current)).size;
  } catch {
    currentBytes = 0;
  }
  if (currentBytes > 0 && currentBytes + incomingBytes > maxBytes) {
    return `${String(highest + 1).padStart(6, "0")}.flcap`;
  }
  return current;
}

/** 已读帧头（解压前）。 */
interface FrameHeader {
  version: number;
  compressedLength: number;
  rawLength: number;
  checksum: Buffer;
}

function buildFrameBytes(record: RequestCaptureRecord): {
  buffer: Buffer;
  checksum: string;
  rawLength: number;
  compressedLength: number;
  reqBodyBytes: number;
  resBodyBytes: number;
} {
  const raw = serializeCaptureRecord(record);
  const checksumBytes = sha256(raw);
  const compressed = zstdCompress(raw);
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  FRAME_MAGIC.copy(header, 0);
  header.writeUInt16LE(FORMAT_VERSION, 8);
  header.writeUInt16LE(0, 10);
  header.writeBigUInt64LE(BigInt(compressed.length), 12);
  header.writeBigUInt64LE(BigInt(raw.length), 20);
  checksumBytes.copy(header, 28);
  return {
    buffer: Buffer.concat([header, compressed]),
    checksum: hexLower(checksumBytes),
    rawLength: raw.length,
    compressedLength: compressed.length,
    reqBodyBytes: recordReqBodyBytes(record),
    resBodyBytes: recordResBodyBytes(record),
  };
}

export class RequestCaptureStore {
  #root: string;
  #segmentBytes: number;

  constructor(root: string, segmentBytes: number = DEFAULT_SEGMENT_BYTES) {
    this.#root = root;
    this.#segmentBytes = segmentBytes;
  }

  /**
   * Rust `RequestCaptureStore::for_database`：root = `<数据库目录>/request-captures`。
   * `:memory:`（测试）没有数据目录，使用系统临时目录下的独立子目录（Rust 测试同理）。
   */
  static forDatabase(databasePath: string, options: { tempRoot?: string } = {}): RequestCaptureStore {
    if (databasePath === ":memory:") {
      const root =
        options.tempRoot ??
        path.join(process.env.TMPDIR || "/tmp", `flowlet-request-captures-${randomUUID()}`);
      mkdirSync(root, { recursive: true });
      return new RequestCaptureStore(root);
    }
    const parent = path.dirname(databasePath) || ".";
    return new RequestCaptureStore(path.join(parent, "request-captures"));
  }

  rootPath(): string {
    return this.#root;
  }

  segmentBytes(): number {
    return this.#segmentBytes;
  }

  /** Rust `resolve_storage_key`：拒绝空 key、绝对路径与 `..` 越界分量。 */
  resolveStorageKey(storageKey: string): string {
    if (!storageKey || storageKey.includes("\0")) {
      throw new CaptureError("invalid_path", `非法捕获文件路径: ${storageKey}`);
    }
    const segments = storageKey.split(/[\\/]+/);
    if (segments.some((segment) => segment === "..") || /^[A-Za-z]:/.test(storageKey)) {
      throw new CaptureError("invalid_path", `非法捕获文件路径: ${storageKey}`);
    }
    const resolved = path.resolve(this.#root, storageKey);
    const rootWithSep = this.#root.endsWith(path.sep) ? this.#root : `${this.#root}${path.sep}`;
    if (resolved !== this.#root && !resolved.startsWith(rootWithSep)) {
      throw new CaptureError("invalid_path", `非法捕获文件路径: ${storageKey}`);
    }
    return resolved;
  }

  /** Rust `relative_directory`：按会话/请求分组生成分目录。 */
  #relativeDirectory(record: RequestCaptureRecord): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const agentType = record.agent_type?.trim() ?? "";
    const sessionId = record.agent_session_id?.trim() ?? "";
    if (agentType && sessionId) {
      const safeAgentType = safePathComponent(agentType);
      const sessionHash = hexLower(
        sha256(Buffer.from(`${safeAgentType}\0${sessionId}`, "utf8")),
      ).slice(0, 32);
      return path.posix.join(
        "sessions",
        safeAgentType,
        `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`,
        sessionHash,
      );
    }
    const requestHash = hexLower(sha256(Buffer.from(record.request_id, "utf8"))).slice(0, 2);
    const iso = now.toISOString();
    return path.posix.join("unassigned", iso.slice(0, 10), requestHash);
  }

  /** Rust `append_locked`：压缩记录并追加到当前段，返回指针。 */
  append(record: RequestCaptureRecord): RequestCapturePointer {
    try {
      const frame = buildFrameBytes(record);
      const relativeDir = this.#relativeDirectory(record);
      const absoluteDir = path.join(this.#root, ...relativeDir.split("/"));
      mkdirSync(absoluteDir, { recursive: true });
      const segment = selectSegment(absoluteDir, this.#segmentBytes, frame.buffer.length);
      const storageKey = pathToStorageKey(path.posix.join(relativeDir, segment));
      const filePath = this.resolveStorageKey(storageKey);
      mkdirSync(path.dirname(filePath), { recursive: true });
      const fd = openSync(filePath, "a+");
      try {
        const offset = fstatSync(fd).size;
        writeSync(fd, frame.buffer);
        return {
          storage_key: storageKey,
          offset,
          length: FRAME_HEADER_BYTES + frame.compressedLength,
          checksum: frame.checksum,
          format_version: FORMAT_VERSION,
          req_body_bytes: frame.reqBodyBytes,
          res_body_bytes: frame.resBodyBytes,
        };
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      throw toCaptureError(error);
    }
  }

  /**
   * Rust `rewrite_segment_locked`：把同一段内所有存活记录写到新段
   * `compacted-<uuid>.flcap`，返回新指针；旧段由调用方在 refs 提交后删除。
   */
  rewriteSegment(storageKey: string, records: Iterable<RequestCaptureRecord>): RequestCapturePointer[] {
    try {
      const oldPath = this.resolveStorageKey(storageKey);
      const relative = path.posix.dirname(storageKey);
      if (relative === "." || relative === "") {
        throw new CaptureError("invalid_path", storageKey);
      }
      const newName = `compacted-${randomUUID().replace(/-/g, "")}.flcap`;
      const newStorageKey = pathToStorageKey(path.posix.join(relative, newName));
      const newPath = this.resolveStorageKey(newStorageKey);
      mkdirSync(path.dirname(newPath), { recursive: true });
      const fd = openSync(newPath, "wx+");
      const pointers: RequestCapturePointer[] = [];
      try {
        try {
          for (const record of records) {
            const frame = buildFrameBytes(record);
            const offset = fstatSync(fd).size;
            writeSync(fd, frame.buffer);
            pointers.push({
              storage_key: newStorageKey,
              offset,
              length: FRAME_HEADER_BYTES + frame.compressedLength,
              checksum: frame.checksum,
              format_version: FORMAT_VERSION,
              req_body_bytes: frame.reqBodyBytes,
              res_body_bytes: frame.resBodyBytes,
            });
          }
        } finally {
          closeSync(fd);
        }
        if (!existsSync(oldPath)) {
          throw new CaptureError("invalid_frame", "待整理 segment 不存在");
        }
      } catch (error) {
        rmSync(newPath, { force: true });
        throw error;
      }
      return pointers;
    } catch (error) {
      throw toCaptureError(error);
    }
  }

  /** Rust `remove_segment_locked`：删除段文件（不存在视为成功）。 */
  removeSegment(storageKey: string): void {
    try {
      unlinkSync(this.resolveStorageKey(storageKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw toCaptureError(error);
    }
  }

  /** Rust `read`：校验 magic/版本/长度/checksum 后解压并解析记录。 */
  read(pointer: RequestCapturePointer): RequestCaptureRecord {
    try {
      const filePath = this.resolveStorageKey(pointer.storage_key);
      const fd = openSync(filePath, "r");
      let headerBytes: Buffer;
      let compressed: Buffer;
      try {
        headerBytes = Buffer.alloc(FRAME_HEADER_BYTES);
        readExact(fd, headerBytes, pointer.offset);
        const header = parseFrameHeader(headerBytes);
        if (header.version !== FORMAT_VERSION || header.version !== pointer.format_version) {
          throw new CaptureError("invalid_frame", `不支持的格式版本 ${header.version}`);
        }
        if (FRAME_HEADER_BYTES + header.compressedLength !== pointer.length) {
          throw new CaptureError("invalid_frame", "帧长度不匹配");
        }
        if (hexLower(header.checksum) !== pointer.checksum) {
          throw new CaptureError("checksum_mismatch", "捕获帧校验失败");
        }
        compressed = Buffer.alloc(header.compressedLength);
        readExact(fd, compressed, pointer.offset + FRAME_HEADER_BYTES);
        const raw = zstdDecompressSync(compressed);
        if (raw.length !== header.rawLength || !sha256(raw).equals(header.checksum)) {
          throw new CaptureError("checksum_mismatch", "捕获帧校验失败");
        }
        const record = JSON.parse(raw.toString("utf8")) as RequestCaptureRecord;
        if (Number(record.format_version) !== header.version) {
          throw new CaptureError("invalid_frame", "记录版本与帧版本不一致");
        }
        return record;
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new CaptureError("json", error.message);
      }
      throw toCaptureError(error);
    }
  }

  /** Rust `disk_usage`：递归统计 .flcap 段数量与总字节。 */
  diskUsage(): { segments: number; bytes: number } {
    let segments = 0;
    let bytes = 0;
    const visit = (directory: string): void => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.name.endsWith(".flcap")) {
          segments += 1;
          try {
            bytes += statSync(full).size;
          } catch {
            /* 忽略读取失败 */
          }
        }
      }
    };
    visit(this.#root);
    return { segments, bytes };
  }

  /** 直接读取整段文件内容（测试/诊断用）。 */
  readSegment(storageKey: string): Buffer {
    return readFileSync(this.resolveStorageKey(storageKey));
  }
}

function readExact(fd: number, buffer: Buffer, position: number): void {
  let read = 0;
  while (read < buffer.length) {
    const bytes = readSync(fd, buffer, read, buffer.length - read, position + read);
    if (bytes === 0) throw new CaptureError("io", "读取捕获帧时遇到文件末尾");
    read += bytes;
  }
}

function parseFrameHeader(header: Buffer): FrameHeader {
  if (!header.subarray(0, 8).equals(FRAME_MAGIC)) {
    throw new CaptureError("invalid_frame", "magic 不匹配");
  }
  const version = header.readUInt16LE(8);
  const compressedLength = Number(header.readBigUInt64LE(12));
  const rawLength = Number(header.readBigUInt64LE(20));
  const checksum = Buffer.from(header.subarray(28, 60));
  return { version, compressedLength, rawLength, checksum };
}