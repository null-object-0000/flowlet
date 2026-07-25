// 打包前从 models-cn 官方拉取最新的 api.json，写入 src-tauri/models-cn.json，
// 随 Tauri bundle.resources 打包进安装包，让用户开箱即用。
//
// 用法：node scripts/fetch-models-cn.mjs

import { writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const SRC_TAURI = join(PROJECT_ROOT, "src-tauri");
const DEST = join(SRC_TAURI, "models-cn.json");
const BACKUP = join(SRC_TAURI, "models-cn.json.bak");

const SOURCE_URL = "https://null-object-0000.github.io/models-cn/api.json";

async function main() {
  console.log("=== 拉取 models-cn 目录 ===");
  console.log(`  来源：${SOURCE_URL}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const response = await fetch(SOURCE_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = await response.text();

    // 简单校验：必须是合法 JSON 且包含 providers 数组
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`响应不是合法 JSON：${error.message}`);
    }
    if (!parsed || !Array.isArray(parsed.providers)) {
      throw new Error("响应缺少 providers 字段");
    }

    // 备份当前文件以便回滚
    if (existsSync(DEST)) {
      copyFileSync(DEST, BACKUP);
    }

    writeFileSync(DEST, body, "utf8");
    const providers = parsed.providers.length;
    const models = parsed.providers.reduce((sum, p) => sum + (p.models?.length ?? 0), 0);
    console.log(`  写入：${join("src-tauri", "models-cn.json")}`);
    console.log(`  ${providers} 个厂商、${models} 个模型`);

    // 清理备份
    if (existsSync(BACKUP)) {
      unlinkSync(BACKUP);
    }
  } catch (error) {
    // 回滚
    if (existsSync(BACKUP)) {
      copyFileSync(BACKUP, DEST);
      unlinkSync(BACKUP);
      console.warn(`  拉取失败，已恢复原文件：${error.message}`);
    } else {
      if (existsSync(DEST)) {
        console.warn(`  拉取失败，保留现有文件：${error.message}`);
      } else {
        console.warn(`  拉取失败且无本地副本：${error.message}`);
        process.exitCode = 1;
      }
    }
  }
}

main();
