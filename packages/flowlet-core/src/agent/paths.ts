// Agent 配置路径解析与展示。权威实现：`src-tauri/src/core/agent_*` 与
// `src-tauri/src/core/codex_account.rs`、`antigravity_*`。
//
// 规则（与 Rust 一致）：
// - 一律使用真实 home 目录（`dirs::home_dir()`）；便携版只决定 Flowlet 自己的数据目录，
//   不搬移 Agent 的用户级配置。
// - 支持各 Agent 的官方环境变量覆盖：CLAUDE_CONFIG_DIR / CODEX_HOME / DSH_HOME /
//   HERMES_HOME；OpenCode/Pi 无环境变量覆盖。
// - 已存在的路径要 canonicalize（Rust 侧用 `std::fs::canonicalize`）；不存在时保持原状。
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

let homeOverride: string | null = null;

/**
 * 覆盖 `homeDir()` 返回值。**仅供进程内测试**：命令层测试需要把 Agent 用户配置
 * 写到临时目录，不能污染开发机的真实 home。生产路径始终使用 `os.homedir()`。
 */
export function setHomeDirForTests(value: string | null): void {
  homeOverride = value;
}

/** 进程环境下的 home 目录（POSIX 优先 HOME，Windows USERPROFILE；与 dirs 一致）。 */
export function homeDir(): string {
  return homeOverride ?? homedir();
}

/** 读取非空环境变量；空串按未设置处理（Rust `var_os(...).filter(!is_empty)`）。 */
function envPath(name: string): string | null {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : null;
}

function canonicalizeIfExists(target: string): string {
  if (!existsSync(target)) return target;
  try {
    return realpathSync(target);
  } catch (error) {
    throw new Error(`无法解析配置路径 ${displayPath(target)}：${errorText(error)}`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Rust `display_path`：去掉 Windows 的 `\\?\` 扩展前缀，其余原样。 */
export function displayPath(target: string): string {
  const value = target;
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice("\\\\?\\UNC\\".length)}`;
  if (value.startsWith("\\\\?\\")) return value.slice("\\\\?\\".length);
  return value;
}

/** 不区分大小写比较（Windows）；路径先按 display 形式归一（Rust `paths_equal`）。 */
export function pathsEqual(left: string, right: string): boolean {
  const leftValue = displayPath(left);
  const rightValue = displayPath(right);
  return process.platform === "win32"
    ? leftValue.toLowerCase() === rightValue.toLowerCase()
    : leftValue === rightValue;
}

/** URL 归一：去空白、去尾部 `/`、转小写（Rust `normalize_url`）。 */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  return trimmed.toLowerCase();
}

// ─── Claude Code ────────────────────────────────────────────────────────────

export function claudeConfigDir(): string {
  const override = envPath("CLAUDE_CONFIG_DIR");
  if (override !== null) return override;
  return path.join(homeDir(), ".claude");
}

export function claudeSettingsPath(): string {
  return canonicalizeIfExists(path.join(claudeConfigDir(), "settings.json"));
}

// ─── OpenCode ───────────────────────────────────────────────────────────────

export function opencodeSettingsPath(): string {
  const directory = path.join(homeDir(), ".config", "opencode");
  const jsonc = path.join(directory, "opencode.jsonc");
  const json = path.join(directory, "opencode.json");
  let target: string;
  if (isFile(jsonc)) target = jsonc;
  else if (isFile(json)) target = json;
  else target = jsonc;
  return canonicalizeIfExists(target);
}

export function opencodeAuthPath(): string {
  return path.join(homeDir(), ".local", "share", "opencode", "auth.json");
}

export function opencodePermissionPluginPath(): string {
  return path.join(homeDir(), ".config", "opencode", "plugins", "flowlet.ts");
}

// ─── Pi ─────────────────────────────────────────────────────────────────────

export function piAgentPath(fileName: string): string {
  return canonicalizeIfExists(path.join(homeDir(), ".pi", "agent", fileName));
}

export function piSettingsPath(): string {
  return piAgentPath("settings.json");
}

export function piModelsPath(): string {
  return piAgentPath("models.json");
}

export function piAuthPath(): string {
  return piAgentPath("auth.json");
}

export function piExtensionPath(): string {
  return piAgentPath(path.join("extensions", "flowlet.ts"));
}

// ─── Codex ──────────────────────────────────────────────────────────────────

export function codexHome(): string {
  const override = envPath("CODEX_HOME");
  return override !== null ? override : path.join(homeDir(), ".codex");
}

export function codexConfigPath(): string {
  return path.join(codexHome(), "config.toml");
}

export function codexAuthPath(): string {
  return path.join(codexHome(), "auth.json");
}

export function codexModelsPath(): string {
  return path.join(codexHome(), "model-catalog.flowlet.json");
}

// ─── DeepSeek Harness ───────────────────────────────────────────────────────

export function dshHome(): string {
  const override = envPath("DSH_HOME");
  return override !== null ? override : path.join(homeDir(), ".dsh");
}

// ─── Hermes Agent ───────────────────────────────────────────────────────────

export function hermesHome(): string {
  const override = envPath("HERMES_HOME");
  return override !== null ? override : path.join(homeDir(), ".hermes");
}

export function hermesConfigPath(): string {
  return path.join(hermesHome(), "config.yaml");
}

export function hermesEnvPath(): string {
  return path.join(hermesHome(), ".env");
}

export function hermesSessionBridgeDir(configPath: string): string {
  return path.join(path.dirname(configPath), "plugins", "flowlet-session-bridge");
}

/** `.flowlet/` 受管目录（备份文件所在目录）。 */
export function flowletStateDir(baseFile: string): string {
  return path.join(path.dirname(baseFile), ".flowlet");
}