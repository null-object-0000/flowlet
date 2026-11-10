// 构建 Web Host「本机接入」静态下载产物：
//
//   dist-web/downloads/manifest.json
//   dist-web/downloads/flowlet-cli.tar.gz     内层 flowlet-cli/…（可执行 bin/flowlet）
//   dist-web/downloads/flowlet-skills.tar.gz  内层 flowlet-skills/flowlet-credentials/SKILL.md
//   dist-web/downloads/install-flowlet.sh     POSIX sh 安装脚本
//
// 用法：node scripts/build-local-access.mjs（通常由 `npm run build:web` 末尾串联）
//
// 约束：
// - 纯 Node，不新增 npm 依赖；打包使用系统 tar（缺失时给出明确错误）。
// - CLI 命令名来自 packages/flowlet-cred/package.json 的 bin 映射，不硬编码旧名。
// - CLI 唯一运行时依赖 undici 从仓库根 node_modules 复制，离线可用。
// - 产物先写入临时目录，全部成功后才替换 dist-web/downloads；任何失败非 0 退出。

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIR, "..");
const CRED_DIR = join(PROJECT_ROOT, "packages", "flowlet-cred");
const SKILLS_DIR = join(PROJECT_ROOT, "packages", "flowlet-skills");
const DIST_WEB = join(PROJECT_ROOT, "dist-web");
const DOWNLOADS_DIR = join(DIST_WEB, "downloads");
const INSTALL_SCRIPT_NAME = "install-flowlet.sh";
const INSTALL_SCRIPT_SRC = join(SCRIPT_DIR, INSTALL_SCRIPT_NAME);
const CLI_TAR_NAME = "flowlet-cli.tar.gz";
const SKILLS_TAR_NAME = "flowlet-skills.tar.gz";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** 运行系统 tar；ENOENT 时给出可操作错误（不新增打包依赖）。 */
function runTar(args) {
  const result = spawnSync("tar", args, { encoding: "utf8" });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error("未找到系统 tar，无法打包下载产物（请安装 tar 后重试）");
    }
    throw new Error(`执行 tar 失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim() || `tar 退出码 ${result.status ?? "unknown"}`;
    throw new Error(`tar 打包失败：${detail}`);
  }
}

/** 复制 CLI 源码树：跳过测试文件。 */
function copySourceTree(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
      continue;
    }
    const source = join(srcDir, entry.name);
    const target = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copySourceTree(source, target);
    } else if (entry.isFile()) {
      cpSync(source, target);
    }
  }
}

/**
 * 生成 flowlet-cli 暂存树（未压缩），返回 `{ cliParent, cliRoot, version }`。
 * 内层目录名固定 `flowlet-cli`，与 spec §3.1 的打包布局一致。
 */
function stageCli(tmpRoot) {
  const credPackage = readJson(join(CRED_DIR, "package.json"));
  const rootPackage = readJson(join(PROJECT_ROOT, "package.json"));
  const version = credPackage.version || rootPackage.version;
  if (!version) throw new Error("无法读取 CLI 版本（packages/flowlet-cred/package.json 缺少 version）");

  const binEntries = Object.entries(credPackage.bin ?? {});
  if (binEntries.length === 0) {
    throw new Error("packages/flowlet-cred/package.json 未声明 bin 映射，无法生成可执行命令");
  }

  const cliRoot = join(tmpRoot, "flowlet-cli");
  mkdirSync(cliRoot, { recursive: true });

  // 1) bin 映射：按文件实际名字复制；用户侧命令统一为 flowlet（spec §2）。
  const stagedBin = {};
  for (const [commandName, relativePath] of binEntries) {
    const source = join(CRED_DIR, relativePath);
    if (!existsSync(source)) {
      throw new Error(`bin 映射 ${commandName} 指向不存在的文件：${relativePath}`);
    }
    const fileName = basename(relativePath);
    const target = join(cliRoot, "bin", fileName);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
    chmodSync(target, 0o755);
    stagedBin[commandName] = `./bin/${fileName}`;
  }
  if (!stagedBin.flowlet) {
    stagedBin.flowlet = `./bin/${basename(binEntries[0][1])}`;
  }

  // 2) CLI 源码（排除测试）。
  copySourceTree(join(CRED_DIR, "src"), join(cliRoot, "src"));

  // 3) 唯一运行时依赖 undici（离线可用）。
  const undiciSource = join(PROJECT_ROOT, "node_modules", "undici");
  if (!existsSync(undiciSource)) {
    throw new Error("未找到 node_modules/undici，请先在仓库根目录执行 npm install");
  }
  cpSync(undiciSource, join(cliRoot, "node_modules", "undici"), { recursive: true });

  // 4) 生成包元数据：CLI 启动时读取版本号，bin 名供安装脚本定位。
  const packageJson = {
    name: "flowlet-cli",
    version,
    description: "Flowlet 全局凭据库 CLI（无需 Rust 运行时）",
    type: "module",
    bin: stagedBin,
    // engines 跟随源包声明（当前为 >=22.6，与 bin/flowlet.mjs 的版本自检一致）。
    engines: credPackage.engines ?? { node: ">=22.6" },
    dependencies: {},
  };
  writeFileSync(join(cliRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(
    join(cliRoot, "README.md"),
    [
      "# flowlet-cli",
      "",
      "Flowlet 全局凭据库命令行（`flowlet`）。需要 Node.js 22.6+。",
      "",
      "通过 Flowlet Web Host「服务凭据 → 本机接入」下载的 `install-flowlet.sh` 安装；",
      "安装后运行 `flowlet --help` 查看用法。",
      "",
    ].join("\n"),
  );

  return { cliParent: tmpRoot, cliRoot, version };
}

function build() {
  mkdirSync(DIST_WEB, { recursive: true });
  const tmpRoot = mkdtempSync(join(DIST_WEB, ".local-access-"));
  const outputDir = join(tmpRoot, "output");
  mkdirSync(outputDir, { recursive: true });

  try {
    const { cliParent, cliRoot, version } = stageCli(tmpRoot);

    // flowlet-cli.tar.gz：内层 flowlet-cli/…
    runTar(["-czf", join(outputDir, CLI_TAR_NAME), "-C", cliParent, basename(cliRoot)]);

    // flowlet-skills.tar.gz：内层 flowlet-skills/…
    const skillsRoot = join(SKILLS_DIR, "flowlet-credentials", "SKILL.md");
    if (!existsSync(skillsRoot)) {
      throw new Error("packages/flowlet-skills/flowlet-credentials/SKILL.md 不存在，无法生成 Skills 包");
    }
    runTar(["-czf", join(outputDir, SKILLS_TAR_NAME), "-C", join(PROJECT_ROOT, "packages"), "flowlet-skills"]);

    // install-flowlet.sh：原样拷贝并赋可执行权限（下载后可直接 sh）。
    if (!existsSync(INSTALL_SCRIPT_SRC)) {
      throw new Error(`缺少安装脚本：${INSTALL_SCRIPT_SRC}`);
    }
    const installTarget = join(outputDir, INSTALL_SCRIPT_NAME);
    cpSync(INSTALL_SCRIPT_SRC, installTarget);
    chmodSync(installTarget, 0o755);

    // manifest.json：版本 + 生成时间 + 每个产物的字节数与 sha256。
    const artifacts = [CLI_TAR_NAME, SKILLS_TAR_NAME, INSTALL_SCRIPT_NAME].map((fileName) => {
      const filePath = join(outputDir, fileName);
      return {
        path: fileName,
        bytes: statSync(filePath).size,
        sha256: sha256File(filePath),
      };
    });
    writeFileSync(
      join(outputDir, "manifest.json"),
      `${JSON.stringify({ version, generatedAt: new Date().toISOString(), artifacts }, null, 2)}\n`,
    );

    // 全部成功后才替换 downloads/：避免留下半套产物。
    rmSync(DOWNLOADS_DIR, { recursive: true, force: true });
    renameSync(outputDir, DOWNLOADS_DIR);

    console.log(`[build-local-access] 已生成 dist-web/downloads（CLI ${version}）`);
    for (const artifact of artifacts) {
      console.log(
        `[build-local-access]   ${artifact.path}  ${artifact.bytes} bytes  sha256 ${artifact.sha256}`,
      );
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

try {
  build();
} catch (error) {
  console.error(`[build-local-access] 构建失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}