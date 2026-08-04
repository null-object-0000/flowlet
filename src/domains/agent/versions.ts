/**
 * 版本号比较工具（semver 简化版）。
 *
 * 用于「Agent 已安装版本 vs npm 最新版本」的更新提示判断。支持 x.y.z 与
 * pre-release 后缀；无法解析时退化为字符串比较，避免误判。
 */

import type { AgentEnvironmentReport } from "./types";

/** 将版本号解析为「数字段 + pre-release 段」；解析失败返回 null。 */
function parseVersion(input: string): { core: number[]; pre: string[] } | null {
  const raw = String(input).trim().replace(/^[vV]/, "");
  const [corePart, prePart = ""] = raw.split("-");
  const [numericPart] = corePart.split("+");
  const core = numericPart.split(".").map((segment) => parseInt(segment, 10));
  if (core.length === 0 || core.some((value) => Number.isNaN(value))) {
    return null;
  }
  const pre = prePart ? prePart.split(".") : [];
  return { core, pre };
}

/** 比较两个版本号：a > b 返回 1，a < b 返回 -1，相等返回 0。无法解析时按字符串兜底。 */
export function compareVersions(a?: string | null, b?: string | null): number {
  const parsedA = a ? parseVersion(a) : null;
  const parsedB = b ? parseVersion(b) : null;
  if (!parsedA || !parsedB) {
    const left = a ?? "";
    const right = b ?? "";
    if (left === right) return 0;
    return left > right ? 1 : -1;
  }

  const coreLength = Math.max(parsedA.core.length, parsedB.core.length);
  for (let index = 0; index < coreLength; index += 1) {
    const left = parsedA.core[index] ?? 0;
    const right = parsedB.core[index] ?? 0;
    if (left !== right) return left > right ? 1 : -1;
  }

  // 核心版本相同：无 pre-release > 有 pre-release（semver 规则）。
  if (parsedA.pre.length === 0 && parsedB.pre.length > 0) return 1;
  if (parsedB.pre.length === 0 && parsedA.pre.length > 0) return -1;

  const preLength = Math.max(parsedA.pre.length, parsedB.pre.length);
  for (let index = 0; index < preLength; index += 1) {
    const left = parsedA.pre[index] ?? "";
    const right = parsedB.pre[index] ?? "";
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      return parseInt(left, 10) > parseInt(right, 10) ? 1 : -1;
    }
    return left > right ? 1 : -1;
  }
  return 0;
}

/** 最新版本是否比已安装版本新（用于展示更新提示）。任一侧为空返回 false。 */
export function isNewerVersion(latest?: string | null, installed?: string | null): boolean {
  if (!latest || !installed) return false;
  return compareVersions(latest, installed) > 0;
}

/**
 * 从环境报告取「CLI 面」的已安装版本。
 *
 * npm registry 的 `latest` 对应各 Agent 的 CLI 包版本（如 @openai/codex、
 * opencode-ai）；桌面应用（ChatGPT Desktop / OpenCode Desktop）使用独立的
 * 版本号体系，不应参与更新比较。优先取「当前使用」的 CLI 安装，其次取首个
 * CLI 安装；未检测到 CLI 时返回 null（不展示更新提示）。
 */
export function cliInstalledVersion(environment?: AgentEnvironmentReport): string | null {
  if (!environment) return null;
  const primary = environment.primary;
  if (primary && (primary.surface ?? "cli") === "cli" && primary.version) {
    return primary.version;
  }
  const cli = environment.installations.find((item) => (item.surface ?? "cli") === "cli");
  return cli?.version ?? null;
}
