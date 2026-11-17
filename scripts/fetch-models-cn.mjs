// 打包前从 models-cn 官方拉取最新的 api.json，写入 resources/catalogs/models-cn.json，
// 由 Electron / Node Host 作为内置模型目录读取，让用户开箱即用。
//
// models-cn 同时发布两个内容一致的入口：主站（EdgeOne，含中国大陆节点）优先，
// GitHub Pages 作为备用镜像；任一可用即完成拉取。
//
// 用法：node scripts/fetch-models-cn.mjs

import { writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const CATALOG_DIR = join(PROJECT_ROOT, "resources", "catalogs");
const DEST = join(CATALOG_DIR, "models-cn.json");
const BACKUP = join(CATALOG_DIR, "models-cn.json.bak");

const SOURCE_URLS = [
  "https://models.devtrends.site/api.json",
  "https://null-object-0000.github.io/models-cn/api.json",
];

async function fetchCatalog(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

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
    return { body, parsed, url };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  console.log("=== 拉取 models-cn 目录 ===");

  const failures = [];
  let result = null;
  for (const url of SOURCE_URLS) {
    try {
      result = await fetchCatalog(url);
      console.log(`  来源：${url}`);
      break;
    } catch (error) {
      failures.push(`${url}：${error.message}`);
      console.warn(`  来源不可用：${url}（${error.message}）`);
    }
  }

  try {
    if (result === null) {
      throw new Error(`所有来源均失败：${failures.join("；")}`);
    }
    const { body, parsed } = result;

    // 备份当前文件以便回滚
    if (existsSync(DEST)) {
      copyFileSync(DEST, BACKUP);
    }

    mkdirSync(CATALOG_DIR, { recursive: true });
    writeFileSync(DEST, body, "utf8");
    const providers = parsed.providers.length;
    const models = parsed.providers.reduce((sum, p) => sum + (p.models?.length ?? 0), 0);
    console.log(`  写入：${join("resources", "catalogs", "models-cn.json")}`);
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
