// Flowlet 桌面构建/启动入口。
//
//   npm run desktop:build        构建 dist-desktop（vite --mode desktop）+ dist-host
//   npm run desktop:dev          构建后启动 Electron（开发）
//   npm run desktop:dist         构建后调用 electron-builder 出安装包
//
// 可选参数：
//   --no-frontend                复用已有 dist-desktop（冒烟时加速）
//   --fallback-static            desktop 前端构建失败时把 dist-web 复制为 dist-desktop 冒烟
//   --screenshot=<png>           启动后截图并退出（配合 xvfb-run）
//   --print-url-file=<file>      把真实 web URL 写入文件，供冒烟脚本轮询 /health
//   --data-dir=<dir>             覆盖数据目录（冒烟用隔离库）
//   --                           其后参数原样传给 Electron
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DESKTOP_DIR = join(REPO_ROOT, "packages", "flowlet-desktop");
const DIST_DESKTOP = join(REPO_ROOT, "dist-desktop");

const argv = process.argv.slice(2);
const dev = argv.includes("--dev");
const dist = argv.includes("--dist");
const noFrontend = argv.includes("--no-frontend") || argv.includes("--skip-frontend");
const fallbackStatic = argv.includes("--fallback-static");
const passthroughIndex = argv.indexOf("--");
const passthrough = passthroughIndex >= 0 ? argv.slice(passthroughIndex + 1) : [];
const ownArgs = passthroughIndex >= 0 ? argv.slice(0, passthroughIndex) : argv;
const dataDirArg = ownArgs.find((arg) => arg.startsWith("--data-dir="));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function buildFrontend() {
  if (noFrontend) {
    console.log("[build-desktop] 跳过前端构建（--no-frontend）");
    return;
  }
  const viteBin = join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) throw new Error("未找到 vite，请先在仓库根执行 npm install");
  console.log("[build-desktop] 构建前端：vite build --mode desktop --outDir dist-desktop");
  const status = run(process.execPath, [viteBin, "build", "--mode", "desktop", "--outDir", "dist-desktop"], {
    cwd: REPO_ROOT,
    env: { ...process.env },
  });
  if (status === 0) return;
  if (!fallbackStatic) {
    throw new Error("前端 desktop 构建失败。若只是壳层冒烟，可加 --fallback-static 使用 dist-web");
  }
  const distWeb = join(REPO_ROOT, "dist-web");
  if (!existsSync(join(distWeb, "index.html"))) {
    throw new Error("前端 desktop 构建失败且 dist-web 不存在，无法回退");
  }
  console.warn("[build-desktop] 警告：desktop 前端构建失败，回退复制 dist-web → dist-desktop 做冒烟");
  rmSync(DIST_DESKTOP, { recursive: true, force: true });
  mkdirSync(DIST_DESKTOP, { recursive: true });
  copyDir(distWeb, DIST_DESKTOP);
}

function copyDir(source, target) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyDir(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
    }
  }
}

function buildHost() {
  console.log("[build-desktop] 构建 Electron 宿主 bundle");
  const status = run(process.execPath, [join(SCRIPT_DIR, "build-desktop-host.mjs")], { cwd: REPO_ROOT });
  if (status !== 0) throw new Error("宿主 bundle 构建失败");
}

function resolveElectronBinary() {
  const local = join(DESKTOP_DIR, "node_modules", "electron", "dist", "electron");
  if (existsSync(local)) return local;
  try {
    const requireFromDesktop = createRequire(join(DESKTOP_DIR, "package.json"));
    const electronPath = requireFromDesktop("electron");
    if (typeof electronPath === "string" && existsSync(electronPath)) return electronPath;
  } catch {
    /* 继续尝试 PATH */
  }
  return "electron";
}

function sandboxHelperUsable() {
  try {
    const stat = statSync(join(DESKTOP_DIR, "node_modules", "electron", "dist", "chrome-sandbox"));
    return stat.uid === 0 && (stat.mode & 0o4000) !== 0;
  } catch {
    return false;
  }
}

function launchElectron() {
  const binary = resolveElectronBinary();
  const electronArgs = [DESKTOP_DIR, ...ownArgs.filter((arg) => !arg.startsWith("--data-dir=")), ...passthrough];
  if (process.platform === "linux") {
    // 本机/CI 的 chrome-sandbox 通常不是 root:4755；沙箱不可用时显式关闭，
    // 否则 Electron 会在启动前 abort。生产安装包应随包正确设置 setuid helper。
    if (!sandboxHelperUsable() && !electronArgs.includes("--no-sandbox")) electronArgs.push("--no-sandbox");
    if (process.env.DISPLAY && !electronArgs.includes("--ozone-platform=x11")) {
      electronArgs.push("--ozone-platform=x11");
    }
    if (!electronArgs.includes("--disable-gpu")) electronArgs.push("--disable-gpu");
  }
  if (dataDirArg !== undefined) electronArgs.push(dataDirArg);
  console.log(`[build-desktop] 启动：${binary} ${electronArgs.join(" ")}`);
  const child = spawn(binary, electronArgs, { stdio: "inherit", env: { ...process.env } });
  child.on("exit", (code, signal) => {
    if (signal !== null) console.error(`[build-desktop] Electron 被信号终止：${signal}`);
    process.exitCode = code ?? 1;
  });
}

/** 沙箱/受限环境下 ~/.cache 可能只读；electron-builder 需要可写缓存目录。 */
function builderEnv() {
  const env = { ...process.env };
  try {
    accessSync(join(homedir(), ".cache"), constants.W_OK);
    return env;
  } catch {
    const cache = join(REPO_ROOT, ".tmp-cache");
    mkdirSync(cache, { recursive: true });
    console.log(`[build-desktop] ~/.cache 不可写，electron-builder 缓存重定向到 ${cache}`);
    return { ...env, XDG_CACHE_HOME: cache };
  }
}

function runBuilder() {
  const candidates = [
    join(DESKTOP_DIR, "node_modules", "electron-builder", "out", "cli", "cli.js"),
    join(REPO_ROOT, "node_modules", "electron-builder", "out", "cli", "cli.js"),
  ];
  const cli = candidates.find((candidate) => existsSync(candidate));
  if (cli === undefined) {
    console.error(
      "[build-desktop] 未安装 electron-builder，无法生成安装包。\n" +
        "  安装：cd packages/flowlet-desktop && npm install --save-dev electron-builder\n" +
        "  配置见 packages/flowlet-desktop/package.json 的 build 字段（linux AppImage+deb / win nsis+zip / mac dmg）。",
    );
    process.exitCode = 1;
    return;
  }
  const targets =
    process.platform === "win32"
      ? ["--win", "nsis", "zip"]
      : process.platform === "darwin"
        ? ["--mac", "dmg"]
        : ["--linux", "AppImage", "deb"];
  const status = run(process.execPath, [cli, ...targets], { cwd: DESKTOP_DIR, env: builderEnv() });
  if (status !== 0) process.exitCode = status;
}

function main() {
  buildFrontend();
  buildHost();
  if (dist) {
    runBuilder();
    return;
  }
  if (dev) launchElectron();
  else console.log("[build-desktop] 构建完成：dist-desktop + packages/flowlet-desktop/dist-host");
}

try {
  main();
} catch (error) {
  console.error("[build-desktop] 失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}