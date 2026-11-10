// 桌面数据目录与运行时资源解析。
//
// 目标：与 Rust/Tauri 版本使用同一份数据，用户升级后不丢账号/日志/登录态。
// 权威行为：
// - `src-tauri/src/lib.rs::app_database_path`：SQLite 始终在 exe 同级目录；
// - `src-tauri/src/core/webview_profile.rs`：便携版（exe 旁 `portable.tag`）WebView
//   数据根为 `exe/data/webview`，安装版为 Tauri `app_local_data_dir`（Windows
//   `%LOCALAPPDATA%`，Linux `$XDG_DATA_HOME`，macOS `~/Library/Application Support`）；
// - `scripts/build-portable.mjs`：复制 config 并写入 `portable.tag`。
//
// Electron 的默认 `userData` 在 `%APPDATA%`/`~/.config`，因此必须在 `app.ready`
// 之前显式重定向（`app.setPath("userData")` / `app.setPath("sessionData")`）。
import { app } from "electron";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_IDENTIFIER = "site.snewbie.flowlet";

/** 随包内置、首次启动复制到数据目录的文件（与 Rust setup 的复制行为一致）。 */
const BUNDLED_DATA_FILES = ["config.json", "model-catalog.json", "models-cn.json", "models-dev.json"];

export interface DesktopPaths {
  readonly repoRoot: string;
  /** SQLite / config / 日志 / 凭据密文所在目录。 */
  readonly dataDir: string;
  readonly configPath: string;
  readonly dbPath: string;
  readonly catalogDir: string;
  /** flowlet-core 运行时资源根（含 config/model 目录与 worker）。 */
  readonly runtimeRoot: string;
  /** 前端 `dist-desktop` 静态资源目录。 */
  readonly staticDir: string;
  /** WebView（主窗口 + 抓取 partition）数据根。 */
  readonly webviewRoot: string;
  readonly logDir: string;
  readonly portable: boolean;
}

function isRepoRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { workspaces?: unknown };
    return pkg.workspaces !== undefined;
  } catch {
    return false;
  }
}

/** 开发模式下从 dist-host/main.mjs 向上找仓库根。打包后不使用。 */
function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (isRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start, "../../..");
}

function isWritableDirectory(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}`);
    writeFileSync(probe, "ok");
    accessSync(probe, constants.W_OK);
    try {
      rmSync(probe, { force: true });
    } catch {
      /* 忽略：探测文件残留不影响功能 */
    }
    return true;
  } catch {
    return false;
  }
}

/** Tauri `app_local_data_dir` 的等价目录（Windows 用 LOCALAPPDATA 而非 APPDATA）。 */
export function tauriLocalDataDir(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) return join(local, APP_IDENTIFIER);
    return join(app.getPath("appData"), APP_IDENTIFIER);
  }
  if (process.platform === "darwin") {
    return join(app.getPath("appData"), APP_IDENTIFIER);
  }
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg && xdg !== "" ? xdg : join(homedir(), ".local", "share"), APP_IDENTIFIER);
}

function ensureBundledResources(dataDir: string, runtimeRoot: string): void {
  for (const name of BUNDLED_DATA_FILES) {
    const target = join(dataDir, name);
    if (existsSync(target)) continue;
    const source = join(runtimeRoot, name);
    if (!existsSync(source)) continue;
    copyFileSync(source, target);
  }
}

export interface ResolveDesktopPathsOptions {
  /** 测试/冒烟时覆盖数据目录（仍不写 userData）。 */
  readonly dataDirOverride?: string;
}

export function resolveDesktopPaths(options: ResolveDesktopPathsOptions = {}): DesktopPaths {
  const packaged = app.isPackaged;
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = packaged ? resolve(app.getAppPath()) : findRepoRoot(here);

  let dataDir: string;
  let portable = false;
  if (options.dataDirOverride) {
    dataDir = resolve(options.dataDirOverride);
  } else if (packaged) {
    const exeDir = dirname(app.getPath("exe"));
    portable = existsSync(join(exeDir, "portable.tag"));
    dataDir = exeDir;
    if (!isWritableDirectory(dataDir)) {
      // 安装到 Program Files / /usr/bin 时 exe 目录不可写。Rust 版同样会失败，
      // 但 Electron 安装版不能因此无法启动：降级到本机应用数据目录并告警。
      const fallback = tauriLocalDataDir();
      mkdirSync(fallback, { recursive: true });
      console.warn(`[flowlet-desktop] exe 目录不可写，数据目录降级到 ${fallback}`);
      dataDir = fallback;
    }
  } else {
    dataDir = join(repoRoot, ".flowlet-dev-data", "desktop");
  }
  mkdirSync(dataDir, { recursive: true });

  const runtimeRoot = packaged
    ? join(process.resourcesPath, "runtime")
    : join(repoRoot, "packages", "flowlet-desktop", "dist-host", "runtime");
  ensureBundledResources(dataDir, runtimeRoot);

  const webviewRoot = options.dataDirOverride
    ? join(dataDir, "webview")
    : packaged
      ? portable
        ? join(dataDir, "data", "webview")
        : tauriLocalDataDir()
      : join(dataDir, "webview");
  mkdirSync(webviewRoot, { recursive: true });

  const staticDir = packaged
    ? join(process.resourcesPath, "desktop-static")
    : join(repoRoot, "dist-desktop");
  const logDir = join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });

  const configPath = join(dataDir, "config.json");
  const dbPath = join(dataDir, "flowlet.sqlite");
  migrateLegacyDatabase(dbPath);

  return {
    repoRoot,
    dataDir,
    configPath,
    dbPath,
    catalogDir: dataDir,
    runtimeRoot,
    staticDir,
    webviewRoot,
    logDir,
    portable,
  };
}

/**
 * Rust `migrate_legacy_database`：老版本可能把 `flowlet.sqlite` 放在当前工作目录，
 * 首次升级时复制到 exe 旁。只在目标不存在时执行。
 */
function migrateLegacyDatabase(dbPath: string): void {
  if (existsSync(dbPath)) return;
  const legacy = join(process.cwd(), "flowlet.sqlite");
  if (!existsSync(legacy)) return;
  try {
    copyFileSync(legacy, dbPath);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${legacy}${suffix}`;
      if (existsSync(sidecar)) copyFileSync(sidecar, `${dbPath}${suffix}`);
    }
    console.warn(`[flowlet-desktop] 已把旧数据库从 ${legacy} 迁移到 ${dbPath}`);
  } catch (error) {
    console.warn(
      `[flowlet-desktop] 迁移旧数据库失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 在 app ready 前调用：把 Chromium/主窗口状态放回 Tauri 相同位置。 */
export function applyElectronStoragePaths(paths: DesktopPaths): void {
  // 主 WebView 与 Rust `main-webview` 对齐；sessionData 让 persist: partition 落到
  // webviewRoot/Partitions 下（目录名与 Rust 不同，但同样 per-account 隔离）。
  app.setPath("userData", join(paths.webviewRoot, "main-webview"));
  app.setPath("sessionData", paths.webviewRoot);
  mkdirSync(app.getPath("userData"), { recursive: true });
}

/** 主窗口 session 的 partition；与 Rust 主 WebView 独立目录语义一致。 */
export const MAIN_WINDOW_PARTITION = "persist:main-webview";
