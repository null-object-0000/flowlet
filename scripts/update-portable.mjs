// Windows / Linux 便携版一键更新：构建 -> 停止当前实例 -> 覆盖程序文件 -> 重新启动。
//
// 默认从正在运行的 Flowlet 自动识别目标目录：
//   npm run tauri:update:portable
//
// 也可以显式指定目录：
//   npm run tauri:update:portable -- --target <Flowlet 便携版目录>
//
// 默认保留目标目录中现有的 config.json 和所有运行数据。如需同步仓库配置：
//   npm run tauri:update:portable -- --replace-config

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const PACKAGE_JSON = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
const ARCH = process.env.TAURI_ENV_ARCH
  ?? process.arch.replace("x86_", "x").replace("x86", "x64");
const PLATFORM_FILES = {
  win32: {
    executable: "flowlet.exe",
    library: "flowlet_lib.dll",
    directoryName: `Flowlet_${PACKAGE_JSON.version}_${ARCH}_portable`,
    extraFiles: [],
  },
  linux: {
    executable: "flowlet",
    library: "libflowlet_lib.so",
    directoryName: `Flowlet_${PACKAGE_JSON.version}_linux_${ARCH}_portable`,
    extraFiles: ["flowlet.png", "install-desktop-entry.sh"],
  },
};
const platformFiles = PLATFORM_FILES[process.platform];
if (!platformFiles) {
  throw new Error(`当前一键更新脚本暂不支持 ${process.platform}。`);
}
const PORTABLE_DIR_NAME = platformFiles.directoryName;
const BUILD_DIR = join(
  PROJECT_ROOT,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "portable",
  PORTABLE_DIR_NAME,
);
const PAYLOAD_FILES = [
  platformFiles.executable,
  platformFiles.library,
  "models-cn.json",
  "models-dev.json",
  "portable.tag",
  ...platformFiles.extraFiles,
];

function printHelp() {
  console.log(`Flowlet 便携版一键更新

用法：
  npm run tauri:update:portable
  npm run tauri:update:portable -- --target <便携版目录>

选项：
  --target <目录>     显式指定需要更新的便携版目录
  --replace-config    同时用仓库 config.json 覆盖目标配置
  --no-restart        更新完成后不重新启动 Flowlet
  --dry-run           只显示识别结果，不构建、不停止、不覆盖
  --help              显示帮助`);
}

function parseArgs(argv) {
  const options = {
    target: null,
    replaceConfig: false,
    restart: true,
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
    } else if (arg === "--replace-config") {
      options.replaceConfig = true;
    } else if (arg === "--no-restart") {
      options.restart = false;
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

function listFlowletProcesses() {
  if (process.platform === "linux") {
    return readdirSync("/proc", { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .flatMap((entry) => {
        try {
          const executablePath = readlinkSync(join("/proc", entry.name, "exe"));
          if (executablePath.endsWith(" (deleted)")) return [];
          if (executablePath.split("/").at(-1) !== platformFiles.executable) return [];
          return [{ pid: Number(entry.name), executablePath: resolve(executablePath) }];
        } catch {
          // 进程可能在扫描过程中退出，或属于当前用户无权读取的会话。
          return [];
        }
      });
  }

  const output = runPowerShell(
    "$items = @(Get-CimInstance Win32_Process -Filter \"Name = 'flowlet.exe'\" | "
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
  if (process.platform === "win32") {
    return resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US");
  }
  return resolve(left) === resolve(right);
}

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
      return process.platform === "win32" ? directory.toLocaleLowerCase("en-US") : directory;
    }),
  )];
  if (directories.length === 0 && process.platform === "linux") {
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

function validateTarget(targetDir) {
  if (!existsSync(targetDir)) throw new Error(`目标目录不存在：${targetDir}`);
  const targetExe = join(targetDir, platformFiles.executable);
  if (!existsSync(targetExe)) {
    throw new Error(`目标目录中未找到 ${platformFiles.executable}：${targetDir}`);
  }
  if (!existsSync(join(targetDir, "portable.tag"))) {
    throw new Error(`目标目录中没有 portable.tag，不会覆盖非便携版安装：${targetDir}`);
  }
  return targetExe;
}

function buildPortable() {
  console.log("\n[1/4] 构建便携版…");
  const command = process.platform === "win32"
    ? (process.env.ComSpec ?? "cmd.exe")
    : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm run tauri:build:portable"]
    : ["run", "tauri:build:portable"];
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = result.error instanceof Error ? `：${result.error.message}` : "";
    throw new Error(`便携版构建失败（退出码 ${result.status ?? "unknown"}）${detail}`);
  }
  if (!existsSync(join(BUILD_DIR, platformFiles.executable))) {
    throw new Error(`构建完成后未找到便携版程序：${BUILD_DIR}`);
  }
}

function validateBuildPayload(replaceConfig) {
  const requiredFiles = replaceConfig ? [...PAYLOAD_FILES, "config.json"] : PAYLOAD_FILES;
  const missingFiles = requiredFiles.filter((fileName) => (
    fileName !== platformFiles.library && !existsSync(join(BUILD_DIR, fileName))
  ));
  if (missingFiles.length > 0) {
    throw new Error(`便携版产物不完整，缺少：${missingFiles.join(", ")}`);
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
  if (process.platform === "win32") {
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

function copyPayload(targetDir, replaceConfig) {
  console.log("\n[3/4] 覆盖程序文件…");
  mkdirSync(targetDir, { recursive: true });

  const files = replaceConfig ? [...PAYLOAD_FILES, "config.json"] : PAYLOAD_FILES;
  for (const fileName of files) {
    const source = join(BUILD_DIR, fileName);
    if (!existsSync(source)) {
      if (fileName === platformFiles.library) continue;
      throw new Error(`便携版产物缺少文件：${source}`);
    }
    copyFileSync(source, join(targetDir, fileName));
    if (process.platform === "linux" && (
      fileName === platformFiles.executable || fileName === "install-desktop-entry.sh"
    )) {
      chmodSync(join(targetDir, fileName), 0o755);
    }
    console.log(`  已更新 ${fileName}`);
  }

  if (!replaceConfig && existsSync(join(targetDir, "config.json"))) {
    console.log("  已保留现有 config.json（传 --replace-config 可覆盖）");
  }
  console.log("  已保留数据库及目标目录中的其他运行数据");

  if (process.platform === "linux") {
    const installer = join(targetDir, "install-desktop-entry.sh");
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
    env: process.platform === "linux"
      ? {
          ...process.env,
          GDK_BACKEND: "x11",
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
  console.log(`构建目录：${BUILD_DIR}`);
  console.log(`配置策略：${options.replaceConfig ? "覆盖 config.json" : "保留现有 config.json"}`);

  if (options.dryRun) {
    const runningProcesses = listFlowletProcesses();
    const targetDir = resolveTargetDirectory(options.target, runningProcesses);
    validateTarget(targetDir);
    console.log(`识别目录：${targetDir}`);
    console.log("\n演练完成：未构建、未停止进程、未修改文件。");
    return;
  }

  buildPortable();
  validateBuildPayload(options.replaceConfig);
  const runningProcesses = listFlowletProcesses();
  const targetDir = resolveTargetDirectory(options.target, runningProcesses);
  const targetExe = validateTarget(targetDir);
  console.log(`\n已识别运行中的便携版：${targetExe}`);
  stopTargetProcesses(targetExe);
  copyPayload(targetDir, options.replaceConfig);
  restartFlowlet(targetExe, options.restart);
  console.log("\n✅ Flowlet 便携版已更新完成。");
}

try {
  main();
} catch (error) {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
