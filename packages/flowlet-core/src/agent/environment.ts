// Agent 安装环境探测。权威实现：
// `src-tauri/src/core/agent_environment.rs` 与 `agent_environment/adapters/*.rs`。
//
// 探测内容：PATH + 官方常见安装位置 + 版本管理器 bin 目录；执行 `--version`
// 读取版本；DSH 额外探测本机 Web 端口与 npx 缓存包。报告字段与 Rust
// `AgentEnvironmentReport` / `AgentInstallation` 逐字段一致（snake_case）。
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import * as fs from "node:fs";
import path from "node:path";

import type { JsonRow } from "../types.ts";
import { dshHome, homeDir } from "./paths.ts";
import { agentDescriptor } from "./registry.ts";

const VERSION_TIMEOUT_MS = 5000;
const DEFAULT_WEB_URL = "http://127.0.0.1:3080";
/** 运行时健康检查地址（Rust `AgentRuntimeAdapter.health_addr`）。 */
let runtimeHealthAddress = "127.0.0.1:3080";

/**
 * 覆盖运行时健康检查地址。仅供进程内测试使用（测试用未监听端口/本地 fixture 服务，
 * 保证不依赖开发机是否真的运行着 DSH Web）。
 */
export function setRuntimeHealthAddressForTests(address: string | null): void {
  runtimeHealthAddress = address ?? "127.0.0.1:3080";
}

export function runtimeHealthAddr(): string {
  return runtimeHealthAddress;
}

/** 覆盖 DSH 安装探测（测试用：避免依赖开发机是否安装 `@deepseek-ai/dsh`）。 */
export function setDshDetectForTests(
  detect: (() => AgentEnvironmentReport | Promise<AgentEnvironmentReport>) | null,
): void {
  dshDetectOverride = detect;
}

let dshDetectOverride:
  | (() => AgentEnvironmentReport | Promise<AgentEnvironmentReport>)
  | null = null;

export type AgentInstallMethod =
  | "native"
  | "winget"
  | "npm"
  | "npx"
  | "bun"
  | "legacy_npm"
  | "homebrew"
  | "system_package"
  | "desktop"
  | "unknown";

export type AgentSurface = "cli" | "desktop" | "web";

export interface AgentInstallation {
  surface: AgentSurface;
  executable_path: string;
  install_dir: string;
  install_method: AgentInstallMethod;
  version: string | null;
  version_output: string | null;
  available_on_path: boolean;
  runner_executable?: string;
  error: string | null;
}

export interface AgentEnvironmentReport {
  agent_id: string;
  agent_name: string;
  installed: boolean;
  runtime_running?: boolean;
  runtime_managed?: boolean;
  runtime_command?: string;
  primary: AgentInstallation | null;
  installations: AgentInstallation[];
}

interface Candidate {
  path: string;
  availableOnPath: boolean;
}

function executableNames(command: string): string[] {
  if (process.platform !== "win32") return [command];
  const extensions = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return extensions
    .split(";")
    .filter((extension) => extension.trim() !== "")
    .map((extension) => `${command}${extension.toLowerCase()}`);
}

function pathDirectories(): string[] {
  const value = process.env.PATH ?? "";
  return value.split(path.delimiter).filter((directory) => directory !== "");
}

function normalizedPathKey(target: string): string {
  const value = target.replace(/\\/gu, "/");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function pushCandidate(
  candidates: Candidate[],
  seen: Set<string>,
  target: string,
  availableOnPath: boolean,
): void {
  if (!isFile(target)) return;
  const resolved = realpathOrSelf(target);
  const key = normalizedPathKey(resolved);
  const existing = candidates.find((candidate) => normalizedPathKey(candidate.path) === key);
  if (existing !== undefined) {
    existing.availableOnPath ||= availableOnPath;
    return;
  }
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({ path: resolved, availableOnPath });
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function displayPath(target: string): string {
  if (target.startsWith("\\\\?\\UNC\\")) return `\\\\${target.slice("\\\\?\\UNC\\".length)}`;
  if (target.startsWith("\\\\?\\")) return target.slice("\\\\?\\".length);
  return target;
}

/** 解析版本输出中的首个语义化数字串（Rust `parse_version`）。 */
export function parseVersion(output: string): string | null {
  for (const part of output.split(/\s+/u)) {
    const trimmed = part
      .replace(/^[^A-Za-z0-9.]+/u, "")
      .replace(/[^A-Za-z0-9.]+$/u, "")
      .replace(/^[vV]/u, "");
    if (trimmed === "") continue;
    if (!/^\d/u.test(trimmed)) continue;
    if (!trimmed.includes(".")) continue;
    if (!/^[0-9.]+$/u.test(trimmed)) continue;
    return trimmed;
  }
  return null;
}

function readPackageVersion(installDir: string): string | null {
  const content = readTextOrNull(path.join(installDir, "package.json"));
  if (content === null) return null;
  try {
    const value: unknown = JSON.parse(content);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const version = (value as JsonRow).version;
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}

function readTextOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function versionCommand(executable: string): { program: string; args: string[] } {
  if (process.platform !== "win32") {
    return { program: executable, args: ["--version"] };
  }
  const extension = path.extname(executable).replace(/^\./u, "").toLowerCase();
  if (extension === "cmd" || extension === "bat") {
    return { program: "cmd.exe", args: ["/D", "/C", executable, "--version"] };
  }
  if (extension === "ps1") {
    return {
      program: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        executable,
        "--version",
      ],
    };
  }
  return { program: executable, args: ["--version"] };
}

function readVersion(executable: string, extraPathDirs: ReadonlyArray<string> = []): {
  version: string | null;
  versionOutput: string | null;
  error: string | null;
} {
  const command = versionCommand(executable);
  const env = { ...process.env };
  if (extraPathDirs.length > 0) {
    const separator = process.platform === "win32" ? ";" : ":";
    env.PATH = `${extraPathDirs.join(separator)}${separator}${env.PATH ?? ""}`;
  }
  const result = spawnSync(command.program, command.args, {
    timeout: VERSION_TIMEOUT_MS,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined && result.error !== null) {
    const message = result.error.message;
    if (/timed?\s*out|ETIMEDOUT/iu.test(message)) {
      return { version: null, versionOutput: null, error: "版本检测超时" };
    }
    return { version: null, versionOutput: null, error: `无法执行版本命令：${message}` };
  }
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const text = stdout !== "" ? stdout : stderr;
  if (result.status !== 0) {
    return {
      version: null,
      versionOutput: null,
      error: text === "" ? `版本命令退出状态：${result.status ?? "signal"}` : text,
    };
  }
  if (text === "") return { version: null, versionOutput: null, error: "版本命令未返回内容" };
  return { version: parseVersion(text), versionOutput: text, error: null };
}

// ─── 候选路径 ───────────────────────────────────────────────────────────────

function claudeCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const directory of pathDirectories()) {
    for (const name of executableNames("claude")) {
      pushCandidate(candidates, seen, path.join(directory, name), true);
    }
  }
  const home = homeDir();
  const known =
    process.platform === "win32"
      ? [".local/bin/claude.exe", ".claude/local/claude.exe", ".claude/local/claude.cmd"]
      : [".local/bin/claude", ".claude/local/claude"];
  for (const relative of known) pushCandidate(candidates, seen, path.join(home, relative), false);
  if (process.platform === "win32" && process.env.APPDATA !== undefined) {
    for (const name of executableNames("claude")) {
      pushCandidate(candidates, seen, path.join(process.env.APPDATA, "npm", name), false);
    }
  }
  return candidates;
}

function opencodeCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const directory of pathDirectories()) {
    for (const name of executableNames("opencode")) {
      pushOpencodeCandidate(candidates, seen, path.join(directory, name), true);
    }
  }
  const home = homeDir();
  const known =
    process.platform === "win32"
      ? [".opencode/bin/opencode.exe", ".local/bin/opencode.exe", ".bun/bin/opencode.exe"]
      : [".opencode/bin/opencode", ".local/bin/opencode", ".bun/bin/opencode"];
  for (const relative of known) pushOpencodeCandidate(candidates, seen, path.join(home, relative), false);
  if (process.platform === "win32" && process.env.APPDATA !== undefined) {
    for (const name of executableNames("opencode")) {
      pushOpencodeCandidate(candidates, seen, path.join(process.env.APPDATA, "npm", name), false);
    }
  }
  return candidates;
}

function pushOpencodeCandidate(
  candidates: Candidate[],
  seen: Set<string>,
  target: string,
  onPath: boolean,
): void {
  if (process.platform === "win32") {
    const extension = path.extname(target).replace(/^\./u, "").toLowerCase();
    if (extension === "cmd" || extension === "ps1") {
      const parent = path.dirname(target);
      if (normalizedPathKey(parent).endsWith("/npm")) {
        const resolved = path.join(parent, "node_modules", "opencode-ai", "bin", "opencode.exe");
        if (isFile(resolved)) pushCandidate(candidates, seen, resolved, onPath);
      }
      return;
    }
  }
  pushCandidate(candidates, seen, target, onPath);
}

function piCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const directory of pathDirectories()) {
    for (const name of executableNames("pi")) {
      pushCandidate(candidates, seen, path.join(directory, name), true);
    }
  }
  const home = homeDir();
  const known =
    process.platform === "win32" ? [".local/bin/pi.exe", ".local/bin/pi.cmd"] : [".local/bin/pi"];
  for (const relative of known) pushCandidate(candidates, seen, path.join(home, relative), false);
  if (process.platform === "win32" && process.env.APPDATA !== undefined) {
    for (const name of executableNames("pi")) {
      pushCandidate(candidates, seen, path.join(process.env.APPDATA, "npm", name), false);
    }
  }
  return candidates;
}

function hermesCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const directory of pathDirectories()) {
    for (const name of executableNames("hermes")) {
      pushCandidate(candidates, seen, path.join(directory, name), true);
    }
  }
  const home = homeDir();
  const known =
    process.platform === "win32"
      ? [
          ".local/bin/hermes.exe",
          ".local/bin/hermes.cmd",
          ".hermes/venv/Scripts/hermes.exe",
          ".hermes/venv/Scripts/hermes.cmd",
        ]
      : [".local/bin/hermes", ".hermes/venv/bin/hermes"];
  for (const relative of known) pushCandidate(candidates, seen, path.join(home, relative), false);
  return candidates;
}

function npmGlobalCodexBinDirs(home: string): string[] {
  const directories = [
    path.join(home, ".npm-global", "bin"),
    path.join(home, "node_modules", ".bin"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, ".bun", "bin"),
  ];
  const nvmVersions = path.join(home, ".nvm", "versions", "node");
  try {
    for (const entry of fs.readdirSync(nvmVersions, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(path.join(nvmVersions, entry.name, "bin"));
    }
  } catch {
    // 目录不存在时忽略。
  }
  return directories;
}

/** 含 `node` 可执行文件的全局 bin 目录（Codex app-server 子进程 PATH 补偿）。 */
export function codexNodeBinDirs(): string[] {
  return npmGlobalCodexBinDirs(homeDir()).filter((directory) =>
    executableNames("node").some((name) => isFile(path.join(directory, name))),
  );
}

function codexCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const directory of pathDirectories()) {
    for (const name of executableNames("codex")) {
      const candidate = path.join(directory, name);
      if (!isExternalCodexCandidate(candidate)) continue;
      pushCodexCandidate(candidates, seen, candidate, true);
    }
  }
  const home = homeDir();
  const known =
    process.platform === "win32" ? [".local/bin/codex.exe"] : [".local/bin/codex"];
  for (const relative of known) {
    pushCodexCandidate(candidates, seen, path.join(home, relative), false);
  }
  for (const directory of npmGlobalCodexBinDirs(home)) {
    for (const name of executableNames("codex")) {
      pushCodexCandidate(candidates, seen, path.join(directory, name), false);
    }
  }
  if (process.platform === "win32") {
    if (process.env.APPDATA !== undefined) {
      for (const name of executableNames("codex")) {
        pushCodexCandidate(candidates, seen, path.join(process.env.APPDATA, "npm", name), false);
      }
    }
    if (process.env.LOCALAPPDATA !== undefined) {
      pushCodexCandidate(
        candidates,
        seen,
        path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
        false,
      );
    }
  }
  return candidates;
}

function isExternalCodexCandidate(target: string): boolean {
  if (process.platform !== "win32") return true;
  return !isWindowsStoreCodexExecutable(target);
}

function isWindowsStoreCodexExecutable(target: string): boolean {
  const normalized = normalizedPathKey(target);
  return (
    (normalized.includes("/windowsapps/openai.codex_") ||
      normalized.includes("/windowsapps/openai.chatgpt-desktop_")) &&
    normalized.endsWith("/app/resources/codex.exe")
  );
}

function pushCodexCandidate(
  candidates: Candidate[],
  seen: Set<string>,
  target: string,
  onPath: boolean,
): void {
  pushCandidate(candidates, seen, resolveWindowsCodexExecutable(target), onPath);
}

function resolveWindowsCodexExecutable(target: string): string {
  if (process.platform !== "win32") return target;
  const extension = path.extname(target).replace(/^\./u, "").toLowerCase();
  if (extension !== "cmd" && extension !== "ps1") return target;
  const npmBin = path.dirname(target);
  if (!normalizedPathKey(npmBin).endsWith("/npm")) return target;
  const arch = process.arch;
  const platformPackage =
    arch === "x64" ? "codex-win32-x64" : arch === "arm64" ? "codex-win32-arm64" : null;
  const triple = arch === "x64" ? "x86_64-pc-windows-msvc" : arch === "arm64" ? "aarch64-pc-windows-msvc" : null;
  if (platformPackage === null || triple === null) return target;
  const packageRoot = path.join(npmBin, "node_modules", "@openai", "codex");
  const candidates = [
    path.join(packageRoot, "node_modules", "@openai", platformPackage, "vendor", triple, "bin", "codex.exe"),
    path.join(packageRoot, "vendor", triple, "bin", "codex.exe"),
  ];
  return candidates.find((candidate) => isFile(candidate)) ?? target;
}

function opencodeDesktopCandidates(): string[] {
  const home = homeDir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData === undefined) return [];
    return [
      path.join(localAppData, "Programs", "@opencode-aidesktop", "OpenCode.exe"),
      path.join(localAppData, "Programs", "OpenCode", "OpenCode.exe"),
    ].filter((candidate) => isFile(candidate));
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/OpenCode.app/Contents/MacOS/OpenCode",
      path.join(home, "Applications", "OpenCode.app", "Contents", "MacOS", "OpenCode"),
    ].filter((candidate) => isFile(candidate));
  }
  return [
    path.join(home, ".local", "bin", "opencode-desktop"),
    path.join(home, "Applications", "OpenCode.AppImage"),
  ].filter((candidate) => isFile(candidate));
}

function dshCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const directory of pathDirectories()) {
    for (const name of executableNames("dsh")) {
      pushCandidate(candidates, seen, path.join(directory, name), true);
    }
  }
  if (process.platform === "win32" && process.env.APPDATA !== undefined) {
    for (const name of executableNames("dsh")) {
      pushCandidate(candidates, seen, path.join(process.env.APPDATA, "npm", name), false);
    }
  }
  return candidates;
}

// ─── 安装方式分类 ───────────────────────────────────────────────────────────

function classifyClaudeMethod(target: string): AgentInstallMethod {
  const normalized = normalizedPathKey(target);
  if (normalized.includes("/.claude/local/")) return "legacy_npm";
  if (normalized.includes("/winget/packages/") || normalized.includes("/microsoft/winget/links/")) {
    return "winget";
  }
  if (
    normalized.includes("/node_modules/@anthropic-ai/claude-code") ||
    normalized.endsWith("/npm/claude.cmd") ||
    normalized.endsWith("/npm/claude.ps1") ||
    normalized.endsWith("/npm/claude")
  ) {
    return "npm";
  }
  if (
    normalized.includes("/homebrew/") ||
    normalized.includes("/cellar/claude-code/") ||
    normalized.includes("/caskroom/claude-code/")
  ) {
    return "homebrew";
  }
  if (normalized.endsWith("/.local/bin/claude") || normalized.endsWith("/.local/bin/claude.exe")) {
    return "native";
  }
  if (normalized.startsWith("/usr/bin/") || normalized.startsWith("/usr/local/bin/")) {
    return "system_package";
  }
  return "unknown";
}

function resolveClaudeInstallDir(target: string, method: AgentInstallMethod): string {
  if (method === "npm") {
    const packageDir = path.join(path.dirname(target), "node_modules", "@anthropic-ai", "claude-code");
    if (isDirectory(packageDir)) return packageDir;
  }
  return path.dirname(target);
}

function classifyOpencodeMethod(target: string): AgentInstallMethod {
  const normalized = normalizedPathKey(target);
  if (normalized.includes("/.bun/bin/")) return "bun";
  if (
    normalized.includes("/node_modules/opencode-ai/") ||
    normalized.endsWith("/npm/opencode.cmd") ||
    normalized.endsWith("/npm/opencode.ps1") ||
    normalized.endsWith("/npm/opencode")
  ) {
    return "npm";
  }
  if (normalized.includes("/homebrew/") || normalized.includes("/cellar/opencode/")) return "homebrew";
  if (normalized.includes("/.opencode/bin/") || normalized.includes("/.local/bin/")) return "native";
  if (normalized.startsWith("/usr/bin/") || normalized.startsWith("/usr/local/bin/")) {
    return "system_package";
  }
  return "unknown";
}

function resolveOpencodeInstallDir(target: string, method: AgentInstallMethod): string {
  if (method === "npm" && normalizedPathKey(target).includes("/node_modules/opencode-ai/bin/")) {
    return path.dirname(path.dirname(target));
  }
  return path.dirname(target);
}

function classifyPiMethod(target: string): AgentInstallMethod {
  const normalized = normalizedPathKey(target);
  if (
    normalized.includes("/node_modules/@earendil-works/pi-coding-agent") ||
    normalized.endsWith("/npm/pi.cmd") ||
    normalized.endsWith("/npm/pi.ps1") ||
    normalized.endsWith("/npm/pi")
  ) {
    return "npm";
  }
  if (normalized.endsWith("/.local/bin/pi") || normalized.endsWith("/.local/bin/pi.exe")) return "native";
  if (normalized.startsWith("/usr/bin/") || normalized.startsWith("/usr/local/bin/")) {
    return "system_package";
  }
  return "unknown";
}

function resolvePiInstallDir(target: string, method: AgentInstallMethod): string {
  if (method === "npm") {
    const packageDir = path.join(
      path.dirname(target),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    if (isDirectory(packageDir)) return packageDir;
  }
  return path.dirname(target);
}

function classifyCodexMethod(target: string): AgentInstallMethod {
  const normalized = normalizedPathKey(target).toLowerCase();
  if (
    normalized.includes("/node_modules/@openai/codex/") ||
    normalized.endsWith("/npm/codex.cmd") ||
    normalized.endsWith("/npm/codex.ps1") ||
    normalized.endsWith("/npm/codex")
  ) {
    return "npm";
  }
  if (normalized.includes("/homebrew/") || normalized.includes("/cellar/codex/")) return "homebrew";
  if (
    normalized.endsWith("/.local/bin/codex") ||
    normalized.endsWith("/.local/bin/codex.exe") ||
    normalized.includes("/programs/openai/codex/bin/") ||
    (normalized.includes("/.codex/packages/standalone/releases/") &&
      (normalized.endsWith("/bin/codex") || normalized.endsWith("/bin/codex.exe")))
  ) {
    return "native";
  }
  if (normalized.startsWith("/usr/bin/") || normalized.startsWith("/usr/local/bin/")) {
    return "system_package";
  }
  return "unknown";
}

function resolveCodexInstallDir(target: string, method: AgentInstallMethod): string {
  if (method === "npm") {
    const packageDir = path.join(path.dirname(target), "node_modules", "@openai", "codex");
    if (isDirectory(packageDir)) return packageDir;
  }
  return path.dirname(target);
}

function classifyHermesMethod(target: string): AgentInstallMethod {
  const normalized = normalizedPathKey(target);
  if (
    normalized.includes("/.hermes/venv/") ||
    normalized.endsWith("/.local/bin/hermes") ||
    normalized.endsWith("/.local/bin/hermes.exe")
  ) {
    return "native";
  }
  if (normalized.includes("/homebrew/") || normalized.includes("/cellar/hermes/")) return "homebrew";
  if (normalized.startsWith("/usr/bin/") || normalized.startsWith("/usr/local/bin/")) {
    return "system_package";
  }
  return "unknown";
}

function classifyDshMethod(target: string): AgentInstallMethod {
  const normalized = normalizedPathKey(target);
  if (normalized.includes("/_npx/")) return "npx";
  if (
    normalized.includes("/node_modules/@deepseek-ai/dsh/") ||
    normalized.includes("/node_modules/.bin/dsh") ||
    normalized.endsWith("/npm/dsh.cmd") ||
    normalized.endsWith("/npm/dsh.ps1") ||
    normalized.endsWith("/npm/dsh")
  ) {
    return "npm";
  }
  if (normalized.startsWith("/usr/bin/") || normalized.startsWith("/usr/local/bin/")) {
    return "system_package";
  }
  return "unknown";
}

function resolveDshInstallDir(target: string, method: AgentInstallMethod): string {
  if (method === "npm" || method === "npx") {
    if (normalizedPathKey(target).includes("/node_modules/.bin/")) {
      const nodeModules = path.dirname(path.dirname(target));
      const packageDir = path.join(nodeModules, "@deepseek-ai", "dsh");
      if (isDirectory(packageDir)) return packageDir;
    }
    const packageDir = path.join(path.dirname(target), "node_modules", "@deepseek-ai", "dsh");
    if (isDirectory(packageDir)) return packageDir;
  }
  return path.dirname(target);
}

// ─── 安装项构造 ─────────────────────────────────────────────────────────────

function installationForCandidate(
  candidate: Candidate,
  surface: AgentSurface,
  classify: (target: string) => AgentInstallMethod,
  resolveInstallDir: (target: string, method: AgentInstallMethod) => string,
  readVersionOptions: { extraPathDirs?: ReadonlyArray<string>; packageFallback?: boolean } = {},
): AgentInstallation {
  const method = classify(candidate.path);
  const installDir = resolveInstallDir(candidate.path, method);
  const packageVersion = readVersionOptions.packageFallback === true ? readPackageVersion(installDir) : null;
  const versionResult = readVersion(candidate.path, readVersionOptions.extraPathDirs ?? []);
  let version = versionResult.version;
  let versionOutput = versionResult.versionOutput;
  let error = versionResult.error;
  if (versionResult.error !== null && packageVersion !== null) {
    version = packageVersion;
    versionOutput = null;
    error = null;
  } else if (versionResult.error === null && version === null && packageVersion !== null) {
    version = packageVersion;
  }
  return {
    surface,
    executable_path: displayPath(candidate.path),
    install_dir: displayPath(installDir),
    install_method: method,
    version,
    version_output: versionOutput,
    available_on_path: candidate.availableOnPath,
    error,
  };
}

function pickPrimary(
  installations: ReadonlyArray<AgentInstallation>,
  preferred: (installation: AgentInstallation) => boolean = () => true,
): AgentInstallation | null {
  const available = installations.filter(preferred);
  return (
    available.find((item) => item.available_on_path && item.version !== null) ??
    available.find((item) => item.version !== null) ??
    available.find((item) => item.available_on_path) ??
    available[0] ??
    installations[0] ??
    null
  );
}

// ─── 各 Agent 探测 ─────────────────────────────────────────────────────────

function detectClaude(): AgentEnvironmentReport {
  const installations = claudeCandidates().map((candidate) =>
    installationForCandidate(candidate, "cli", classifyClaudeMethod, resolveClaudeInstallDir),
  );
  return {
    agent_id: "claude-code",
    agent_name: "Claude Code CLI",
    installed: installations.length > 0,
    primary: pickPrimary(installations),
    installations,
  };
}

function detectOpencode(): AgentEnvironmentReport {
  const installations = opencodeCandidates().map((candidate) =>
    installationForCandidate(candidate, "cli", classifyOpencodeMethod, resolveOpencodeInstallDir),
  );
  for (const executable of opencodeDesktopCandidates()) {
    installations.push({
      surface: "desktop",
      executable_path: displayPath(executable),
      install_dir: displayPath(path.dirname(executable)),
      install_method: "desktop",
      version: desktopVersion(executable),
      version_output: null,
      available_on_path: false,
      error: null,
    });
  }
  const primary =
    installations.find((item) => item.surface === "cli" && item.available_on_path && item.version !== null) ??
    installations.find((item) => item.surface === "cli" && item.version !== null) ??
    installations.find((item) => item.surface === "desktop" && item.version !== null) ??
    installations.find((item) => item.surface === "cli" && item.available_on_path && item.error === null) ??
    installations[0] ??
    null;
  return {
    agent_id: "opencode",
    agent_name: "OpenCode",
    installed: installations.length > 0,
    primary,
    installations,
  };
}

function detectPi(): AgentEnvironmentReport {
  const installations = piCandidates().map((candidate) =>
    installationForCandidate(candidate, "cli", classifyPiMethod, resolvePiInstallDir, {
      packageFallback: true,
    }),
  );
  return {
    agent_id: "pi",
    agent_name: "Pi",
    installed: installations.length > 0,
    primary: pickPrimary(installations),
    installations,
  };
}

function detectHermes(): AgentEnvironmentReport {
  const installations = hermesCandidates().map((candidate) =>
    installationForCandidate(candidate, "cli", classifyHermesMethod, (target) => path.dirname(target)),
  );
  return {
    agent_id: "hermes",
    agent_name: "Hermes Agent CLI",
    installed: installations.length > 0,
    primary: pickPrimary(installations),
    installations,
  };
}

async function detectCodex(): Promise<AgentEnvironmentReport> {
  const installations: AgentInstallation[] = [];
  for (const candidate of codexCandidates()) {
    installations.push(
      installationForCandidate(candidate, "cli", classifyCodexMethod, resolveCodexInstallDir, {
        packageFallback: true,
        extraPathDirs: codexNodeBinDirs(),
      }),
    );
  }
  installations.push(...chatgptDesktopInstallations());
  const primary =
    installations.find((item) => item.surface === "cli" && item.available_on_path && item.version !== null) ??
    installations.find((item) => item.surface === "cli") ??
    installations[0] ??
    null;
  return {
    agent_id: "chatgpt-desktop",
    agent_name: "ChatGPT (Codex)",
    installed: installations.length > 0,
    primary,
    installations,
  };
}

function chatgptDesktopInstallations(): AgentInstallation[] {
  if (process.platform === "win32") {
    // Windows AppX 查询需要 PowerShell；桌面宿主场景可用，失败时返回空列表。
    const script =
      "$found=$false;$p=Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue;" +
      "if($null -eq $p){$p=Get-AppxPackage -Name 'OpenAI.ChatGPT-Desktop' -ErrorAction SilentlyContinue};" +
      "if($null -ne $p){[Console]::Out.Write($p.Version.ToString()+[char]9+$p.InstallLocation)}";
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: VERSION_TIMEOUT_MS,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) return [];
    const [version, installDir] = (result.stdout ?? "").trim().split("\t");
    if (version === undefined || version === "" || installDir === undefined || installDir === "") return [];
    const executable = path.join(installDir, "app", "ChatGPT.exe");
    return [
      {
        surface: "desktop",
        executable_path: displayPath(executable),
        install_dir: displayPath(installDir),
        install_method: "desktop",
        version,
        version_output: null,
        available_on_path: false,
        error: null,
      },
    ];
  }
  if (process.platform === "darwin") {
    const home = homeDir();
    const apps = ["/Applications/ChatGPT.app", path.join(home, "Applications", "ChatGPT.app")];
    return apps
      .filter((app) => isDirectory(app))
      .map((app) => {
        const plist = readTextOrNull(path.join(app, "Contents", "Info.plist"));
        const version =
          plist === null
            ? null
            : parsePlistString(plist, "CFBundleShortVersionString") ??
              parsePlistString(plist, "CFBundleVersion");
        return {
          surface: "desktop" as AgentSurface,
          executable_path: displayPath(path.join(app, "Contents", "MacOS", "ChatGPT")),
          install_dir: displayPath(app),
          install_method: "desktop" as AgentInstallMethod,
          version,
          version_output: null,
          available_on_path: false,
          error: null,
        };
      });
  }
  const home = homeDir();
  const executables = [
    "/usr/lib/chatgpt/ChatGPT",
    path.join(home, ".local", "bin", "chatgpt"),
    path.join(home, "Applications", "ChatGPT.AppImage"),
  ].filter((executable) => isFile(executable));
  return executables.map((executable) => {
    const installDir = path.dirname(executable);
    const versionText = readTextOrNull(path.join(installDir, "version"));
    return {
      surface: "desktop" as AgentSurface,
      executable_path: displayPath(executable),
      install_dir: displayPath(installDir),
      install_method: "desktop" as AgentInstallMethod,
      version: versionText === null ? null : versionText.trim() === "" ? null : versionText.trim(),
      version_output: null,
      available_on_path: false,
      error: null,
    };
  });
}

function parsePlistString(content: string, key: string): string | null {
  const marker = `<key>${key}</key>`;
  const index = content.indexOf(marker);
  if (index < 0) return null;
  const rest = content.slice(index + marker.length);
  const start = rest.indexOf("<string>");
  if (start < 0) return null;
  const end = rest.indexOf("</string>", start);
  if (end < 0) return null;
  const value = rest.slice(start + "<string>".length, end).trim();
  return value === "" ? null : value;
}

function desktopVersion(executable: string): string | null {
  const packageJson = path.join(path.dirname(executable), "resources", "app", "package.json");
  const content = readTextOrNull(packageJson);
  if (content === null) return null;
  try {
    const value: unknown = JSON.parse(content);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const version = (value as JsonRow).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function dshNpxCacheRoots(): string[] {
  const roots: string[] = [];
  for (const key of ["NPM_CONFIG_CACHE", "npm_config_cache"]) {
    const value = process.env[key];
    if (value !== undefined && value !== "") roots.push(value);
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA !== undefined) {
    roots.push(path.join(process.env.LOCALAPPDATA, "npm-cache"));
  } else {
    roots.push(path.join(homeDir(), ".npm"));
  }
  return [...new Set(roots)].sort();
}

function unambiguousNpxPackage(cacheRoots: ReadonlyArray<string>): { packageDir: string; version: string } | null {
  const packages: Array<{ packageDir: string; version: string }> = [];
  const versions = new Set<string>();
  for (const cacheRoot of cacheRoots) {
    const npxRoot = path.join(cacheRoot, "_npx");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(npxRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packageDir = path.join(npxRoot, entry.name, "node_modules", "@deepseek-ai", "dsh");
      const version = readPackageVersion(packageDir);
      if (version === null) continue;
      versions.add(version);
      packages.push({ packageDir, version });
    }
  }
  return versions.size === 1 ? (packages[0] ?? null) : null;
}

function npxBinEntry(packageDir: string): string | null {
  const content = readTextOrNull(path.join(packageDir, "package.json"));
  if (content === null) return null;
  let value: JsonRow;
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    value = parsed as JsonRow;
  } catch {
    return null;
  }
  const bin = value.bin;
  let entry: string | null = null;
  if (typeof bin === "string") entry = bin;
  else if (bin !== null && typeof bin === "object" && !Array.isArray(bin)) {
    const row = bin as JsonRow;
    entry = typeof row.dsh === "string" ? row.dsh : null;
    if (entry === null) {
      for (const candidate of Object.values(row)) {
        if (typeof candidate === "string") {
          entry = candidate;
          break;
        }
      }
    }
  }
  if (entry === null) return null;
  const resolved = path.join(packageDir, entry);
  return isFile(resolved) ? resolved : null;
}

export async function runtimeReachable(address: string): Promise<boolean> {
  const [host, port] = address.split(":");
  if (host === undefined || port === undefined) return false;
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port: Number(port) });
    const finish = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(800, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function detectDsh(): Promise<AgentEnvironmentReport> {
  const installations: AgentInstallation[] = [];
  for (const candidate of dshCandidates()) {
    const method = classifyDshMethod(candidate.path);
    const installDir = resolveDshInstallDir(candidate.path, method);
    const packageVersion = readPackageVersion(installDir);
    const versionResult = readVersion(candidate.path);
    installations.push({
      surface: "web",
      executable_path: displayPath(candidate.path),
      install_dir: displayPath(installDir),
      install_method: method,
      version: versionResult.version ?? packageVersion,
      version_output: versionResult.versionOutput,
      available_on_path: candidate.availableOnPath === true,
      error: versionResult.version === null && packageVersion !== null ? null : versionResult.error,
    });
  }
  const webRunning = await runtimeReachable(runtimeHealthAddress);
  if (installations.length === 0) {
    const dataHome = (() => {
      try {
        return dshHome();
      } catch {
        return null;
      }
    })();
    const dataHomeExists = dataHome !== null && isDirectory(dataHome);
    if (webRunning || dataHomeExists) {
      const npxPackage = unambiguousNpxPackage(dshNpxCacheRoots());
      const binEntry = npxPackage === null ? null : npxBinEntry(npxPackage.packageDir);
      let executablePath: string;
      let installDir: string;
      if (npxPackage !== null && binEntry !== null) {
        executablePath = displayPath(binEntry);
        installDir = displayPath(npxPackage.packageDir);
      } else if (npxPackage !== null) {
        executablePath = DEFAULT_WEB_URL;
        installDir = displayPath(npxPackage.packageDir);
      } else {
        executablePath = DEFAULT_WEB_URL;
        installDir = dataHomeExists && dataHome !== null ? displayPath(dataHome) : DEFAULT_WEB_URL;
      }
      let error: string | null = null;
      if (npxPackage !== null && binEntry === null) {
        error = "在 npm 缓存中找到 @deepseek-ai/dsh，但无法解析包的可执行入口；建议全局安装后重试";
      } else if (npxPackage === null) {
        error = webRunning
          ? "Web 正在运行，但 npm 缓存中没有唯一版本的 @deepseek-ai/dsh；无法据此执行 headless 任务，请全局安装后重试。当前接入与会话观测不受影响。"
          : "检测到 Harness 数据目录，但没有可用于执行任务的 @deepseek-ai/dsh；请全局安装后重试。";
      }
      installations.push({
        surface: "web",
        executable_path: executablePath,
        install_dir: installDir,
        install_method: npxPackage !== null ? "npx" : "unknown",
        version: npxPackage?.version ?? null,
        version_output: null,
        available_on_path: false,
        runner_executable: binEntry === null ? undefined : displayPath(binEntry),
        error,
      });
    }
  }
  const primary =
    installations.find((item) => item.available_on_path && item.error === null) ??
    installations[0] ??
    null;
  return {
    agent_id: "deepseek-harness",
    agent_name: "DeepSeek Harness",
    installed: installations.length > 0,
    runtime_running: webRunning,
    primary,
    installations,
  };
}

const DETECTORS: Record<string, () => AgentEnvironmentReport | Promise<AgentEnvironmentReport>> = {
  "claude-code": detectClaude,
  opencode: detectOpencode,
  pi: detectPi,
  "chatgpt-desktop": detectCodex,
  "deepseek-harness": detectDsh,
  hermes: detectHermes,
};

/** 探测 Agent 环境；未知 Agent 报 Rust 对齐错误（`暂不支持检测 Agent：<id>`）。 */
export async function detectAgentEnvironment(agentId: string): Promise<AgentEnvironmentReport> {
  const descriptor = agentDescriptor(agentId);
  const environmentId = descriptor?.environmentAdapterId ?? agentId;
  const detector =
    environmentId === "deepseek-harness" && dshDetectOverride !== null
      ? dshDetectOverride
      : DETECTORS[environmentId];
  if (detector === undefined) throw new Error(`暂不支持检测 Agent：${agentId}`);
  const report = await detector();
  if (descriptor !== undefined) {
    report.agent_id = descriptor.id;
    report.agent_name = descriptor.name;
  }
  return report;
}

/** DSH 运行时的可读启动命令（Rust `AgentRuntimeManager::enrich_report`）。 */
export function runtimeCommandFor(report: AgentEnvironmentReport): string | undefined {
  const installation = report.primary;
  if (installation === null || installation.error !== null) return undefined;
  if (installation.install_method === "npx") return "npx @deepseek-ai/dsh web --no-open";
  if (
    installation.install_method === "npm" ||
    installation.install_method === "native" ||
    installation.install_method === "system_package"
  ) {
    return "dsh web --no-open";
  }
  return undefined;
}