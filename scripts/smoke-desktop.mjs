// 桌面壳冒烟：xvfb 下启动 Electron，验证 Node Host /health、preload 桥、React 渲染，
// 并保存窗口截图。
//
// 前置：electron 44.7.0 已解压到 packages/flowlet-desktop/node_modules/electron/dist
//       （本机无系统 Electron，见 docs/desktop-electron.md）。
// 用法：node scripts/smoke-desktop.mjs [--keep-data]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DESKTOP_DIR = join(REPO_ROOT, "packages", "flowlet-desktop");
const ARTIFACT_DIR = join(REPO_ROOT, ".flowlet-dev-data", "desktop-smoke");
const PNG = join(ARTIFACT_DIR, "flowlet-desktop-smoke.png");
const URL_FILE = join(ARTIFACT_DIR, "web-url.txt");
const DATA_DIR = join(ARTIFACT_DIR, "data");

const keepData = process.argv.includes("--keep-data");

/** Electron 二进制在 ELECTRON_RUN_AS_NODE=1 时会被当成 Node 启动；冒烟必须清掉该变量。 */
function electronEnv() {
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function ensureFrontend() {
  if (!existsSync(join(REPO_ROOT, "dist-desktop", "index.html"))) {
    console.log("[smoke] 未找到 dist-desktop，先构建前端（失败时回退 dist-web）");
    const status = run(
      process.execPath,
      [join(SCRIPT_DIR, "build-desktop.mjs"), "--fallback-static"],
      { cwd: REPO_ROOT },
    );
    if (status !== 0) throw new Error("前端构建失败");
  }
}

function ensureHostBundle() {
  const status = run(
    process.execPath,
    [join(SCRIPT_DIR, "build-desktop.mjs"), "--no-frontend"],
    { cwd: REPO_ROOT },
  );
  if (status !== 0) throw new Error("宿主 bundle 构建失败");
}

function electronBinary() {
  for (const candidate of [
    join(DESKTOP_DIR, "node_modules", "electron", "dist", "electron"),
    join(DESKTOP_DIR, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("未找到 Electron 二进制；见 docs/desktop-electron.md 的手工解压步骤");
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function main() {
  ensureFrontend();
  ensureHostBundle();
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  if (!keepData) rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(PNG, { force: true });
  rmSync(URL_FILE, { force: true });

  const args = [
    "-a",
    "-s",
    "-screen 0 1280x800x24",
    electronBinary(),
    DESKTOP_DIR,
    "--no-sandbox",
    "--disable-gpu",
    "--ozone-platform=x11",
    `--screenshot=${PNG}`,
    `--print-url-file=${URL_FILE}`,
    `--data-dir=${DATA_DIR}`,
    "--screenshot-wait-ms=2200",
  ];
  console.log(`[smoke] 启动：xvfb-run ${args.join(" ")}`);
  const child = spawn("xvfb-run", args, {
    cwd: REPO_ROOT,
    env: electronEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderr += text;
    process.stderr.write(text);
  });

  const exitPromise = new Promise((resolveExit) => {
    child.on("exit", (code, signal) => resolveExit({ code, signal }));
  });

  // 轮询 web URL 并请求 /health；截图模式下应用会在截图后退出，所以两者并行。
  const health = { url: null, status: 0, body: "" };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (health.status === 0 && existsSync(URL_FILE)) {
      const url = readFileSync(URL_FILE, "utf8").trim();
      if (url !== "") {
        health.url = url;
        try {
          const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(3000) });
          health.status = response.status;
          health.body = (await response.text()).slice(0, 300);
        } catch {
          /* Host 尚未监听，重试 */
        }
      }
    }
    const finished = await Promise.race([exitPromise, wait(200).then(() => null)]);
    if (finished !== null) break;
  }

  const result = await exitPromise;
  const report = {
    exitCode: result.code,
    signal: result.signal,
    healthUrl: health.url,
    healthStatus: health.status,
    healthBody: health.body,
    screenshot: {
      path: PNG,
      exists: existsSync(PNG),
      bytes: existsSync(PNG) ? statSync(PNG).size : 0,
    },
    evidence: {
      webUrl: lineValue(stdout, "FLOWLET_WEB_URL="),
      windowLoaded: lineValue(stdout, "FLOWLET_WINDOW_LOADED="),
      uiTitle: lineValue(stdout, "FLOWLET_UI_TITLE="),
      uiTextLength: lineValue(stdout, "FLOWLET_UI_TEXT_LENGTH="),
      uiTextHead: lineValue(stdout, "FLOWLET_UI_TEXT_HEAD="),
      desktopBridge: lineValue(stdout, "FLOWLET_DESKTOP_BRIDGE="),
      adminTokenLength: lineValue(stdout, "FLOWLET_ADMIN_TOKEN_LENGTH="),
      screenshotLine: lineValue(stdout, "FLOWLET_SCREENSHOT="),
    },
  };
  console.log("\n===== SMOKE REPORT =====");
  console.log(JSON.stringify(report, null, 2));
  const ok =
    result.code === 0 &&
    health.status === 200 &&
    report.screenshot.exists &&
    report.screenshot.bytes > 1000 &&
    report.evidence.desktopBridge === "present" &&
    Number(report.evidence.adminTokenLength ?? 0) >= 24;
  if (!ok) {
    console.error("SMOKE FAILED");
    if (stderr.trim() !== "") console.error(stderr.slice(-4000));
    process.exitCode = 1;
    return;
  }
  console.log("SMOKE OK");
}

function lineValue(output, prefix) {
  const line = output.split("\n").find((item) => item.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

main().catch((error) => {
  console.error("[smoke] 失败：", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});