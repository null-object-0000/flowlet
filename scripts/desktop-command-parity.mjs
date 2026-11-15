#!/usr/bin/env node
// 桌面命令面对拍：冻结桌面契约 ↔ Node 实现（Web Host 命令 + desktop 注册表）。
//
// 用途：追踪已退役 Tauri 桌面的 154 条兼容命令。只读，不改任何文件。
// 用法：node scripts/desktop-command-parity.mjs [--json]
//
// 判定：
//   - covered-web    ：已由 packages/flowlet-core/src/web/commands.ts 实现（Docker/Web Host 同一份）
//   - covered-desktop：已由 packages/flowlet-core/src/desktop/*.ts 的 handlers 注册表实现
//   - missing        ：尚未实现（桌面页面会报 501 unsupported_in_web）
//   - node-only      ：冻结兼容基线之外的 Node 命令（如 CLI 授权、千问平台登录）
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = path.join(ROOT, "tests/contracts/desktop-commands.json");
const WEB = path.join(ROOT, "packages/flowlet-core/src/web/commands.ts");
const DESKTOP_DIR = path.join(ROOT, "packages/flowlet-core/src/desktop");

/** 已退役 Tauri 桌面命令的冻结契约；不依赖 Android/Rust 源码。 */
function baselineCommands() {
  const { commands } = JSON.parse(readFileSync(CONTRACT, "utf8"));
  if (!Array.isArray(commands) || commands.length === 0
      || commands.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9_]*$/.test(name))
      || new Set(commands).size !== commands.length) {
    throw new Error("桌面命令基线无效");
  }
  return commands;
}

function webCommands() {
  const source = readFileSync(WEB, "utf8");
  return [...source.matchAll(/case "([a-zA-Z0-9_]+)":/g)].map((match) => match[1]);
}

/** desktop/*.ts 里 `export const handlers` 对象中登记的命令名（一级键，跳过注释/字符串/嵌套）。 */
function desktopCommands() {
  const names = new Set();
  for (const file of readdirSync(DESKTOP_DIR)) {
    if (!file.endsWith(".ts")) continue;
    if (file === "commands.ts" || file === "types.ts" || file === "index.ts") continue;
    const source = readFileSync(path.join(DESKTOP_DIR, file), "utf8");
    const startAt = source.indexOf("export const handlers");
    if (startAt < 0) continue;
    let i = source.indexOf("{", startAt);
    let depth = 0;
    let atLineStart = true;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "\n") {
        atLineStart = true;
        continue;
      }
      if (ch === "{") {
        depth += 1;
        atLineStart = false;
        continue;
      }
      if (ch === "}") {
        depth -= 1;
        atLineStart = false;
        if (depth === 0) break;
        continue;
      }
      const isComment = ch === "/" && (source[i + 1] === "/" || source[i + 1] === "*");
      if (depth === 1 && atLineStart && !isComment) {
        if (/\s/.test(ch)) continue;
        const rest = source.slice(i);
        let match;
        if (ch === '"' || ch === "'") {
          const close = source.indexOf(ch, i + 1);
          const key = source.slice(i + 1, close);
          if (/^[a-z][a-z0-9_]*$/.test(key) && /^\s*:/.test(source.slice(close + 1))) names.add(key);
          i = close;
        } else if ((match = /^([a-z][a-z0-9_]*)\s*:/.exec(rest))) {
          names.add(match[1]);
          i += match[1].length - 1;
        } else if ((match = /^(?:async\s+)?([a-z][a-z0-9_]*)/.exec(rest))) {
          i += match[0].length - 1;
        }
        atLineStart = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        let j = i + 1;
        while (j < source.length) {
          if (source[j] === "\\") {
            j += 2;
            continue;
          }
          if (source[j] === ch) break;
          j += 1;
        }
        i = j;
        atLineStart = false;
        continue;
      }
      if (isComment) {
        if (source[i + 1] === "/") {
          const nl = source.indexOf("\n", i);
          i = nl < 0 ? source.length : nl;
        } else {
          const end = source.indexOf("*/", i + 2);
          i = end < 0 ? source.length : end + 1;
        }
        continue;
      }
      if (!/\s/.test(ch)) atLineStart = false;
    }
  }
  return [...names];
}

const baseline = [...new Set(baselineCommands())];
const web = new Set(webCommands());
const desktop = new Set(desktopCommands());
const known = new Set([...web, ...desktop]);

const coveredWeb = baseline.filter((name) => web.has(name));
const coveredDesktop = baseline.filter((name) => !web.has(name) && desktop.has(name));
const missing = baseline.filter((name) => !known.has(name));
const nodeOnly = [...known].filter((name) => !baseline.includes(name)).sort();

const report = {
  baselineTotal: baseline.length,
  coveredWeb: coveredWeb.length,
  coveredDesktop: coveredDesktop.length,
  missing: missing.length,
  nodeOnly,
  missingCommands: missing,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = ((report.coveredWeb + report.coveredDesktop) / report.baselineTotal) * 100;
  console.log(`桌面兼容命令基线：${report.baselineTotal}`);
  console.log(`  已覆盖（Web Host）：${report.coveredWeb}`);
  console.log(`  已覆盖（desktop 注册表）：${report.coveredDesktop}`);
  console.log(`  未覆盖：${report.missing}  => 覆盖度 ${pct.toFixed(1)}%`);
  if (missing.length > 0) console.log(`\n未实现：\n${missing.map((n) => `  - ${n}`).join("\n")}`);
  if (nodeOnly.length > 0) console.log(`\n兼容基线之外的 Node 命令：${nodeOnly.join(", ")}`);
}

// `--check`：CI 门禁用。存在未覆盖命令时以非 0 退出。
if (process.argv.includes("--check") && report.missing > 0) {
  console.error(`\n桌面命令覆盖不完整：缺少 ${report.missing} 条`);
  process.exitCode = 1;
}
