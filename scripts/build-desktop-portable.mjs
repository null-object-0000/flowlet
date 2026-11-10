// 构建 Electron 桌面端的便携版（未安装、绿色目录）ZIP。
//
// 与 Tauri 版 `scripts/build-portable.mjs` 的产物同构：
//   目录里放程序 + portable.tag + config.json，双击即可跑，数据落在程序旁边
//   （`packages/flowlet-desktop/src/paths.ts`：exe 旁有 portable.tag → 数据目录 = exe 目录）。
//
// 用法：
//   npm run desktop:portable              # 构建前端+host，再打未打包目录，最后出便携 zip
//   node scripts/build-desktop-portable.mjs --no-build   # 复用已有 dist-host
//   node scripts/build-desktop-portable.mjs --keep       # 保留中间目录（默认也保留，便于检查）
//
// 产物：
//   packages/flowlet-desktop/release/<platform>-unpacked/          electron-builder --dir 产物
//   packages/flowlet-desktop/release/portable/<名字>/              便携版目录
//   packages/flowlet-desktop/release/portable/<名字>.zip           便携版压缩包

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DESKTOP_DIR = join(REPO_ROOT, "packages", "flowlet-desktop");
const RELEASE_DIR = join(DESKTOP_DIR, "release");
const PORTABLE_DIR_ROOT = join(RELEASE_DIR, "portable");
const CONFIG_SRC = join(REPO_ROOT, "config.json");

const argv = process.argv.slice(2);
const noBuild = argv.includes("--no-build");
const keepIntermediate = argv.includes("--keep");

const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
const ARCH = process.arch.replace("x86_", "x").replace("x86", "x64");

const PLATFORM = {
  win32: { label: "win32", unpacked: ["win-unpacked"], executable: "Flowlet.exe" },
  linux: { label: "linux", unpacked: ["linux-unpacked"], executable: "flowlet" },
  darwin: {
    label: "macos",
    unpacked: ["mac-arm64", "mac", "mac-universal"],
    executable: "Flowlet.app/Contents/MacOS/Flowlet",
  },
}[process.platform];

/** electron-builder 产出的可执行文件名取决于 package.json 的 name / productName，逐个版本可能不同。 */
const EXECUTABLE_CANDIDATES = ["Flowlet.exe", "flowlet.exe", "Flowlet", "flowlet", "flowlet-desktop"];
/** Electron 自带的辅助进程，别当成主程序。 */
const HELPER_EXECUTABLES = new Set([
  "chrome_crashpad_handler",
  "chrome_crashpad_handler.exe",
  "chrome-sandbox",
  "chrome_proxy.exe",
  "elevation_service.exe",
  "notification_helper.exe",
]);

if (!PLATFORM) throw new Error(`暂不支持在 ${process.platform} 上构建便携版`);

const PORTABLE_DIR_NAME = `Flowlet_${VERSION}_${PLATFORM.label}_${ARCH}_portable`;
const PORTABLE_DIR = join(PORTABLE_DIR_ROOT, PORTABLE_DIR_NAME);
const ZIP_PATH = join(PORTABLE_DIR_ROOT, `${PORTABLE_DIR_NAME}.zip`);

function step(message) {
  console.log(`\n[便携版] ${message}`);
}

/** 复用 build-desktop.mjs（前端 dist-desktop + Electron host dist-host）。 */
function buildDesktop() {
  step("构建前端与 Electron host…");
  const result = spawnSync(process.execPath, [join(__dirname, "build-desktop.mjs")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`desktop 构建失败（退出码 ${result.status}）`);
}

/** 沙箱/受限环境下 ~/.cache 可能只读；electron-builder 需要可写缓存目录。 */
function builderEnv() {
  const env = { ...process.env };
  try {
    execFileSync(process.execPath, ["-e", "require('node:fs').accessSync(require('node:os').homedir()+'/.cache')"]);
    return env;
  } catch {
    const cache = join(REPO_ROOT, ".tmp-cache");
    mkdirSync(cache, { recursive: true });
    return { ...env, XDG_CACHE_HOME: cache };
  }
}

function packageUnpacked() {
  step("electron-builder 生成未打包目录（--dir）…");
  const candidates = [
    join(DESKTOP_DIR, "node_modules", "electron-builder", "out", "cli", "cli.js"),
    join(REPO_ROOT, "node_modules", "electron-builder", "out", "cli", "cli.js"),
  ];
  const cli = candidates.find((candidate) => existsSync(candidate));
  if (cli === undefined) {
    throw new Error(
      "未安装 electron-builder。先执行：cd packages/flowlet-desktop && npm install",
    );
  }
  const result = spawnSync(process.execPath, [cli, "--dir"], {
    cwd: DESKTOP_DIR,
    stdio: "inherit",
    env: builderEnv(),
  });
  if (result.status !== 0) throw new Error(`electron-builder 失败（退出码 ${result.status}）`);
}

function findUnpackedDir() {
  for (const name of PLATFORM.unpacked) {
    const candidate = join(RELEASE_DIR, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `没有找到未打包产物（期望其中之一：${PLATFORM.unpacked.join(" / ")}），目录：${RELEASE_DIR}`,
  );
}

function assemble(unpackedDir) {
  step(`组装便携版目录：${PORTABLE_DIR_NAME}`);
  rmSync(PORTABLE_DIR, { recursive: true, force: true });
  mkdirSync(PORTABLE_DIR, { recursive: true });
  cpSync(unpackedDir, PORTABLE_DIR, { recursive: true });

  // 便携标记：Electron host 看到 exe 旁的 portable.tag 就把数据目录切到程序旁。
  writeFileSync(join(PORTABLE_DIR, "portable.tag"), "");

  const detected = detectExecutable(PORTABLE_DIR);
  if (detected === null) {
    throw new Error(`没有在便携版目录里找到可执行文件（期望 ${PLATFORM.executable}）：${PORTABLE_DIR}`);
  }
  if (detected !== PLATFORM.executable) {
    // 统一成稳定名字：更新脚本和用户习惯都按这个名字找。
    renameSync(join(PORTABLE_DIR, detected), join(PORTABLE_DIR, PLATFORM.executable));
    console.log(`  可执行文件改名：${detected} → ${PLATFORM.executable}`);
  }

  if (existsSync(CONFIG_SRC)) {
    copyFileSync(CONFIG_SRC, join(PORTABLE_DIR, "config.json"));
    console.log("  已带上仓库 config.json");
  } else {
    console.warn("  警告：仓库根目录没有 config.json，便携版首次启动会生成默认配置");
  }

  if (process.platform === "linux") {
    const executablePath = join(PORTABLE_DIR, PLATFORM.executable);
    if (existsSync(executablePath)) chmodSync(executablePath, 0o755);
    // Electron 自带 chrome-sandbox 需要 root + setuid，便携版里拿不到 →
    // 用一个小启动脚本带上 --no-sandbox，否则双击直接崩「SUID sandbox helper … aborting」。
    const launcher = join(PORTABLE_DIR, "Flowlet.sh");
    writeFileSync(launcher, [
      "#!/bin/sh",
      "# Linux 便携版启动器：没有 setuid 的 chrome-sandbox，必须关掉沙箱再启动。",
      "cd \"$(dirname \"$0\")\" || exit 1",
      "exec ./" + PLATFORM.executable + " --no-sandbox \"$@\"",
      "",
    ].join("\n"));
    chmodSync(launcher, 0o755);
    console.log("  Linux 启动器：Flowlet.sh（带 --no-sandbox）");
  }

  console.log(`  可执行文件：${PLATFORM.executable}`);
}

/** 在产物目录里认出主程序：优先已知候选名，其次排除辅助进程后取最大的可执行文件。 */
function detectExecutable(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !HELPER_EXECUTABLES.has(entry.name));
  for (const name of EXECUTABLE_CANDIDATES) {
    const hit = entries.find((entry) => entry.name === name);
    if (hit) return hit.name;
  }
  const executableLike = entries
    .map((entry) => ({ name: entry.name, size: statSync(join(dir, entry.name)).size }))
    .filter((entry) => process.platform === "win32"
      ? entry.name.toLowerCase().endsWith(".exe")
      : (statSync(join(dir, entry.name)).mode & 0o111) !== 0)
    .sort((left, right) => right.size - left.size);
  return executableLike[0]?.name ?? null;
}

/** 使用 Python 内置 zipfile 跨平台打包（与 Tauri 便携版共用同一脚本）。 */
function zipDir() {
  step("压缩便携版…");
  if (existsSync(ZIP_PATH)) rmSync(ZIP_PATH);
  const pyScript = join(__dirname, "_zipdir.py");
  const candidates = process.platform === "win32"
    ? [["python"], ["py", "-3"], ["python3"]]
    : [["python3"], ["python"]];
  for (const [command, ...prefixArgs] of candidates) {
    try {
      execFileSync(command, [...prefixArgs, pyScript, PORTABLE_DIR, ZIP_PATH], { stdio: "inherit" });
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("未找到 Python 3，无法生成便携版 ZIP");
}

function main() {
  console.log(`=== 构建 Flowlet Electron 便携版（${PLATFORM.label} ${ARCH}）===`);
  if (!noBuild) buildDesktop();
  else console.log("\n[便携版] 跳过构建（--no-build），复用现有 dist-host / dist-desktop");
  packageUnpacked();
  const unpackedDir = findUnpackedDir();
  console.log(`  未打包目录：${unpackedDir}`);
  assemble(unpackedDir);
  zipDir();

  if (!keepIntermediate) {
    console.log("\n  提示：中间目录 <release>/<platform>-unpacked 保留，便于排查；不需要可手动删除");
  }
  console.log("\n✅ Electron 便携版已生成：");
  console.log(`   目录：${PORTABLE_DIR}`);
  console.log(`    ZIP：${ZIP_PATH}`);
  console.log("\n   用法：解压后直接运行里面的可执行文件；数据（config.json / flowlet.sqlite / data）落在程序旁边。");
}

try {
  main();
} catch (error) {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
