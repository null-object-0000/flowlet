// models-cn.json 读取（Codex 动态模型目录的能力事实来源）。
//
// 实现入口：已同步的模型目录文件。
// Web/桌面 Host 的目录文件位于 `ctx.catalogDir/models-cn.json`；不存在或不可解析时
// 返回 null（Codex 目录退化为保守条目，不阻断写入）。
import { readFileSync } from "node:fs";
import path from "node:path";

import type { JsonRow } from "../types.ts";

export function readModelsCnSource(catalogDir: string): JsonRow | null {
  let raw: string;
  try {
    raw = readFileSync(path.join(catalogDir, "models-cn.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRow)
      : null;
  } catch {
    return null;
  }
}