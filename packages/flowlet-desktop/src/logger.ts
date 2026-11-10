// 桌面宿主日志：写文件（数据目录 logs/），供 platform.diagnostics 读取尾部。
//
// Rust 侧使用 tracing-appender 写 exe/logs；这里保持同样位置。日志不写任何
// 凭据明文（管理 token / keyring secret 必须在调用处脱敏）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_TAIL_LINES = 200;

export class DesktopLogger {
  private readonly file: string;

  constructor(logDir: string) {
    mkdirSync(logDir, { recursive: true });
    this.file = join(logDir, "flowlet-desktop.log");
  }

  path(): string {
    return this.file;
  }

  log(level: LogLevel, message: string, detail?: unknown): void {
    const line = formatLine(level, message, detail);
    try {
      this.rotateIfNeeded();
      appendFileSync(this.file, `${line}\n`, "utf8");
    } catch (error) {
      // 日志失败不能影响主流程；退回到控制台，避免异常被完全吞掉。
      console.error(`[flowlet-desktop] 写日志失败：${String(error)}`);
    }
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  info(message: string, detail?: unknown): void {
    this.log("info", message, detail);
  }

  warn(message: string, detail?: unknown): void {
    this.log("warn", message, detail);
  }

  error(message: string, detail?: unknown): void {
    this.log("error", message, detail);
  }

  tail(lines = MAX_TAIL_LINES): string[] {
    if (!existsSync(this.file)) return [];
    try {
      const content = readFileSync(this.file, "utf8");
      const all = content.split("\n").filter((line) => line !== "");
      return all.slice(Math.max(0, all.length - lines));
    } catch {
      return [];
    }
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.file)) return;
    if (statSync(this.file).size < MAX_LOG_BYTES) return;
    renameSync(this.file, `${this.file}.1`);
  }
}

function safeDetail(detail: unknown): string {
  if (detail === undefined) return "";
  try {
    const text = typeof detail === "string" ? detail : JSON.stringify(detail);
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  } catch {
    return String(detail);
  }
}

function formatLine(level: LogLevel, message: string, detail: unknown): string {
  const detailText = safeDetail(detail);
  return `${new Date().toISOString()} [${level}] ${message}${detailText === "" ? "" : ` ${detailText}`}`;
}