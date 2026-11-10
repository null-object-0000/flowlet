// 客户端模式端到端冒烟：
//   1. 起一个真实 Node Host（Flowlet Web Host，token 鉴权）当“远程主机”；
//   2. 以客户端模式启动 Electron（--mode=client --client-url --client-token），
//      走本机 Client Gateway（静态界面 + /api 反代）；
//   3. 逐路由截图并断言没有 console error / 失败命令，页面读到远程数据。
//
// 用法：
//   node scripts/smoke-desktop-client.mjs                 # 远程库用既有测试库（若存在）
//   node scripts/smoke-desktop-client.mjs --remote-db=<sqlite>
//   node scripts/smoke-desktop-client.mjs --routes=/models,/logs
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DESKTOP_DIR = join(REPO_ROOT, "packages", "flowlet-desktop");
const ARTIFACT_DIR = join(REPO_ROOT, ".flowlet-dev-data", "desktop-client");
const CLIENT_DATA_DIR = join(ARTIFACT_DIR, "client-data");
const REMOTE_DIR = join(ARTIFACT_DIR, "remote");
const REPORT_FILE = join(ARTIFACT_DIR, "report.json");
const URL_FILE = join(ARTIFACT_DIR, "web-url.txt");
const ADMIN_TOKEN = "flowlet-client-smoke-admin-token-0123456789";

const routesArg = process.argv.find((arg) => arg.startsWith("--routes="));
const routes = routesArg === undefined ? null : routesArg.slice("--routes=".length);
const dbArg = process.argv.find((arg) => arg.startsWith("--remote-db="));
const remoteDbSource =
  dbArg !== undefined
    ? resolve(dbArg.slice("--remote-db=".length))
    : join(REPO_ROOT, ".flowlet-dev-data", "inherit-db", "data", "flowlet.sqlite");

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", rejectRun);
    child.on("exit", (code) => resolveRun(code ?? 1));
  });
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

function electronEnv() {
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

/** 远程 Host 引导脚本：startHost 后打印真实监听地址，保持运行直到被终止。 */
const REMOTE_BOOTSTRAP = `import { startHost } from ${JSON.stringify(join(REPO_ROOT, "packages/flowlet-core/src/index.ts"))};
const host = await startHost({
  dbPath: process.env.FLOWLET_DB_PATH,
  configPath: process.env.FLOWLET_CONFIG_PATH,
  catalogDir: process.env.FLOWLET_CATALOG_DIR,
  staticDir: process.env.FLOWLET_STATIC_DIR,
  adminToken: process.env.FLOWLET_ADMIN_TOKEN,
  clientToken: process.env.FLOWLET_CLIENT_TOKEN ?? "",
  bindAddr: process.env.FLOWLET_BIND_ADDR,
  webAddr: "127.0.0.1:0",
  publicProxyUrl: "",
});
console.log("FLOWLET_REMOTE_WEB_ADDR=" + host.webAddr);
const stop = async () => { await host.close(); process.exit(0); };
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
`;

async function main() {
  // 1. 构建（前端 + 宿主 bundle）
  if (!existsSync(join(REPO_ROOT, "dist-desktop", "index.html"))) {
    const code = await run(process.execPath, [join(SCRIPT_DIR, "build-desktop.mjs"), "--fallback-static"], { cwd: REPO_ROOT });
    if (code !== 0) throw new Error("前端构建失败");
  }
  const hostBuild = await run(process.execPath, [join(SCRIPT_DIR, "build-desktop.mjs"), "--no-frontend"], { cwd: REPO_ROOT });
  if (hostBuild !== 0) throw new Error("宿主 bundle 构建失败");
  // 远程 Web Host 需要 dist-web 管理台（远程自己的界面只用于 SSO 登录页，API 默认即可）。
  if (!existsSync(join(REPO_ROOT, "dist-web", "index.html"))) {
    const webBuild = await run("npm", ["run", "build:web"], { cwd: REPO_ROOT });
    if (webBuild !== 0) throw new Error("dist-web 构建失败");
  }

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  rmSync(CLIENT_DATA_DIR, { recursive: true, force: true });
  rmSync(REMOTE_DIR, { recursive: true, force: true });
  mkdirSync(CLIENT_DATA_DIR, { recursive: true });
  mkdirSync(REMOTE_DIR, { recursive: true });
  rmSync(REPORT_FILE, { force: true });
  rmSync(URL_FILE, { force: true });

  const remoteDb = join(REMOTE_DIR, "flowlet.sqlite");
  if (existsSync(remoteDbSource)) {
    copyFileSync(remoteDbSource, remoteDb);
    console.log(`[client-smoke] 远程库使用既有数据副本：${remoteDbSource}`);
  } else {
    console.log("[client-smoke] 未找到既有数据库，远程库为空（走新用户空状态）");
  }

  const bootstrapFile = join(REMOTE_DIR, "remote-host.mjs");
  writeFileSync(bootstrapFile, REMOTE_BOOTSTRAP, "utf8");

  // 2. 启动远程 Host
  const remote = spawn(process.execPath, [bootstrapFile], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      FLOWLET_DB_PATH: remoteDb,
      FLOWLET_CONFIG_PATH: join(REMOTE_DIR, "config.json"),
      FLOWLET_CATALOG_DIR: REMOTE_DIR,
      FLOWLET_STATIC_DIR: join(REPO_ROOT, "dist-web"),
      FLOWLET_ADMIN_TOKEN: ADMIN_TOKEN,
      FLOWLET_BIND_ADDR: "127.0.0.1:0",
      FLOWLET_DISABLE_BACKGROUND_TASKS: "1",
      ELECTRON_RUN_AS_NODE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let remoteAddr = null;
  let remoteLog = "";
  remote.stdout.on("data", (chunk) => {
    const text = String(chunk);
    remoteLog += text;
    process.stdout.write(text);
    const match = /FLOWLET_REMOTE_WEB_ADDR=(\S+)/.exec(text);
    if (match) remoteAddr = match[1];
  });
  remote.stderr.on("data", (chunk) => {
    remoteLog += String(chunk);
    process.stderr.write(String(chunk));
  });
  const deadline = Date.now() + 30_000;
  while (remoteAddr === null && Date.now() < deadline) {
    await new Promise((wait) => setTimeout(wait, 150));
    if (remote.exitCode !== null) break;
  }
  if (remoteAddr === null) {
    remote.kill("SIGKILL");
    throw new Error(`远程 Host 未就绪：\n${remoteLog.slice(-2000)}`);
  }
  const remoteUrl = `http://${remoteAddr}`;
  console.log(`[client-smoke] 远程 Host：${remoteUrl}`);

  // 3. 以客户端模式启动 Electron，逐路由冒烟
  const args = [
    "-a",
    "-s",
    "-screen 0 1280x800x24",
    electronBinary(),
    DESKTOP_DIR,
    "--no-sandbox",
    "--disable-gpu",
    "--ozone-platform=x11",
    "--mode=client",
    `--client-url=${remoteUrl}`,
    `--client-token=${ADMIN_TOKEN}`,
    `--pages=${ARTIFACT_DIR}`,
    `--print-url-file=${URL_FILE}`,
    `--data-dir=${CLIENT_DATA_DIR}`,
    "--screenshot-wait-ms=1400",
  ];
  if (routes !== null) args.push(`--routes=${routes}`);
  console.log(`[client-smoke] 启动：xvfb-run ${args.join(" ")}`);
  const electron = spawn("xvfb-run", args, {
    cwd: REPO_ROOT,
    env: electronEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let electronOut = "";
  let electronErr = "";
  electron.stdout.on("data", (chunk) => {
    electronOut += String(chunk);
    process.stdout.write(String(chunk));
  });
  electron.stderr.on("data", (chunk) => {
    electronErr += String(chunk);
    process.stderr.write(String(chunk));
  });
  const health = { status: 0, body: "" };
  const healthPoll = (async () => {
    const healthDeadline = Date.now() + 60_000;
    while (Date.now() < healthDeadline && electron.exitCode === null) {
      if (existsSync(URL_FILE)) {
        const url = readFileSync(URL_FILE, "utf8").trim();
        if (url !== "") {
          try {
            const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(2000) });
            health.status = response.status;
            health.body = (await response.text()).slice(0, 200);
            return;
          } catch {
            /* 继续等 */
          }
        }
      }
      await new Promise((wait) => setTimeout(wait, 200));
    }
  })();
  const result = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      console.error("[client-smoke] 超时（180s），终止 Electron");
      electron.kill("SIGKILL");
    }, 180_000);
    electron.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
  await healthPoll;
  remote.kill("SIGTERM");

  const report = readReport();
  const summary = {
    exitCode: result.code,
    signal: result.signal,
    remoteUrl,
    health,
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
  console.log("\n===== CLIENT SMOKE REPORT =====");
  console.log(JSON.stringify(summary, null, 2));

  const ok =
    result.code === 0 &&
    health.status === 200 &&
    report !== null &&
    report.routes.length > 0 &&
    summary.failures.length === 0 &&
    report.routes.every(
      (item) => item.screenshot !== null && existsSync(item.screenshot) && statSync(item.screenshot).size > 1000,
    );
  if (!ok) {
    console.error("CLIENT SMOKE FAILED");
    if (electronErr.trim() !== "") console.error(electronErr.slice(-4000));
    process.exitCode = 1;
    return;
  }
  console.log(`CLIENT SMOKE OK (${report.routes.length} routes)`);
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
  console.error("[client-smoke] 失败：", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
