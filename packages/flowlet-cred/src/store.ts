// 全局凭据库：dotenv + 元数据 sidecar。Owner: node-web（flowlet-cred）。
//
// 权威实现：src-tauri/src/core/credential_store.rs（728 行）逐行为等价：
// - 单一事实源是 credentials.env 文本（Agent 可直接 cat/source）；
// - 写入只经 CLI：原子写（tmp + rename）+ 0600，目录 0700；
// - 元数据（kind/note/created_at/updated_at）放 credentials.json（BTreeMap 排序 + 2 空格缩进）；
// - 保留手写注释/空行/非法行（非法行降级为注释行保存，不静默丢数据）；
// - 默认目录 config_dir()/flowlet/credentials，FLOWLET_CRED_DIR 覆盖。
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const ENV_FILE_NAME = "credentials.env";
export const META_FILE_NAME = "credentials.json";
export const DIR_ENV_OVERRIDE = "FLOWLET_CRED_DIR";

const ENV_HEADER = [
  "# Flowlet 全局凭据库",
  "# 由 `flowlet-cred` 维护；请在 CLI 中增删（原子写 + 0600），不要手工重排此文件。",
  "# 读取：Agent 可 cat 本文件；写入：请用 `flowlet-cred set KEY`。",
].join("\n");

export type EnvLine =
  | { type: "blank" }
  | { type: "comment"; text: string }
  | { type: "pair"; key: string; value: string };

export interface CredentialMeta {
  kind: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface CredentialEntry {
  key: string;
  kind: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export type ExportFormat = "dotenv" | "shell" | "json";

export function nowRfc3339(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function defaultDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DIR_ENV_OVERRIDE];
  if (override !== undefined) {
    if (override === "") throw new Error(`${DIR_ENV_OVERRIDE} 不能为空`);
    return override;
  }
  let base: string;
  if (process.platform === "win32") {
    base = env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
  } else if (process.platform === "darwin") {
    base = path.join(homedir(), "Library", "Application Support");
  } else {
    base = env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
  }
  return path.join(base, "flowlet", "credentials");
}

// ─── 解析 / 编码（与 Rust parse_env / encode_value / decode_value 一致） ────

export function parseEnv(text: string): EnvLine[] {
  const rawLines = text.split("\n");
  // Rust str::lines() 不返回末尾换行产生的空行。
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const lines: EnvLine[] = [];
  for (const rawWithCr of rawLines) {
    const line = rawWithCr.endsWith("\r") ? rawWithCr.slice(0, -1) : rawWithCr;
    const trimmed = line.trim();
    if (trimmed === "") {
      lines.push({ type: "blank" });
      continue;
    }
    if (trimmed.startsWith("#")) {
      lines.push({ type: "comment", text: trimmed });
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      lines.push({ type: "comment", text: line });
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (key === "" || !isValidKey(key)) {
      lines.push({ type: "comment", text: line });
      continue;
    }
    lines.push({ type: "pair", key, value: decodeValue(line.slice(eq + 1).trim()) });
  }
  return lines;
}

/** 同名键以最后一次出现为准；顺序按首次出现。 */
export function coalescePairs(lines: EnvLine[]): Array<[string, string]> {
  const order: string[] = [];
  const values = new Map<string, string>();
  for (const line of lines) {
    if (line.type !== "pair") continue;
    if (!values.has(line.key)) order.push(line.key);
    values.set(line.key, line.value);
  }
  return order.filter((key) => values.has(key)).map((key) => [key, values.get(key)!]);
}

function upsertPair(lines: EnvLine[], key: string, value: string): void {
  let found = false;
  for (const line of lines) {
    if (line.type === "pair" && line.key === key) {
      line.value = value;
      found = true;
    }
  }
  if (!found) lines.push({ type: "pair", key, value });
}

function safeChar(codePoint: number): boolean {
  const ch = String.fromCodePoint(codePoint);
  if (/^[A-Za-z0-9]$/.test(ch)) return true;
  return "-_./:@%+=,~".includes(ch);
}

/** dotenv 编码：安全字符裸写，否则单引号并转义内部单引号。 */
export function encodeValue(value: string): string {
  if (value === "") return "''";
  const safe = [...value].every((ch) => safeChar(ch.codePointAt(0)!));
  if (safe) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function decodeValue(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return text;
}

export function isValidKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

export function validateKey(key: string): void {
  if (isValidKey(key)) return;
  throw new Error(`非法的凭据名 \`${key}\`：只能使用字母、数字和下划线，且不能以数字开头`);
}

export function validateKind(kind: string): void {
  const valid = kind !== "" && kind.length <= 32 && /^[a-z0-9_-]+$/.test(kind);
  if (valid) return;
  throw new Error(
    `非法的凭据类型 \`${kind}\`：使用小写字母、数字、下划线或连字符（如 api_key / cli_token / mcp_token）`,
  );
}

// ─── 文件系统（原子写 / 权限） ─────────────────────────────────────────────

function restrictFile(target: string): void {
  if (process.platform === "win32") return;
  chmodSync(target, 0o600);
}

function restrictDir(dir: string): void {
  if (process.platform === "win32") return;
  chmodSync(dir, 0o700);
}

function writeAtomic(target: string, content: string): void {
  const parent = path.dirname(target);
  mkdirSync(parent, { recursive: true });
  const temp = path.join(parent, `.${path.basename(target)}.tmp-${process.pid}`);
  try {
    // 同步写 + fsync：与 Rust write_atomic 一致，避免留下半截文件。
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, content, null, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    restrictFile(temp);
    renameSync(temp, target);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`替换文件失败（${target}）：${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── CredentialStore ───────────────────────────────────────────────────────

export class CredentialStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  static fromDefaultDir(env: NodeJS.ProcessEnv = process.env): CredentialStore {
    return new CredentialStore(defaultDir(env));
  }

  envPath(): string {
    return path.join(this.dir, ENV_FILE_NAME);
  }

  metaPath(): string {
    return path.join(this.dir, META_FILE_NAME);
  }

  /** 创建目录与空文件（已存在则保留内容）。 */
  init(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (error) {
      throw new Error(`创建凭据目录失败（${this.dir}）：${errorMessage(error)}`);
    }
    restrictDir(this.dir);
    if (!existsSync(this.envPath())) writeAtomic(this.envPath(), `${ENV_HEADER}\n`);
    if (!existsSync(this.metaPath())) writeAtomic(this.metaPath(), "{}");
  }

  exists(): boolean {
    return existsSync(this.envPath());
  }

  pairs(): Array<[string, string]> {
    return coalescePairs(parseEnv(this.readEnvText()));
  }

  keys(): string[] {
    return this.pairs().map(([key]) => key);
  }

  list(): CredentialEntry[] {
    const pairs = this.pairs();
    const meta = this.readMeta();
    return pairs.map(([key]) => {
      const entry = meta[key];
      return {
        key,
        kind: entry?.kind ?? "api_key",
        note: entry?.note ?? null,
        created_at: entry?.created_at ?? "",
        updated_at: entry?.updated_at ?? "",
      };
    });
  }

  get(key: string): string | null {
    validateKey(key);
    const pairs = this.pairs();
    for (let index = pairs.length - 1; index >= 0; index -= 1) {
      if (pairs[index]![0] === key) return pairs[index]![1];
    }
    return null;
  }

  set(key: string, value: string, kind?: string | null, note?: string | null): CredentialEntry {
    validateKey(key);
    const normalizedKind = kind?.trim() ? kind.trim() : null;
    if (normalizedKind !== null) validateKind(normalizedKind);
    this.init();
    const now = nowRfc3339();
    const lines = parseEnv(this.readEnvText());
    upsertPair(lines, key, value);
    this.writeEnv(lines);

    const meta = this.readMeta();
    const existing = meta[key];
    const entry: CredentialMeta =
      existing === undefined
        ? {
            kind: normalizedKind ?? "api_key",
            note: note ?? null,
            created_at: now,
            updated_at: now,
          }
        : {
            kind: normalizedKind ?? existing.kind,
            note: note ?? existing.note,
            created_at: existing.created_at,
            updated_at: now,
          };
    meta[key] = entry;
    this.writeMeta(meta);
    return {
      key,
      kind: entry.kind,
      note: entry.note,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    };
  }

  /** 删除一条凭据；返回是否真的删掉了。 */
  unset(key: string): boolean {
    validateKey(key);
    if (!this.exists()) return false;
    const lines = parseEnv(this.readEnvText());
    const before = lines.length;
    const kept = lines.filter((line) => !(line.type === "pair" && line.key === key));
    const removed = kept.length !== before;
    if (removed) this.writeEnv(kept);
    const meta = this.readMeta();
    if (Object.prototype.hasOwnProperty.call(meta, key)) {
      delete meta[key];
      this.writeMeta(meta);
    }
    return removed;
  }

  /** 清空全部凭据（保留注释/空行/非法行与文件头）。 */
  clear(): number {
    if (!this.exists()) return 0;
    const lines = parseEnv(this.readEnvText());
    const kept = lines.filter((line) => line.type !== "pair");
    const removed = lines.length - kept.length;
    if (removed > 0) this.writeEnv(kept);
    const meta = this.readMeta();
    if (Object.keys(meta).length > 0) this.writeMeta({});
    return removed;
  }

  export(only: string[], format: ExportFormat): string {
    const pairs = this.pairs();
    let selected: Array<[string, string]>;
    if (only.length === 0) {
      selected = pairs;
    } else {
      selected = only.map((key) => {
        for (let index = pairs.length - 1; index >= 0; index -= 1) {
          if (pairs[index]![0] === key) return [key, pairs[index]![1]] as [string, string];
        }
        throw new Error(`凭据不存在：${key}`);
      });
    }
    if (format === "dotenv") {
      return selected.map(([key, value]) => `${key}=${encodeValue(value)}\n`).join("");
    }
    if (format === "shell") {
      return selected.map(([key, value]) => `export ${key}=${encodeValue(value)};\n`).join("");
    }
    const map: Record<string, string> = {};
    for (const [key, value] of selected) map[key] = value;
    const sorted: Record<string, string> = {};
    for (const key of Object.keys(map).sort()) sorted[key] = map[key]!;
    return `${JSON.stringify(sorted, null, 2)}\n`;
  }

  /** 诊断：路径、权限、重复键、元数据缺失。 */
  doctor(): string[] {
    const report: string[] = [];
    report.push(`目录：${this.dir}`);
    report.push(`环境文件：${this.envPath()}`);
    if (!this.exists()) {
      report.push("状态：尚未初始化（运行 `flowlet-cred init`）");
      return report;
    }
    report.push(`凭据数：${this.pairs().length}`);
    if (process.platform !== "win32") {
      try {
        const mode = statSync(this.envPath()).mode & 0o777;
        if ((mode & 0o077) !== 0) {
          report.push(`警告：环境文件权限为 ${mode.toString(8)}，其他用户可读，建议 600`);
        }
      } catch {
        /* 忽略：与 Rust if let Ok 一致 */
      }
    }
    const raw = parseEnv(this.readEnvText());
    const seen = new Map<string, number>();
    for (const line of raw) {
      if (line.type === "pair") seen.set(line.key, (seen.get(line.key) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([key]) => key)
      .sort();
    if (duplicates.length > 0) {
      report.push(`警告：重复的键（后者生效）：${duplicates.join(", ")}`);
    }
    const meta = this.readMeta();
    const missing = this.pairs()
      .map(([key]) => key)
      .filter((key) => !Object.prototype.hasOwnProperty.call(meta, key));
    if (missing.length > 0) {
      report.push(`提示：缺少元数据的键：${missing.join(", ")}`);
    }
    return report;
  }

  private readEnvText(): string {
    try {
      return readFileSync(this.envPath(), "utf8");
    } catch (error) {
      if (isNotFound(error)) return "";
      throw new Error(`读取凭据文件失败（${this.envPath()}）：${errorMessage(error)}`);
    }
  }

  private writeEnv(lines: EnvLine[]): void {
    let text = `${ENV_HEADER}\n`;
    for (const line of lines) {
      if (line.type === "blank") text += "\n";
      else if (line.type === "comment") text += `${line.text}\n`;
      else text += `${line.key}=${encodeValue(line.value)}\n`;
    }
    writeAtomic(this.envPath(), text);
  }

  private readMeta(): Record<string, CredentialMeta> {
    let text: string;
    try {
      text = readFileSync(this.metaPath(), "utf8");
    } catch (error) {
      if (isNotFound(error)) return {};
      throw new Error(`读取凭据元数据失败：${errorMessage(error)}`);
    }
    if (text.trim() === "") return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`解析凭据元数据失败：${errorMessage(error)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("解析凭据元数据失败：expected a map");
    }
    return parsed as Record<string, CredentialMeta>;
  }

  private writeMeta(meta: Record<string, CredentialMeta>): void {
    const sorted: Record<string, CredentialMeta> = {};
    for (const key of Object.keys(meta).sort()) {
      const entry = meta[key]!;
      sorted[key] = {
        kind: entry.kind,
        note: entry.note ?? null,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
      };
    }
    writeAtomic(this.metaPath(), `${JSON.stringify(sorted, null, 2)}\n`);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: string }).code === "ENOENT"
  );
}