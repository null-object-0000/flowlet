#!/usr/bin/env node
// flowlet bin shim：Node 22.6+ 直接运行 TS（类型剥离），无需构建。
//
// Node 类型剥离的可用性随版本不同（安装脚本只能校验 major，这里再兜一层）：
// - Node ≥ 23.6 / ≥ 22.18：默认开启，直接 import cli.ts；
// - Node 22.6–22.17：需要 `--experimental-strip-types`，用子进程透传参数与退出码；
// - < 22.6：明确报错退出（不要静默失败）。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const currentVersion = process.versions.node;
const [major = 0, minor = 0] = currentVersion.split(".").map((part) => Number(part));

if (major < 22 || (major === 22 && minor < 6)) {
  process.stderr.write(`flowlet 需要 Node.js 22.6+（当前 ${currentVersion}）\n`);
  process.exit(1);
}

/** 该版本默认开启 TypeScript 类型剥离（无需 flag）。 */
const typeStrippingByDefault =
  major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);

if (typeStrippingByDefault) {
  await import(cliPath);
} else {
  // Node 22.6–22.17：带 flag 重新执行入口，stdio/退出码原样透传。
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", cliPath, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  if (result.error !== undefined && result.error !== null) {
    process.stderr.write(`启动 flowlet 失败：${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}