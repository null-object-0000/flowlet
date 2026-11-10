// YAML 解析与注释保留编辑（DeepSeek Harness settings.yaml / credentials、
// Hermes config.yaml）。权威实现：`agent_global_config/adapters/deepseek_harness.rs`
// 的 `patch_yaml_entry` 与 `hermes.rs` 的 YAML 辅助函数。
//
// Rust 侧是「行级补丁 + serde_yaml 语义校验」，迁移改为 `yaml` 的 Document API：
// Document 保留原文件的注释、键顺序与缩进风格，只重写被管理的键；语义校验
// （根必须是映射、父键必须是映射、值不可安全改写时报错）与 Rust 保持一致。
import { parseDocument, isMap } from "yaml";

import type { JsonRow } from "../types.ts";
import { errorText, readText, readTextOrNull } from "./fs.ts";
import { displayPath } from "./paths.ts";

export function isYamlMapping(value: unknown): value is JsonRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 读取 YAML 文本；文件不存在返回空串（Rust `read_yaml_text`）。 */
export function readYamlText(file: string): string {
  if (readTextOrNull(file) === null) return "";
  return readText(file);
}

/** 读取 YAML 映射；空文件视为空映射，根节点必须是对象（Rust `read_yaml_value`）。 */
export function readYamlValue(file: string): JsonRow {
  const text = readYamlText(file);
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = parseYamlDocument(text, displayPath(file)).toJS();
  } catch (error) {
    throw new Error(`解析 ${displayPath(file)} 失败：${errorText(error)}`);
  }
  if (!isYamlMapping(value)) {
    throw new Error(`${displayPath(file)} 的根节点必须是 YAML 对象`);
  }
  return value;
}

/** 解析 YAML 文本为普通值（语义校验用；不保留注释）。 */
export function parseYamlValue(text: string): unknown {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length > 0) throw new Error(`解析 YAML 失败：${doc.errors[0].message}`);
  return doc.toJS();
}

/** 解析单个 YAML 文档并校验语法（返回 Document，供调用方做注释保留编辑）。 */
export function parseYamlDocument(text: string, label: string) {
  const doc = parseDocument(text, { keepSourceTokens: false, prettyErrors: false });
  if (doc.errors.length > 0) {
    throw new Error(`解析 ${label} 失败：${doc.errors[0].message}`);
  }
  return doc;
}

/** 读取嵌套属性（Rust `yaml_at`：先映射键，再尝试序列索引）。 */
export function yamlAt(root: unknown, path: ReadonlyArray<string>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isYamlMapping(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export interface YamlEntryPatch {
  /** 父级键路径；空数组表示根映射。 */
  parents: ReadonlyArray<string>;
  key: string;
  /** `undefined` 表示删除该键；否则写入该值。 */
  value: unknown;
}

/**
 * 设置/删除一个 YAML 键（Rust `patch_yaml_entry` 的 Document API 等价）。
 *
 * - 父级不存在时自动创建为普通缩进映射；
 * - 父级存在但不是映射时报错（避免把用户的行内/复杂写法覆盖掉）；
 * - `value === undefined` 且目标不存在时原样返回（幂等）。
 */
export function patchYamlEntry(
  text: string,
  label: string,
  parents: ReadonlyArray<string>,
  key: string,
  value: unknown,
): string {
  const doc = parseYamlDocument(text, label);
  if (!isMap(doc.contents) && doc.contents !== null) {
    throw new Error(`${label} 的根节点必须是 YAML 对象`);
  }
  const parentPath = [...parents];
  for (let index = 0; index < parentPath.length; index += 1) {
    const partial = parentPath.slice(0, index + 1);
    const node = doc.getIn(partial, true);
    if (node === undefined) break;
    if (!isMap(node)) {
      throw new Error(`${label} 中的 ${partial.join(".")} 必须是 YAML 对象`);
    }
  }
  const targetPath = [...parentPath, key];
  const existing = doc.hasIn(targetPath);
  if (value === undefined) {
    if (existing) doc.deleteIn(targetPath);
  } else {
    doc.setIn(targetPath, value);
  }
  return doc.toString({ lineWidth: 0 });
}

/** 兼容导出：`JsonRow` 的键路径补丁（供各 Adapter 组合多次写入）。 */
export function patchYamlEntries(
  text: string,
  label: string,
  patches: ReadonlyArray<YamlEntryPatch>,
): string {
  let output = text;
  for (const patch of patches) {
    output = patchYamlEntry(output, label, patch.parents, patch.key, patch.value);
  }
  return output;
}

/** YAML 渲染的纯量安全判定（Rust `yaml_plain_safe`；DSH MCP 块生成使用）。 */
export function yamlPlainSafe(value: string): boolean {
  if (value === "" || value.trim() !== value) return false;
  const first = value.charCodeAt(0);
  const isAlpha = (code: number) =>
    (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
  if (!(isAlpha(first) || first === 0x5f || first === 0x2e)) return false;
  if (value.includes(": ") || value.includes(" #") || value.endsWith(":")) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const allowed =
      (code >= 0x30 && code <= 0x39) ||
      isAlpha(code) ||
      "_-. /:@+=%~^()".replace(" ", "").includes(character);
    if (!allowed) return false;
  }
  const lower = value.toLowerCase();
  if (["true", "false", "null", "yes", "no", "on", "off", "~"].includes(lower)) return false;
  if (/^[+-]?\d+$/u.test(value) || /^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/u.test(value)) {
    return false;
  }
  return true;
}

/** 生成 YAML 纯量文本：能安全裸写则裸写，否则单引号并按 YAML 规则转义。 */
export function yamlQuote(value: string): string {
  return yamlPlainSafe(value) ? value : `'${value.replace(/'/gu, "''")}'`;
}