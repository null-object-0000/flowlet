// JSON / JSONC 解析与注释保留编辑（Claude Code、OpenCode、Pi 的全局配置）。
//
// 权威实现：Rust 侧对 Claude/Pi 使用 serde_json（不保注释），对 OpenCode 使用
// `jsonc_parser` 的 CST。桌面迁移的硬要求是「配置外科手术必须保注释与格式」，
// 因此统一使用 `jsonc-parser` 的 `modify` + `applyEdits`（CST 级编辑）：
// - 只改动目标属性，未触及的行、缩进、注释与尾逗号原样保留；
// - 读取时接受注释（JSONC），但顶层必须是对象。
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  type Node as JsoncNode,
  type ParseError,
} from "jsonc-parser";

import type { JsonRow } from "../types.ts";
import { errorText, fileExists, readText, type JsoncEdit } from "./fs.ts";
import { displayPath } from "./paths.ts";

export interface JsoncParseOptions {
  /** OpenCode 官方 JSONC 允许尾逗号；Claude/Pi 的 JSON 配置文件保持严格。 */
  allowTrailingComma: boolean;
}

/** 解析 JSONC 文本为普通值；语法错误时抛出可读异常（含行列偏移）。 */
export function parseJsonc(text: string, options: JsoncParseOptions = { allowTrailingComma: true }): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: options.allowTrailingComma,
    allowEmptyContent: false,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `JSON 解析失败（${printParseErrorCode(first.error)} @ offset ${first.offset}）`,
    );
  }
  return value;
}

/** 读取 JSONC 设置文件的普通对象（顶层必须为对象）。 */
export function parseJsoncObject(
  text: string,
  label: string,
  options: JsoncParseOptions = { allowTrailingComma: true },
): JsonRow {
  const value = parseJsonc(text, options);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 顶层必须是 JSON 对象`);
  }
  return value as JsonRow;
}

/**
 * 读取并校验 JSON/JSONC Agent 设置文件（Rust `read_settings` 的 Node 等价）。
 * 解析错误与顶层/`env` 校验的错误文案与 Rust 对齐。
 */
export function readJsoncSettings(
  file: string,
  options: JsoncParseOptions = { allowTrailingComma: true },
): JsonRow {
  const content = readText(file);
  let value: JsonRow;
  try {
    value = parseJsoncObject(content, displayPath(file), options);
  } catch (error) {
    throw new Error(`解析 ${displayPath(file)} 失败：${errorText(error)}`);
  }
  if (value.env !== undefined && !isJsonObject(value.env)) {
    throw new Error(`${displayPath(file)} 中 env 必须是 JSON 对象`);
  }
  return value;
}

export function isJsonObject(value: unknown): value is JsonRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 读取可选 JSON 对象：文件不存在返回 `{}`（Rust `read_optional_json_object`）。 */
export function readOptionalJsonObject(file: string): JsonRow {
  if (!fileExists(file)) return {};
  return readJsoncSettings(file);
}

/** 属性是否存在（own property）。 */
export function hasJsonProperty(value: JsonRow, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** 按 JSON Pointer 读取嵌套属性（支持 `/a/b`，与 Rust `Value::pointer` 语义近似）。 */
export function jsonPointer(root: JsonRow, pointer: string): unknown {
  if (pointer === "") return root;
  const segments = pointer
    .replace(/^\//u, "")
    .split("/")
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
  let current: unknown = root;
  for (const segment of segments) {
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function editOptions(text: string) {
  return {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: text.includes("\r\n") ? "\r\n" : "\n",
    },
  };
}

/** 在 JSONC 文本中设置属性（不存在则创建），返回新文本；保留所有注释与格式。 */
export function jsoncSet(text: string, targetPath: ReadonlyArray<string>, value: unknown): string {
  const edits: JsoncEdit[] = modify(text, [...targetPath], value, editOptions(text));
  return applyEdits(text, edits);
}

/**
 * 在 JSONC 文本中删除属性（不存在则无操作）；保留所有注释与格式。
 *
 * 不使用 `modify(..., undefined)`：jsonc-parser 删除属性时会连带吞掉前一个属性的
 * 行尾注释。这里按 CST 节点手工计算删除区间，只移除目标属性自身（含相邻逗号与
 * 独占行时的新行），其余 trivia 原样保留。
 */
export function jsoncDelete(text: string, targetPath: ReadonlyArray<string>): string {
  const root = parseTree(text);
  if (root === undefined) return text;
  const valueNode = findNodeAtLocation(root, [...targetPath]);
  if (valueNode === undefined) return text;
  const property = valueNode.parent;
  if (property === undefined || property.type !== "property") return text;
  const propertyStart = property.offset;
  const propertyEnd = property.offset + property.length;
  // 属性后的逗号（优先）或属性前的逗号。
  let after = propertyEnd;
  while (after < text.length && /\s/u.test(text[after])) after += 1;
  const hasTrailingComma = text[after] === ",";
  const commaBefore = hasTrailingComma ? -1 : precedingCommaOffset(text, propertyStart);
  // 独占整行时连同该行缩进与换行一起删除。
  const lineStart = text.lastIndexOf("\n", propertyStart - 1) + 1;
  const lineEnd = (() => {
    const index = text.indexOf("\n", propertyEnd);
    return index < 0 ? text.length : index + 1;
  })();
  const suffixAfterProperty = text
    .slice(propertyEnd, lineEnd)
    .replace(/\r?\n$/u, "")
    .replace(/^\s*,/u, "");
  const aloneOnLine =
    text.slice(lineStart, propertyStart).trim() === "" && suffixAfterProperty.trim() === "";
  let deleteStart = propertyStart;
  let deleteEnd = propertyEnd;
  if (hasTrailingComma) {
    deleteEnd = after + 1;
  }
  if (aloneOnLine) {
    deleteStart = lineStart;
    deleteEnd = lineEnd;
  }
  let output = text.slice(0, deleteStart) + text.slice(deleteEnd);
  // 删除最后一个属性时，前面的逗号要单独移除（不能吞掉它所在行的行尾注释）。
  if (!hasTrailingComma && commaBefore >= 0) {
    output = output.slice(0, commaBefore) + output.slice(commaBefore + 1);
  }
  return output;
}

/** 向前跳过空白与行尾 `//` 注释，找到前一个属性后的逗号偏移。 */
function precedingCommaOffset(text: string, start: number): number {
  let before = start - 1;
  while (before >= 0 && /\s/u.test(text[before])) before -= 1;
  const lineStart = text.lastIndexOf("\n", before) + 1;
  const commentIndex = lineCommentStart(text, lineStart, before + 1);
  if (commentIndex >= 0) {
    before = commentIndex - 1;
    while (before >= 0 && /\s/u.test(text[before])) before -= 1;
  }
  return text[before] === "," ? before : -1;
}

/** 若 `[from, to)` 内存在行尾 `//` 注释，返回其起始偏移。 */
function lineCommentStart(text: string, from: number, to: number): number {
  let quote: '"' | null = null;
  let escaped = false;
  for (let index = from; index < to; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (character === "/" && text[index + 1] === "/") return index;
  }
  return -1;
}

/** 设置或删除：`value === undefined` 时删除（Rust `set/restore_cst_property`）。 */
export function jsoncSetOrDelete(
  text: string,
  targetPath: ReadonlyArray<string>,
  value: unknown,
): string {
  return value === undefined ? jsoncDelete(text, targetPath) : jsoncSet(text, targetPath, value);
}