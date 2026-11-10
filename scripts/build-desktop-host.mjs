// 构建 Flowlet 桌面宿主 bundle。
//
// 产物（packages/flowlet-desktop/dist-host/）：
//   main.mjs         Electron 主进程（窗口/托盘/宿主通道）
//   core-host.mjs    flowlet-core startHost（独立 bundle，避免 import.meta.url 冲突）
//   preload.cjs      渲染进程 contextBridge
//   runtime/         flowlet-core 运行时资源 + worker
//
// 为什么 core-host 单独 bundle：flowlet-core 内部用 `import.meta.url` 定位
// config/model 目录与 capture-cleanup worker。bundle 后这些路径会指向 dist-host，
// 因此用 esbuild 插件把它们重写到 `FLOWLET_RUNTIME_ROOT_URL` 下的虚拟目录树
// （packages/flowlet-core/src/...），运行期只要求 runtime/ 存在对应资源文件。
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DESKTOP_DIR = join(REPO_ROOT, "packages", "flowlet-desktop");
const CORE_SRC = join(REPO_ROOT, "packages", "flowlet-core", "src");
const OUT_DIR = join(DESKTOP_DIR, "dist-host");
const RUNTIME_DIR = join(OUT_DIR, "runtime");

const requireFromDesktop = createRequire(join(DESKTOP_DIR, "package.json"));
const { build } = requireFromDesktop("esbuild");

const CORE_RUNTIME_URL = "(process.env.FLOWLET_RUNTIME_ROOT_URL + ";

/** flowlet-core 的 import.meta.url → runtime 虚拟目录树。 */
const coreImportMetaPlugin = {
  name: "flowlet-core-runtime-url",
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /packages[\\/]flowlet-core[\\/]src[\\/].*\.ts$/ }, async (args) => {
      let source = await readFileSync(args.path, "utf8");
      const rel = relative(CORE_SRC, args.path).split(sep).join("/");
      const runtimeFileUrl = `${CORE_RUNTIME_URL}"/packages/flowlet-core/src/${rel}")`;
      source = source.split("import.meta.url").join(runtimeFileUrl);
      // scheduler 用 `new URL("./capture-cleanup-worker.ts", import.meta.url)`；
      // 运行时只有打包后的 .mjs worker，必须同步改扩展名。
      source = source.split('"./capture-cleanup-worker.ts"').join('"./capture-cleanup-worker.mjs"');
      return { contents: source, loader: "ts", resolveDir: dirname(args.path) };
    });
  },
};

function copyIfExists(source, target) {
  if (!existsSync(source)) return false;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  return true;
}

function copyRuntimeResources() {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const copied = [];
  for (const name of ["config.json", "model-catalog.json", "package.json"]) {
    if (copyIfExists(join(REPO_ROOT, name), join(RUNTIME_DIR, name))) copied.push(name);
  }
  // models-cn / models-dev：构建时由 src-tauri 目录提供（与 tauri:build 的抓取产物一致）。
  for (const name of ["models-cn.json", "models-dev.json"]) {
    const source = join(REPO_ROOT, "src-tauri", name);
    if (copyIfExists(source, join(RUNTIME_DIR, name))) copied.push(name);
  }
  // 图标：托盘 + 打包用。
  const iconDir = join(RUNTIME_DIR, "icons");
  for (const name of ["tray.png", "icon.png", "icon.ico", "icon.icns"]) {
    copyIfExists(join(REPO_ROOT, "src-tauri", "icons", name), join(iconDir, name));
  }
  // 自定义抓取描述符（如果仓库根存在）。
  const customScrape = join(REPO_ROOT, "custom-scrape");
  if (existsSync(customScrape)) {
    mkdirSync(join(RUNTIME_DIR, "custom-scrape"), { recursive: true });
    for (const name of readdirSafe(customScrape)) copyIfExists(join(customScrape, name), join(RUNTIME_DIR, "custom-scrape", name));
  }
  // electron-builder 的 buildResources 目录。
  const buildIcons = join(DESKTOP_DIR, "build");
  mkdirSync(join(buildIcons, "icons"), { recursive: true });
  copyIfExists(join(REPO_ROOT, "src-tauri", "icons", "icon.png"), join(buildIcons, "icon.png"));
  copyIfExists(join(REPO_ROOT, "src-tauri", "icons", "icon.ico"), join(buildIcons, "icon.ico"));
  copyIfExists(join(REPO_ROOT, "src-tauri", "icons", "icon.icns"), join(buildIcons, "icon.icns"));
  copyIfExists(join(REPO_ROOT, "src-tauri", "icons", "icon.png"), join(buildIcons, "icons", "512x512.png"));
  console.log(`[build-desktop-host] runtime 资源：${copied.join(", ")}`);
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

async function buildCoreHost() {
  await build({
    entryPoints: [join(DESKTOP_DIR, "src", "core-host.ts")],
    outfile: join(OUT_DIR, "core-host.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: false,
    logLevel: "info",
    plugins: [coreImportMetaPlugin],
    // jsonc-parser 等包同时提供 UMD(main) 与 ESM(module)；Node 平台的 esbuild 默认
    // 选 main，会把 UMD 的 `require("./impl/format")` 留在 bundle 里导致运行期
    // "Cannot find module './impl/format'"。优先 module 字段，让依赖整体内联。
    mainFields: ["module", "main"],
    // esbuild 的 ESM 输出遇到 CJS 依赖（undici 等）会生成 __require 兜底；没有
    // Node 的 require 时会抛 "Dynamic require is not supported"。注入 createRequire
    // 让主进程 bundle 内的 require 正常工作。
    banner: {
      js: 'import { createRequire as __flowletCreateRequire } from "node:module"; const require = __flowletCreateRequire(import.meta.url);',
    },
    // Electron 内置 Node 24；undici 由 npm 依赖提供并打进 bundle。
    external: ["electron"],
  });
}

async function buildMain() {
  await build({
    entryPoints: [join(DESKTOP_DIR, "src", "main.ts")],
    outfile: join(OUT_DIR, "main.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: false,
    logLevel: "info",
    // core-host 必须保持独立文件：它内部有 import.meta.url 重写插件。
    external: ["electron", "./core-host.mjs"],
  });
}

async function buildModePreload() {
  await build({
    entryPoints: [join(DESKTOP_DIR, "src", "mode-preload.ts")],
    outfile: join(OUT_DIR, "preload-mode.cjs"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node24",
    sourcemap: false,
    logLevel: "info",
    external: ["electron"],
  });
}

async function buildPreload() {
  await build({
    entryPoints: [join(DESKTOP_DIR, "src", "preload.ts")],
    outfile: join(OUT_DIR, "preload.cjs"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node24",
    sourcemap: false,
    logLevel: "info",
    external: ["electron"],
  });
}

async function buildWorker() {
  const outfile = join(RUNTIME_DIR, "packages", "flowlet-core", "src", "host", "capture-cleanup-worker.mjs");
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [join(CORE_SRC, "host", "capture-cleanup-worker.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: false,
    logLevel: "info",
    plugins: [coreImportMetaPlugin],
    // jsonc-parser 等包同时提供 UMD(main) 与 ESM(module)；Node 平台的 esbuild 默认
    // 选 main，会把 UMD 的 `require("./impl/format")` 留在 bundle 里导致运行期
    // "Cannot find module './impl/format'"。优先 module 字段，让依赖整体内联。
    mainFields: ["module", "main"],
    // esbuild 的 ESM 输出遇到 CJS 依赖（undici 等）会生成 __require 兜底；没有
    // Node 的 require 时会抛 "Dynamic require is not supported"。注入 createRequire
    // 让主进程 bundle 内的 require 正常工作。
    banner: {
      js: 'import { createRequire as __flowletCreateRequire } from "node:module"; const require = __flowletCreateRequire(import.meta.url);',
    },
  });
}

async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  copyRuntimeResources();
  await Promise.all([buildMain(), buildCoreHost(), buildPreload(), buildModePreload(), buildWorker()]);
  console.log(
    "[build-desktop-host] 完成：dist-host/main.mjs core-host.mjs preload.cjs preload-mode.cjs runtime/",
  );
}

main().catch((error) => {
  console.error("[build-desktop-host] 构建失败", error);
  process.exitCode = 1;
});