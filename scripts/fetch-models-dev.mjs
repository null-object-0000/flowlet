// 打包前从 models.dev 官方拉取最新的 api.json，写入 src-tauri/models-dev.json，
// 随 Tauri bundle.resources 打包进安装包，让用户开箱即用。
//
// 用法：node scripts/fetch-models-dev.mjs

import { writeFileSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const SRC_TAURI = join(PROJECT_ROOT, "src-tauri");
const DEST = join(SRC_TAURI, "models-dev.json");
const BACKUP = join(SRC_TAURI, "models-dev.json.bak");

const SOURCE_URL = "https://models.dev/api.json";

async function main() {
  console.log("=== 拉取 models.dev 目录 ===");
  console.log(`  来源：${SOURCE_URL}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const response = await fetch(SOURCE_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = await response.text();

    // 简单校验：必须是合法 JSON，顶层为 provider 对象且至少含 openai.models。
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`响应不是合法 JSON：${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("响应顶层不是 provider 对象");
    }
    const openaiModels = parsed.openai?.models;
    if (!openaiModels || typeof openaiModels !== "object" || Object.keys(openaiModels).length === 0) {
      throw new Error("响应缺少 openai.models");
    }

    // 备份当前文件以便回滚
    if (existsSync(DEST)) {
      copyFileSync(DEST, BACKUP);
    }

    writeFileSync(DEST, body, "utf8");
    const providers = Object.keys(parsed).length;
    let models = 0;
    for (const provider of Object.values(parsed)) {
      if (provider?.models && typeof provider.models === "object") {
        models += Object.keys(provider.models).length;
      }
    }
    console.log(`  写入：${join("src-tauri", "models-dev.json")}`);
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
