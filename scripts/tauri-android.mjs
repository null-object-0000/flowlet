import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const javaExecutable = isWindows ? "java.exe" : "java";

const javaHomeCandidates = [
  process.env.FLOWLET_ANDROID_JAVA_HOME,
  isWindows ? "C:\\Program Files\\Android\\Android Studio\\jbr" : undefined,
  process.platform === "darwin"
    ? "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    : undefined,
  process.env.JAVA_HOME,
].filter(Boolean);

function javaMajorVersion(javaHome) {
  const releaseFile = join(javaHome, "release");
  if (!existsSync(releaseFile)) {
    return undefined;
  }

  const match = readFileSync(releaseFile, "utf8").match(
    /^JAVA_VERSION="(\d+)(?:\.\d+)*"/m,
  );
  return match ? Number(match[1]) : undefined;
}

const javaHome = javaHomeCandidates.find((candidate) => {
  if (!existsSync(join(candidate, "bin", javaExecutable))) {
    return false;
  }

  const majorVersion = javaMajorVersion(candidate);
  return majorVersion === undefined || majorVersion <= 21;
});

if (!javaHome) {
  console.error(
    "未找到兼容的 Android JDK（需要 Java 17–21）。请安装 Android Studio，" +
      "或设置 FLOWLET_ANDROID_JAVA_HOME。",
  );
  process.exit(1);
}

const environment = {
  ...process.env,
  JAVA_HOME: javaHome,
};

const androidHomeCandidates = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  isWindows && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Android", "Sdk")
    : undefined,
  process.platform === "darwin"
    ? join(homedir(), "Library", "Android", "sdk")
    : join(homedir(), "Android", "Sdk"),
].filter(Boolean);

const androidHome = androidHomeCandidates.find((candidate) =>
  existsSync(candidate),
);

if (androidHome) {
  environment.ANDROID_HOME = androidHome;
}

environment.PATH = [
  join(javaHome, "bin"),
  androidHome ? join(androidHome, "platform-tools") : undefined,
  process.env.PATH,
]
  .filter(Boolean)
  .join(delimiter);

const tauriCli = join(
  process.cwd(),
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);

if (!existsSync(tauriCli)) {
  console.error("未找到 Tauri CLI，请先运行 npm install。");
  process.exit(1);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`进程被信号 ${signal} 终止`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

console.log(
  `[Flowlet Android] JAVA_HOME=${javaHome} (Java ${javaMajorVersion(javaHome) ?? "unknown"})`,
);

const requestedArguments = process.argv.slice(2);
let exitCode;

if (requestedArguments[0] === "install") {
  const keystoreProperties = join(
    process.cwd(),
    "src-tauri",
    "gen",
    "android",
    "keystore.properties",
  );
  if (!existsSync(keystoreProperties)) {
    console.error(
      "未找到 src-tauri/gen/android/keystore.properties，无法构建正式签名 APK。",
    );
    process.exit(1);
  }

  exitCode = await run(process.execPath, [
    tauriCli,
    "android",
    "build",
    "--apk",
    "--target",
    "aarch64",
    ...requestedArguments.slice(1),
  ]);

  if (exitCode === 0) {
    const adbExecutable =
      androidHome && existsSync(join(androidHome, "platform-tools", isWindows ? "adb.exe" : "adb"))
        ? join(androidHome, "platform-tools", isWindows ? "adb.exe" : "adb")
        : isWindows
          ? "adb.exe"
          : "adb";
    const apk = join(
      process.cwd(),
      "src-tauri",
      "gen",
      "android",
      "app",
      "build",
      "outputs",
      "apk",
      "universal",
      "release",
      "app-universal-release.apk",
    );
    if (!existsSync(apk)) {
      console.error(
        `未找到正式签名 APK：${apk}\n请检查 Android release signing 配置。`,
      );
      exitCode = 1;
    } else {
      exitCode = await run(adbExecutable, ["install", "-r", apk]);
    }
  }
} else {
  exitCode = await run(process.execPath, [
    tauriCli,
    "android",
    ...requestedArguments,
  ]);
}

process.exit(exitCode);
