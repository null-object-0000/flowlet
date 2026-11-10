// 便携版一键更新：构建 -> 停止当前实例 -> 覆盖程序文件 -> 重新启动。
//
// 同时支持两种程序布局：
//   - tauri    ：Rust/Tauri 版（可执行文件 flowlet(.exe) + flowlet_lib.*，产物来自 src-tauri/target/release）
//   - electron ：新桌面端（可执行文件 Flowlet(.exe) + resources/app.asar，产物来自 packages/flowlet-desktop/release）
//
// 用法：
//   npm run desktop:update:portable                   # 更新 Electron 便携版（自动识别目录）
//   npm run tauri:update:portable                     # 更新 Tauri 便携版（旧）
//   node scripts/update-portable.mjs --layout auto    # 两种都能认
//   node scripts/update-portable.mjs --target <目录>  # 显式指定
//
// 选项：
//   --layout <auto|tauri|electron>  程序布局，默认 auto（按目标目录/运行进程判断）
//   --target <目录>                 显式指定需要更新的便携版目录
//   --replace-config                用仓库 config.json 覆盖目标配置
//   --no-restart                    更新完成后不重新启动
//   --skip-build                    跳过构建，直接用现有便携版产物覆盖
//   --dry-run                       只显示识别结果，不构建、不停止、不覆盖
//   --help                          显示帮助

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const PACKAGE_JSON = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
const VERSION = PACKAGE_JSON.version;
const ARCH = process.env.TAURI_ENV_ARCH
  ?? process.arch.replace("x86_", "x").replace("x86", "x64");
const PLATFORM = process.platform;

/** 两套布局的差异集中在这里：可执行文件名、产物目录、构建脚本、覆盖策略。 */
const LAYOUTS = {
  tauri: {
    key: "tauri",
    executable: PLATFORM === "win32" ? "flowlet.exe" : "flowlet",
    directoryName: PLATFORM === "win32"
      ? `Flowlet_${VERSION}_${ARCH}_portable`
      : `Flowlet_${VERSION}_linux_${ARCH}_portable`,
    buildScript: "tauri:build:portable",
    buildRoot: join(PROJECT_ROOT, "src-tauri", "target", "release", "bundle", "portable"),
    // Tauri 便携版是「程序 + 库 + 模型目录」的扁平文件集合。
    payloadFiles: PLATFORM === "win32"
      ? ["flowlet.exe", "flowlet_lib.dll", "models-cn.json", "models-dev.json", "portable.tag"]
      : [
          "flowlet",
          "libflowlet_lib.so",
          "models-cn.json",
          "models-dev.json",
          "portable.tag",
          "flowlet.png",
          "install-desktop-entry.sh",
        ],
    marker: (dir) => existsSync(join(dir, "flowlet_lib.dll"))
      || existsSync(join(dir, "libflowlet_lib.so"))
      || existsSync(join(dir, "flowlet.exe")),
  },
  electron: {
    key: "electron",
    executable: PLATFORM === "win32" ? "Flowlet.exe" : "flowlet",
    directoryName: PLATFORM === "win32"
      ? `Flowlet_${VERSION}_win32_${ARCH}_portable`
      : `Flowlet_${VERSION}_linux_${ARCH}_portable`,
    buildScript: "desktop:portable",
    buildRoot: join(PROJECT_ROOT, "packages", "flowlet-desktop", "release", "portable"),
    // Electron 便携版是整棵应用目录（exe + resources/ + locales/ …），按目录覆盖。
    payloadFiles: null,
    marker: (dir) => existsSync(join(dir, "resources", "app.asar")),
  },
};

/** Electron 覆盖时不能碰的东西：数据、配置、便携标记。 */
const ELECTRON_PRESERVE = new Set([
  "portable.tag",
  "config.json",
  "desktop-config.json",
  "flowlet.sqlite",
  "flowlet.sqlite-wal",
  "flowlet.sqlite-shm",
  "data",
  "logs",
]);

function printHelp() {
  console.log(`Flowlet 便携版一键更新

用法：
  npm run desktop:update:portable            # Electron 桌面端
  npm run tauri:update:portable              # Tauri 版本（旧）
  node scripts/update-portable.mjs --target <便携版目录>

选项：
  --layout <auto|tauri|electron>  程序布局（默认 auto）
  --target <目录>                 显式指定需要更新的便携版目录
  --replace-config                同时用仓库 config.json 覆盖目标配置
  --no-restart                    更新完成后不重新启动 Flowlet
  --skip-build                    跳过构建，直接用现有便携版产物覆盖
  --dry-run                       只显示识别结果，不构建、不停止、不覆盖
  --help                          显示帮助`);
}

function parseArgs(argv) {
  const options = {
    target: null,
    layout: "auto",
    replaceConfig: false,
    restart: true,
    skipBuild: false,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--target 后必须提供目录");
      options.target = resolve(value);
      index += 1;
    } else if (arg === "--layout") {
      const value = argv[index + 1];
      if (value !== "auto" && value !== "tauri" && value !== "electron") {
        throw new Error("--layout 只能是 auto / tauri / electron");
      }
      options.layout = value;
      index += 1;
    } else if (arg === "--replace-config") {
      options.replaceConfig = true;
    } else if (arg === "--no-restart") {
      options.restart = false;
    } else if (arg === "--skip-build") {
      options.skipBuild = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  return options;
}

function runPowerShell(command) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { cwd: PROJECT_ROOT, encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `PowerShell 执行失败（退出码 ${result.status}）`);
  }
  return result.stdout.trim();
}

/** 列出正在运行的 Flowlet（两种布局一起扫，名字可能重复 → 用可执行文件路径区分）。 */
function listFlowletProcesses() {
  const names = new Set([LAYOUTS.tauri.executable, LAYOUTS.electron.executable]);

  if (PLATFORM === "linux") {
    return readdirSync("/proc", { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .flatMap((entry) => {
        try {
          const executablePath = readlinkSync(join("/proc", entry.name, "exe"));
          if (executablePath.endsWith(" (deleted)")) return [];
          if (!names.has(basename(executablePath))) return [];
          return [{ pid: Number(entry.name), executablePath: resolve(executablePath) }];
        } catch {
          return [];
        }
      });
  }

  const filter = [...names].map((name) => `Name = '${name}'`).join(" or ");
  const output = runPowerShell(
    `$items = @(Get-CimInstance Win32_Process -Filter "${filter}" | `
      + "Select-Object ProcessId, ExecutablePath); "
      + "if ($items.Count -gt 0) { $items | ConvertTo-Json -Compress }",
  );
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter((item) => typeof item.ExecutablePath === "string" && item.ExecutablePath.length > 0)
    .map((item) => ({ pid: Number(item.ProcessId), executablePath: resolve(item.ExecutablePath) }));
}

function samePath(left, right) {
  if (PLATFORM === "win32") {
    return resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US");
  }
  return resolve(left) === resolve(right);
}

/** 按目录内容判断这是哪套布局。 */
function detectLayoutByDir(dir) {
  for (const layout of Object.values(LAYOUTS)) {
    if (layout.marker(dir)) return layout;
  }
  return null;
}

/** 目标目录：显式 → 运行中的便携版（含 portable.tag）→ Linux 桌面启动器。 */
function resolveTargetDirectory(explicitTarget, processes) {
  if (explicitTarget) return explicitTarget;

  const portableProcesses = processes.filter((processInfo) => (
    existsSync(join(dirname(processInfo.executablePath), "portable.tag"))
  ));
  if (portableProcesses.length === 0 && processes.length > 0) {
    throw new Error("检测到运行中的 Flowlet，但其程序目录没有 portable.tag，不会覆盖非便携版安装。");
  }

  const directories = [...new Set(
    portableProcesses.map((processInfo) => {
      const directory = dirname(processInfo.executablePath);
      return PLATFORM === "win32" ? directory.toLocaleLowerCase("en-US") : directory;
    }),
  )];
  if (directories.length === 0 && PLATFORM === "linux") {
    const desktopTarget = resolveLinuxDesktopTarget();
    if (desktopTarget) return desktopTarget;
  }
  if (directories.length === 0) {
    throw new Error(
      "未找到正在运行或已注册桌面启动器的 Flowlet。"
        + "请启动当前便携版，或使用 --target 显式指定目录。",
    );
  }
  if (directories.length > 1) {
    throw new Error("检测到多个不同目录的 Flowlet 实例。请使用 --target 指定需要更新的目录。");
  }
  return dirname(portableProcesses[0].executablePath);
}

function resolveLinuxDesktopTarget() {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const desktopFile = join(dataHome, "applications", "site.snewbie.flowlet.desktop");
  if (!existsSync(desktopFile)) return null;

  const tryExec = readFileSync(desktopFile, "utf8")
    .split(/\r?\n/u)
    .find((line) => line.startsWith("TryExec="))
    ?.slice("TryExec=".length)
    .trim();
  if (!tryExec) return null;

  const executablePath = resolve(tryExec.replace(/^"|"$/gu, ""));
  const targetDir = dirname(executablePath);
  if (!existsSync(executablePath) || !existsSync(join(targetDir, "portable.tag"))) return null;
  return targetDir;
}

/** 选定布局：显式指定 > 目标目录特征 > 报错让人指定。 */
function resolveLayout(options, processes) {
  if (options.layout !== "auto") return LAYOUTS[options.layout];

  if (options.target) {
    const detected = detectLayoutByDir(options.target);
    if (detected) return detected;
  }

  const targetDir = resolveTargetDirectory(options.target, processes);
  const detected = detectLayoutByDir(targetDir);
  if (detected) return detected;

  throw new Error(
    "无法判断目标目录是 Tauri 还是 Electron 便携版；请用 --layout 指定，"
      + "或确认目录里有 flowlet_lib.* / flowlet.exe / resources/app.asar。",
  );
}

function validateTarget(targetDir, layout) {
  if (!existsSync(targetDir)) throw new Error(`目标目录不存在：${targetDir}`);
  const targetExe = join(targetDir, layout.executable);
  if (!existsSync(targetExe)) {
    throw new Error(`目标目录中未找到 ${layout.executable}：${targetDir}`);
  }
  if (!existsSync(join(targetDir, "portable.tag"))) {
    throw new Error(`目标目录中没有 portable.tag，不会覆盖非便携版安装：${targetDir}`);
  }
  return targetExe;
}

function buildDirOf(layout) {
  return join(layout.buildRoot, layout.directoryName);
}

function buildPortable(layout) {
  console.log(`\n[1/4] 构建便携版（npm run ${layout.buildScript}）…`);
  const command = PLATFORM === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const args = PLATFORM === "win32"
    ? ["/d", "/s", "/c", `npm run ${layout.buildScript}`]
    : ["run", layout.buildScript];
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = result.error instanceof Error ? `：${result.error.message}` : "";
    throw new Error(`便携版构建失败（退出码 ${result.status ?? "unknown"}）${detail}`);
  }
}

function validateBuildPayload(layout, replaceConfig) {
  const buildDir = buildDirOf(layout);
  if (!existsSync(buildDir)) {
    throw new Error(`构建目录不存在：${buildDir}（先跑 npm run ${layout.buildScript}）`);
  }
  if (!existsSync(join(buildDir, layout.executable))) {
    throw new Error(`便携版产物缺少可执行文件：${join(buildDir, layout.executable)}`);
  }
  if (layout.payloadFiles === null) return;

  const required = replaceConfig
    ? [...layout.payloadFiles, "config.json"]
    : layout.payloadFiles;
  const missing = required.filter((fileName) => (
    !fileName.endsWith(".so") && !fileName.endsWith(".dll")
    && !existsSync(join(buildDir, fileName))
  ));
  if (missing.length > 0) {
    throw new Error(`便携版产物不完整，缺少：${missing.join(", ")}`);
  }
}

function stopTargetProcesses(targetExe) {
  const matching = listFlowletProcesses().filter((item) => samePath(item.executablePath, targetExe));
  console.log("\n[2/4] 停止当前便携版…");
  if (matching.length === 0) {
    console.log("  当前目标目录没有运行中的 Flowlet，跳过停止。");
    return;
  }

  const processIds = matching.map((item) => item.pid);
  if (PLATFORM === "win32") {
    runPowerShell(
      `Stop-Process -Id ${processIds.join(",")} -Force -ErrorAction Stop; `
        + `Wait-Process -Id ${processIds.join(",")} -Timeout 10 -ErrorAction SilentlyContinue`,
    );
  } else {
    for (const pid of processIds) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    const deadline = Date.now() + 10_000;
    let remaining = processIds.filter(isProcessRunning);
    while (remaining.length > 0 && Date.now() < deadline) {
      sleep(100);
      remaining = remaining.filter(isProcessRunning);
    }
    if (remaining.length > 0) {
      for (const pid of remaining) process.kill(pid, "SIGKILL");
      sleep(100);
    }
  }

  const remaining = listFlowletProcesses().filter((item) => samePath(item.executablePath, targetExe));
  if (remaining.length > 0) {
    throw new Error(`Flowlet 未能完全停止，仍在运行的 PID：${remaining.map((item) => item.pid).join(", ")}`);
  }
  console.log(`  已停止 PID：${processIds.join(", ")}`);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function copyPayload(layout, targetDir, replaceConfig) {
  console.log("\n[3/4] 覆盖程序文件…");
  mkdirSync(targetDir, { recursive: true });
  const buildDir = buildDirOf(layout);

  if (layout.payloadFiles === null) {
    // Electron：整棵应用目录覆盖，但保留配置、数据库与 data/。
    for (const entry of readdirSync(buildDir)) {
      if (!replaceConfig && ELECTRON_PRESERVE.has(entry)) {
        console.log(`  跳过 ${entry}（保留目标现有文件）`);
        continue;
      }
      const source = join(buildDir, entry);
      const target = join(targetDir, entry);
      rmSync(target, { recursive: true, force: true });
      cpSync(source, target, { recursive: true });
      console.log(`  已更新 ${entry}`);
    }
    console.log("  已保留数据库、data/ 与现有 config.json");
    return;
  }

  const files = replaceConfig ? [...layout.payloadFiles, "config.json"] : layout.payloadFiles;
  for (const fileName of files) {
    const source = join(buildDir, fileName);
    if (!existsSync(source)) {
      if (fileName.endsWith(".so") || fileName.endsWith(".dll")) continue;
      throw new Error(`便携版产物缺少文件：${source}`);
    }
    copyFileSync(source, join(targetDir, fileName));
    if (PLATFORM === "linux" && (
      fileName === layout.executable || fileName === "install-desktop-entry.sh"
    )) {
      chmodSync(join(targetDir, fileName), 0o755);
    }
    console.log(`  已更新 ${fileName}`);
  }

  if (!replaceConfig && existsSync(join(targetDir, "config.json"))) {
    console.log("  已保留现有 config.json（传 --replace-config 可覆盖）");
  }
  console.log("  已保留数据库及目标目录中的其他运行数据");

  const installer = join(targetDir, "install-desktop-entry.sh");
  if (PLATFORM === "linux" && existsSync(installer)) {
    const result = spawnSync(installer, [], { cwd: targetDir, encoding: "utf8" });
    if (result.status === 0) {
      console.log("  已刷新当前用户的 Flowlet 桌面启动器和图标");
    } else {
      const detail = result.stderr?.trim();
      console.warn(`  警告：桌面启动器刷新失败${detail ? `：${detail}` : ""}`);
    }
  }
}

function restartFlowlet(targetExe, shouldRestart) {
  console.log("\n[4/4] 完成更新…");
  if (!shouldRestart) {
    console.log("  已按 --no-restart 跳过启动。");
    return;
  }

  const child = spawn(targetExe, [], {
    cwd: dirname(targetExe),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env: PLATFORM === "linux"
      ? {
          ...process.env,
          GIO_LAUNCHED_DESKTOP_FILE: join(
            process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
            "applications",
            "site.snewbie.flowlet.desktop",
          ),
        }
      : process.env,
  });
  child.unref();
  console.log(`  已重新启动：${targetExe}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  console.log("=== Flowlet 便携版一键更新 ===");

  if (options.dryRun) {
    const processes = listFlowletProcesses();
    const layout = resolveLayout(options, processes);
    const targetDir = resolveTargetDirectory(options.target, processes);
    validateTarget(targetDir, layout);
    console.log(`布局：${layout.key}`);
    console.log(`构建目录：${buildDirOf(layout)}`);
    console.log(`识别目录：${targetDir}`);
    console.log("\n演练完成：未构建、未停止进程、未修改文件。");
    return;
  }

  const processes = listFlowletProcesses();
  const layout = resolveLayout(options, processes);
  console.log(`布局：${layout.key}`);
  console.log(`构建目录：${buildDirOf(layout)}`);
  console.log(`配置策略：${options.replaceConfig ? "覆盖 config.json" : "保留现有 config.json"}`);

  if (options.skipBuild) {
    console.log("\n[1/4] 跳过构建（--skip-build），直接使用现有便携版产物");
  } else {
    buildPortable(layout);
  }
  validateBuildPayload(layout, options.replaceConfig);
  const targetDir = resolveTargetDirectory(options.target, listFlowletProcesses());
  const targetExe = validateTarget(targetDir, layout);
  console.log(`\n已识别运行中的便携版：${targetExe}`);
  stopTargetProcesses(targetExe);
  copyPayload(layout, targetDir, options.replaceConfig);
  restartFlowlet(targetExe, options.restart);
  console.log("\n✅ Flowlet 便携版已更新完成。");
}

try {
  main();
} catch (error) {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}