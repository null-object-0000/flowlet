// 桌面逐路由冒烟：启动 Electron（xvfb），依次切换全部桌面路由，逐页截图并采集
// console error 与失败命令（HTTP >= 400），输出报告与门禁结论。
//
// 用途：迁移期防止「命令都实现了，但某个页面在 Electron 里仍然渲染失败」。
// 前置与 smoke-desktop.mjs 相同（electron 二进制手工安装，见 docs/desktop-electron.md）。
//
// 用法：
//   node scripts/smoke-desktop-pages.mjs                 # 空数据库（新用户路径）
//   node scripts/smoke-desktop-pages.mjs --db=<sqlite>   # 用已有数据库副本（老用户路径）
//   node scripts/smoke-desktop-pages.mjs --keep-data     # 保留上次数据目录
//   node scripts/smoke-desktop-pages.mjs --routes=/models,/logs
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DESKTOP_DIR = join(REPO_ROOT, "packages", "flowlet-desktop");
const ARTIFACT_DIR = join(REPO_ROOT, ".flowlet-dev-data", "desktop-pages");
const DATA_DIR = join(ARTIFACT_DIR, "data");
const URL_FILE = join(ARTIFACT_DIR, "web-url.txt");
const REPORT_FILE = join(ARTIFACT_DIR, "report.json");

const keepData = process.argv.includes("--keep-data");
const dbArg = process.argv.find((arg) => arg.startsWith("--db="));
const sourceDb = dbArg === undefined ? null : resolve(dbArg.slice("--db=".length));
const routesArg = process.argv.find((arg) => arg.startsWith("--routes="));
const routes = routesArg === undefined ? null : routesArg.slice("--routes=".length);

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

function ensureBuild() {
  if (!existsSync(join(REPO_ROOT, "dist-desktop", "index.html"))) {
    console.log("[pages] 未找到 dist-desktop，先构建前端");
    if (run(process.execPath, [join(SCRIPT_DIR, "build-desktop.mjs"), "--fallback-static"], { cwd: REPO_ROOT }) !== 0) {
      throw new Error("前端构建失败");
    }
  }
  if (run(process.execPath, [join(SCRIPT_DIR, "build-desktop.mjs"), "--no-frontend"], { cwd: REPO_ROOT }) !== 0) {
    throw new Error("宿主 bundle 构建失败");
  }
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
  ensureBuild();
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  if (!keepData) rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  rmSync(REPORT_FILE, { force: true });
  rmSync(URL_FILE, { force: true });

  if (sourceDb !== null) {
    if (!existsSync(sourceDb)) throw new Error(`数据库不存在：${sourceDb}`);
    copyFileSync(sourceDb, join(DATA_DIR, "flowlet.sqlite"));
    console.log(`[pages] 使用已有数据库副本：${sourceDb}`);
  }

  const args = [
    "-a",
    "-s",
    "-screen 0 1280x800x24",
    electronBinary(),
    DESKTOP_DIR,
    "--no-sandbox",
    "--disable-gpu",
    "--ozone-platform=x11",
    `--pages=${ARTIFACT_DIR}`,
    `--print-url-file=${URL_FILE}`,
    `--data-dir=${DATA_DIR}`,
    "--screenshot-wait-ms=1400",
  ];
  if (routes !== null) args.push(`--routes=${routes}`);
  console.log(`[pages] 启动：xvfb-run ${args.join(" ")}`);
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

  // 与子进程并行探测 /health：逐路由跑完应用会退出，之后端口关闭。
  const healthPromise = probeHealth(child);
  const result = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      console.error("[pages] 超时（180s），终止 Electron");
      child.kill("SIGKILL");
    }, 180_000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
  const health = await healthPromise;
  const report = readReport();
  const summary = {
    exitCode: result.code,
    signal: result.signal,
    health,
    reportPath: existsSync(REPORT_FILE) ? REPORT_FILE : null,
    routes: report?.routes?.map((item) => ({
      route: item.route,
      ok: item.ok,
      hash: item.hash,
      textLength: item.mainTextLength,
      consoleErrors: item.consoleErrors.length,
      commandFailures: item.commandFailures.length,
      screenshot: item.screenshot,
    })) ?? [],
    failures: report?.routes?.filter((item) => !item.ok).map((item) => ({
      route: item.route,
      consoleErrors: item.consoleErrors,
      commandFailures: item.commandFailures,
    })) ?? [],
  };
  console.log("\n===== PAGES REPORT =====");
  console.log(JSON.stringify(summary, null, 2));

  const ok =
    result.code === 0 &&
    health.status === 200 &&
    report !== null &&
    report.routes.length > 0 &&
    summary.failures.length === 0 &&
    report.routes.every((item) => item.screenshot !== null && existsSync(item.screenshot) && statSync(item.screenshot).size > 1000);
  if (!ok) {
    console.error("PAGES SMOKE FAILED");
    if (stderr.trim() !== "") console.error(stderr.slice(-4000));
    process.exitCode = 1;
    return;
  }
  console.log(`PAGES SMOKE OK (${report.routes.length} routes)`);
}

async function probeHealth(child) {
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !exited) {
    if (existsSync(URL_FILE)) {
      const url = readFileSync(URL_FILE, "utf8").trim();
      if (url !== "") {
        try {
          const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(3000) });
          return { url, status: response.status, body: (await response.text()).slice(0, 300) };
        } catch {
          /* Host 已退出（逐路由跑完后关闭），继续重试到超时 */
        }
      }
    }
    await wait(200);
  }
  return { url: null, status: 0, body: "" };
}

function readReport() {
  if (!existsSync(REPORT_FILE)) return null;
  try {
    return JSON.parse(readFileSync(REPORT_FILE, "utf8"));
  } catch {
    return null;
  }
}

main().catch((error) => {
  console.error("[pages] 失败：", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
