// Anthropic SSE `content_block_start` 缺失字段修复（thinking / tool_use）。
//
// 逐段对照 `src-tauri/src/core/proxy_anthropic_compat.rs::ContentBlockStartCompat`。
// 必须在捕获之后应用：日志保留上游原文，客户端收到修复后的流。
import { isRecord, parseJson, stringifySorted } from "./util.ts";

const MAX_LINE_BYTES = 64 * 1024;

function normalizeLine(line: Buffer): Buffer {
  if (!line.subarray(0, 5).equals(Buffer.from("data:"))) return line;
  const parsed = parseJson(line.subarray(5));
  if (!isRecord(parsed)) return line;
  if (parsed.type !== "content_block_start") return line;
  const block = parsed.content_block;
  if (!isRecord(block)) return line;

  let field: string;
  let value: unknown;
  if (block.type === "thinking" && !Object.prototype.hasOwnProperty.call(block, "thinking")) {
    field = "thinking";
    value = "";
  } else if (block.type === "tool_use" && !Object.prototype.hasOwnProperty.call(block, "input")) {
    field = "input";
    value = {};
  } else {
    return line;
  }
  block[field] = value;
  return Buffer.concat([Buffer.from("data: "), Buffer.from(stringifySorted(parsed), "utf8")]);
}

/**
 * 按行状态机修复 SSE 起始块；超 64KiB 的行整行原样透传，流末尾不完整行不修复。
 * 非 `enabled` 时逐字节原样透传（调用方可直接跳过）。
 */
export class AnthropicContentBlockRepair {
  #line: number[] = [];
  #oversized = false;

  push(bytes: Buffer): Buffer {
    const output: number[] = [];
    for (const byte of bytes) {
      if (byte === 0x0d || byte === 0x0a) {
        if (!this.#oversized) {
          const normalized = normalizeLine(Buffer.from(this.#line));
          for (const value of normalized) output.push(value);
        }
        this.#line = [];
        this.#oversized = false;
        output.push(byte);
      } else if (this.#oversized) {
        output.push(byte);
      } else if (this.#line.length === MAX_LINE_BYTES) {
        // 超长行不再累积，直接透传并标记；后续字节同样透传。
        for (const value of this.#line) output.push(value);
        output.push(byte);
        this.#oversized = true;
      } else {
        this.#line.push(byte);
      }
    }
    return Buffer.from(output);
  }

  /** 流末尾：不完整行原样透传，不做修复。 */
  finish(): Buffer {
    if (this.#line.length === 0) return Buffer.alloc(0);
    const tail = Buffer.from(this.#line);
    this.#line = [];
    this.#oversized = false;
    return tail;
  }
}
