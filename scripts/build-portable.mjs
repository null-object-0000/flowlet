// 构建便携版 ZIP：flowlet.exe + flowlet_lib.dll + config.json
// 用法：bun run tauri:portable
//
// 产物统一输出到 src-tauri/target/release/bundle/portable/，与 msi/nsis 并列。

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const SRC_TAURI = join(PROJECT_ROOT, "src-tauri");
const RELEASE_DIR = join(SRC_TAURI, "target", "release");
const BUNDLE_DIR = join(RELEASE_DIR, "bundle");
const PORTABLE_BUNDLE_DIR = join(BUNDLE_DIR, "portable");
const CONFIG_SRC = join(PROJECT_ROOT, "config.json");

const PKG_JSON = join(PROJECT_ROOT, "package.json");
const version = JSON.parse(readFileSync(PKG_JSON, "utf8")).version;
const ARCH = process.env.TAURI_ENV_ARCH ?? process.arch.replace("x86_", "x").replace("x86", "x64");

const PORTABLE_DIR_NAME = `Flowlet_${version}_${ARCH}_portable`;
// 先解压到 bundle/portable/<目录/>，再同目录生成 zip
const PORTABLE_DIR = join(PORTABLE_BUNDLE_DIR, PORTABLE_DIR_NAME);
const ZIP_PATH = join(PORTABLE_BUNDLE_DIR, `${PORTABLE_DIR_NAME}.zip`);

/** 使用 Python 内置 zipfile 跨平台打包，兼容常见的 Python 命令名。 */
function zipDir() {
  const pyScript = join(__dirname, "_zipdir.py");
  const candidates = process.platform === "win32"
    ? [["python"], ["py", "-3"], ["python3"]]
    : [["python3"], ["python"]];

  for (const [command, ...prefixArgs] of candidates) {
    try {
      execFileSync(command, [...prefixArgs, pyScript, PORTABLE_DIR, ZIP_PATH], {
        stdio: "inherit",
      });
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  throw new Error("未找到 Python 3，无法生成便携版 ZIP");
}

function main() {
  console.log("=== 构建 Flowlet 便携版 ===");

  // 确保 bundle/portable/ 目录存在
  if (!existsSync(PORTABLE_BUNDLE_DIR)) {
    mkdirSync(PORTABLE_BUNDLE_DIR, { recursive: true });
  }

  copyRequired();

  if (existsSync(ZIP_PATH)) rmSync(ZIP_PATH);

  zipDir();
  console.log(`\n✅ 便携版已生成：`);
  console.log(`   目录：${PORTABLE_DIR}`);
  console.log(`    ZIP：${ZIP_PATH}`);
}

function copyRequired() {
  const exePath = join(RELEASE_DIR, "flowlet.exe");
  if (!existsSync(exePath)) {
    console.error(
      "未找到 flowlet.exe。请先跑 `bun run tauri:build` 生成 release 产物。"
    );
    process.exit(1);
  }

  if (existsSync(PORTABLE_DIR)) rmSync(PORTABLE_DIR, { recursive: true });
  mkdirSync(PORTABLE_DIR, { recursive: true });

  copyFileSync(exePath, join(PORTABLE_DIR, "flowlet.exe"));

  const dllPath = join(RELEASE_DIR, "flowlet_lib.dll");
  if (existsSync(dllPath)) {
    copyFileSync(dllPath, join(PORTABLE_DIR, "flowlet_lib.dll"));
  }

  if (existsSync(CONFIG_SRC)) {
    copyFileSync(CONFIG_SRC, join(PORTABLE_DIR, "config.json"));
  } else {
    console.warn("警告：未找到项目根目录 config.json");
  }

  // 便携标记：有这个文件时，app_database_path() 会把数据目录切到程序旁边，不与本机共享
  writeFileSync(join(PORTABLE_DIR, "portable.tag"), "");
  console.log("  写入 portable.tag，数据目录已切到程序旁");
}

main();
