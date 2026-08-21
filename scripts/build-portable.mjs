// 构建便携版 ZIP：可执行文件 + 可选动态库 + config.json
// 用法：先构建 release 二进制，再运行 `node scripts/build-portable.mjs`
//
// Windows 打包 flowlet.exe，Linux 打包 flowlet 并保留执行权限。
// 产物统一输出到 src-tauri/target/release/bundle/portable/。

import {
  chmodSync,
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
// GNOME 会为透明图标补深色自适应底板；使用应用自带的白底圆角版本，
// 使 Dock 图标与窗口内的品牌图标保持一致。
const LINUX_ICON_SRC = join(SRC_TAURI, "icons", "macos-icon.png");
const LINUX_DESKTOP_INSTALLER_SRC = join(__dirname, "install-linux-desktop.sh");

const PKG_JSON = join(PROJECT_ROOT, "package.json");
const version = JSON.parse(readFileSync(PKG_JSON, "utf8")).version;
const ARCH = process.env.TAURI_ENV_ARCH ?? process.arch.replace("x86_", "x").replace("x86", "x64");
const PLATFORM = process.platform;

const PLATFORM_FILES = {
  win32: {
    executable: "flowlet.exe",
    library: "flowlet_lib.dll",
    directoryName: `Flowlet_${version}_${ARCH}_portable`,
  },
  linux: {
    executable: "flowlet",
    library: "libflowlet_lib.so",
    directoryName: `Flowlet_${version}_linux_${ARCH}_portable`,
  },
};

const platformFiles = PLATFORM_FILES[PLATFORM];
if (!platformFiles) {
  throw new Error(`暂不支持在 ${PLATFORM} 上构建便携版`);
}

const PORTABLE_DIR_NAME = platformFiles.directoryName;
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
  const executablePath = join(RELEASE_DIR, platformFiles.executable);
  if (!existsSync(executablePath)) {
    console.error(
      `未找到 ${platformFiles.executable}。请先跑 `
        + "`npm run tauri:build:portable` 生成 release 产物。"
    );
    process.exit(1);
  }

  if (existsSync(PORTABLE_DIR)) rmSync(PORTABLE_DIR, { recursive: true });
  mkdirSync(PORTABLE_DIR, { recursive: true });

  const portableExecutablePath = join(PORTABLE_DIR, platformFiles.executable);
  copyFileSync(executablePath, portableExecutablePath);
  if (PLATFORM === "linux") chmodSync(portableExecutablePath, 0o755);

  const libraryPath = join(RELEASE_DIR, platformFiles.library);
  if (existsSync(libraryPath)) {
    copyFileSync(libraryPath, join(PORTABLE_DIR, platformFiles.library));
  }

  if (PLATFORM === "linux") {
    const iconTarget = join(PORTABLE_DIR, "flowlet.png");
    const installerTarget = join(PORTABLE_DIR, "install-desktop-entry.sh");
    copyFileSync(LINUX_ICON_SRC, iconTarget);
    copyFileSync(LINUX_DESKTOP_INSTALLER_SRC, installerTarget);
    chmodSync(installerTarget, 0o755);
  }

  if (existsSync(CONFIG_SRC)) {
    copyFileSync(CONFIG_SRC, join(PORTABLE_DIR, "config.json"));
  } else {
    console.warn("警告：未找到项目根目录 config.json");
  }

  // 随包内置模型目录文件，开箱即用
  for (const fileName of ["models-cn.json", "models-dev.json"]) {
    const catalogSrc = join(SRC_TAURI, fileName);
    if (existsSync(catalogSrc)) {
      copyFileSync(catalogSrc, join(PORTABLE_DIR, fileName));
    } else {
      console.warn(`警告：未找到 src-tauri/${fileName}（运行 tauri:build 时会自动拉取）`);
    }
  }

  // 便携标记：有这个文件时，app_database_path() 会把数据目录切到程序旁边，不与本机共享
  writeFileSync(join(PORTABLE_DIR, "portable.tag"), "");
  console.log("  写入 portable.tag，数据目录已切到程序旁");
}

main();
