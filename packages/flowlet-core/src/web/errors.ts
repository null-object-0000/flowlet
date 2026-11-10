// 命令参数解析 / 错误形状。Owner: node-web.
//
// 权威实现：src-tauri/src/core/web/commands.rs 的 `arg<T>()` + serde_json 错误文本。
// Rust 对缺失/类型错误的返回固定为 (400, "command_failed",
// `参数 {name}: {serde 错误}`)。这里复刻 serde_json 的常见错误措辞，保证
// Web 端错误信息与 Rust 版一致（也是迁移验收项）。
import { CommandError } from "../types.ts";
import type { JsonRow } from "../types.ts";

/** serde_json::Value 的运行时类型描述（用于 "invalid type: ..., expected ..."）。 */
export function serdeTypeName(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "sequence";
  switch (typeof value) {
    case "string":
      return `string ${JSON.stringify(value)}`;
    case "number":
      return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
    case "boolean":
      return `boolean \`${value}\``;
    case "object":
      return "map";
    default:
      return typeof value;
  }
}

/** 构造 `参数 {name}: {detail}` 错误（与 Rust arg() 的错误前缀一致）。 */
export function argError(name: string, detail: string): CommandError {
  return CommandError.badRequest(`参数 ${name}: ${detail}`);
}

/** Rust `arg()` 的类型错误。 */
export function invalidType(value: unknown, expected: string, name: string): CommandError {
  return argError(name, `invalid type: ${serdeTypeName(value)}, expected ${expected}`);
}

/** 把参数对象规整为普通对象（非对象时 Rust `Value::get` 返回 None，等价于缺参）。 */
export function argsObject(args: unknown): JsonRow {
  return args !== null && typeof args === "object" && !Array.isArray(args)
    ? (args as JsonRow)
    : {};
}

export function argString(args: JsonRow, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw invalidType(value, "a string", name);
  return value;
}

export function argOptionalString(args: JsonRow, name: string): string | null {
  const value = args[name];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalidType(value, "a string", name);
  return value;
}

export function argBool(args: JsonRow, name: string): boolean {
  const value = args[name];
  if (typeof value !== "boolean") throw invalidType(value, "a boolean", name);
  return value;
}

export function argOptionalBool(args: JsonRow, name: string): boolean | null {
  const value = args[name];
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw invalidType(value, "a boolean", name);
  return value;
}

export function argInteger(
  args: JsonRow,
  name: string,
  expected: "i64" | "u32" | "usize" = "i64",
): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidType(value, expected, name);
  }
  if (expected !== "i64" && value < 0) {
    throw argError(name, `invalid value: integer \`${value}\`, expected ${expected}`);
  }
  return value;
}

export function argOptionalInteger(
  args: JsonRow,
  name: string,
  expected: "i64" | "u32" | "usize" = "i64",
): number | null {
  const value = args[name];
  if (value === null || value === undefined) return null;
  return argInteger(args, name, expected);
}

export function argFloat(args: JsonRow, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw invalidType(value, "f64", name);
  }
  return value;
}

export function argArray(args: JsonRow, name: string, structName?: string): JsonRow[] {
  const value = args[name];
  if (value === null || value === undefined) {
    throw argError(name, "invalid type: null, expected a sequence");
  }
  if (!Array.isArray(value)) {
    throw invalidType(value, "a sequence", name);
  }
  const expected = structName ? `struct ${structName}` : "a map";
  return value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw argError(name, `invalid type: ${serdeTypeName(item)}, expected ${expected}`);
    }
    return item as JsonRow;
  });
}

export function argObject(args: JsonRow, name: string, structName: string): JsonRow {
  const value = args[name];
  if (value === null || value === undefined) {
    throw argError(name, `invalid type: null, expected struct ${structName}`);
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalidType(value, `struct ${structName}`, name);
  }
  return value as JsonRow;
}

/** 校验结构体必填字段（serde 默认行为：无 #[serde(default)] 的字段必须存在）。 */
export function requireFields(value: JsonRow, name: string, fields: string[]): void {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw argError(name, `missing field \`${field}\``);
    }
  }
}