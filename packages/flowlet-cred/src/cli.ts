#!/usr/bin/env node
// `flowlet`：Flowlet 全局凭据库的 Node 入口。Owner: node-web.
//
// 权威实现：src-tauri/src/bin/flowlet_cred.rs（Rust legacy 二进制名仍为 `flowlet-cred`，
// 仅用于兼容性对拍）+ core/credential_store.rs + core/gitlab.rs + core/dockhand.rs。
// Node 版为默认实现（不再需要 Rust 产物）；Rust 版标 legacy。
//
// 与 Rust 的刻意差异（docs/credential-cli.md §3）：
// - `get` 默认掩码，`--reveal` 才输出明文（安全默认）；`--mask` 仍兼容；
// - 额外提供 `clear` 清空全部凭据（保留注释与文件头）；
// - `gitlab` / `dockhand` / `jenkins` / `beszel` / `uptime-kuma` 子命令支持 `--profile` 多实例
//   （键名 {PREFIX}_URL/{PREFIX}_TOKEN，jenkins 额外有 {PREFIX}_USER，beszel 用 _EMAIL/_PASSWORD，
//   uptime-kuma 用 _API_KEY）。
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { Agent, request } from "undici";

import {
  AuthStore,
  DEFAULT_LOGIN_TIMEOUT_SECONDS,
  MAX_AUTH_NAME_LENGTH,
  loginWithBrowser,
  normalizeServer,
} from "./auth.ts";
import {
  DockhandClient,
  DockhandError,
  normalizeBaseUrl as normalizeDockhandBaseUrl,
  type DockhandEnvironment,
} from "./dockhand.ts";
import { GitlabClient, GitlabError, normalizeBaseUrl, type ProjectSummary } from "./gitlab.ts";
import {
  JenkinsClient,
  JenkinsError,
  normalizeBaseUrl as normalizeJenkinsBaseUrl,
  type JenkinsIdentity,
} from "./jenkins.ts";
import {
  BeszelClient,
  BeszelError,
  normalizeBaseUrl as normalizeBeszelBaseUrl,
  type BeszelAuth,
  type BeszelSystem,
  type BeszelSystems,
} from "./beszel.ts";
import {
  UptimeKumaClient,
  UptimeKumaError,
  normalizeBaseUrl as normalizeUptimeKumaBaseUrl,
  summarizeMetrics,
  type KumaMetrics,
} from "./uptime-kuma.ts";
import { CredentialStore, nowRfc3339, type ExportFormat } from "./store.ts";

const GITLAB_DEFAULT_PREFIX = "GITLAB";
const DOCKHAND_DEFAULT_PREFIX = "DOCKHAND";
const JENKINS_DEFAULT_PREFIX = "JENKINS";
const BESZEL_DEFAULT_PREFIX = "BESZEL";
const UPTIME_KUMA_DEFAULT_PREFIX = "UPTIME_KUMA";

const USAGE = `flowlet — Flowlet 全局凭据库

用法：
  flowlet init                              初始化凭据目录
  flowlet path                              打印凭据文件路径
  flowlet list [--json]                     列出凭据名（永不含明文值）
  flowlet get <KEY> [--reveal]              输出单个凭据值（默认掩码）
  flowlet set <KEY> [--kind=K] [--note=N]   新增/更新（值从 stdin 读取，或 --value=V）
  flowlet unset <KEY>                       删除
  flowlet clear                             清空全部凭据（保留注释）
  flowlet env [--only=A,B]                  输出 dotenv，可 eval/写入其它 .env
  flowlet export [--only=A,B] [--format=dotenv|shell|json]
  flowlet run --with=A,B -- <程序> [参数...]  只把指定凭据注入子进程环境
  flowlet doctor                            检查权限、重复键与元数据

GitLab（API v4，按 GitLab CE 10.8.7 实现）：
  flowlet gitlab set --url=https://gitlab.example.com [--profile=WORK]  token 从 stdin 读取并校验
  flowlet gitlab status [--insecure] [--profile=WORK]                   用户、版本、API 地址
  flowlet gitlab projects [--search=S] [--limit=N] [--all] [--json] [--profile=WORK]
  flowlet gitlab api <METHOD> <PATH> [--data=JSON] [--profile=WORK]     透传 10.8 已存在的端点
  flowlet gitlab env [--profile=WORK]                                   输出 {PREFIX}_URL / {PREFIX}_TOKEN
  flowlet gitlab clear [--profile=WORK]                                 移除对应前缀的 GitLab 凭据

Dockhand（Docker 管理面板，Bearer API Token）：
  flowlet dockhand set --url=http://dockhand.example.com:3000 [--profile=NA]  token 从 stdin 读取并校验
  flowlet dockhand status [--insecure] [--profile=NA]                  实例 health、环境数量/名称、Docker 版本
  flowlet dockhand envs [--json] [--profile=NA]                        列出环境（id/name/host/port/protocol）
  flowlet dockhand stacks --env=2 [--json] [--profile=NA]              列出 stack（name + 容器数）
  flowlet dockhand api <METHOD> <PATH> [--data=JSON] [--profile=NA]    透传（PATH 可带 /api 前缀/query）
  flowlet dockhand env [--profile=NA]                                  输出 {PREFIX}_URL / {PREFIX}_TOKEN
  flowlet dockhand clear [--profile=NA]                                移除对应前缀的 Dockhand 凭据

Jenkins（REST API，Basic 用户名 + API Token）：
  flowlet jenkins set --url=https://jenkins.example.com --user=NAME [--profile=CI]  token 从 stdin 读取并校验
  flowlet jenkins status [--insecure] [--profile=CI]                   URL、版本（X-Jenkins）、当前用户
  flowlet jenkins api <METHOD> <PATH> [--data=JSON] [--profile=CI]     透传（只接受相对路径，不自动加 /api）
  flowlet jenkins env [--profile=CI]                                   输出 {PREFIX}_URL / {PREFIX}_USER / {PREFIX}_TOKEN
  flowlet jenkins clear [--profile=CI]                                 移除对应前缀的 Jenkins 凭据

Beszel（服务器监控 Hub，邮箱 + 密码换短期 token）：
  flowlet beszel set --url=http://beszel.example.com:8090 --email=you@example.com [--profile=MON]
                                           密码从 stdin 读取；先认证校验通过才落库
  flowlet beszel status [--insecure] [--profile=MON]        URL、版本、登录邮箱、系统数量
  flowlet beszel systems [--json] [--profile=MON]           系统列表（id/name/host/status/port）
  flowlet beszel api <METHOD> <PATH> [--data=JSON] [--profile=MON]  透传（PATH 可带 /api 前缀/query）
  flowlet beszel env [--profile=MON]                        输出 {PREFIX}_URL / _EMAIL / _PASSWORD
  flowlet beszel clear [--profile=MON]                      移除对应前缀的 Beszel 凭据

Uptime Kuma（Prometheus /metrics 只读，Basic 空用户名 + API Key）：
  flowlet uptime-kuma set --url=https://host/uptime-kuma [--profile=TW]  token 从 stdin 读取并校验
  flowlet uptime-kuma status [--insecure] [--profile=TW]                指标/版本/监控 up-down 数量
  flowlet uptime-kuma monitors [--json] [--insecure] [--profile=TW]     从 /metrics 解析监控项状态（只读）
  flowlet uptime-kuma env [--profile=TW]                                输出 {PREFIX}_URL / {PREFIX}_API_KEY
  flowlet uptime-kuma clear [--profile=TW]                              移除对应前缀的 Uptime Kuma 凭据
  （2.x 没有监控管理 REST API：API Key 只用于指标鉴权，不能创建/暂停监控）

远程同步（Docker / 服务端管理的凭据 → 本机 .env）：
  flowlet login --server=http://10.100.217.60:20134 [--name=机器名] [--no-browser] [--insecure] [--timeout=180]
                                            浏览器授权（登录管理台后确认），只保存仅能读服务凭据的本机授权
  flowlet logout --server=http://10.100.217.60:20134
                                            删除本机该 server 的授权记录
  flowlet pull --server=http://10.100.217.60:20134 [--token=管理凭据] [--dry-run] [--insecure]
                                            同步服务端启用中的服务凭据到本机 .env

说明：
  - 值永远不会被 list 打印；set 时建议通过 stdin 传值，避免出现在进程列表里。
  - \`run\` 是推荐用法：Agent 不需要看到明文，只要让命令用上凭据。
  - 凭据类型（--kind）目前只是标签，默认 api_key。
  - --profile 生成 {PREFIX}_URL / {PREFIX}_TOKEN；省略时用 provider 默认前缀（GITLAB / DOCKHAND / JENKINS / BESZEL / UPTIME_KUMA）。
    jenkins 额外生成 {PREFIX}_USER；beszel 生成 {PREFIX}_EMAIL / {PREFIX}_PASSWORD；uptime-kuma 的 token 键是 {PREFIX}_API_KEY。
    同一 provider 多实例必须使用不同 --profile（如 --profile=na / --profile=sz / --profile=self）。
  - pull 的凭据优先级：--token > FLOWLET_ADMIN_TOKEN > 本机授权（flowlet login 保存的 auth.json）。
    OIDC-only 实例不开启管理 Bearer，请先用 flowlet login 登录；本机授权过期/被撤销时重新执行 login。
`;

const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

// ─── 输出 / 参数解析（对齐 Rust println!/eprintln! 与参数 helper） ─────────

function out(text: string): void {
  process.stdout.write(text);
}

function outLine(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function errLine(text = ""): void {
  process.stderr.write(`${text}\n`);
}

function positional(args: string[], index: number): string {
  const found = args.filter((arg) => !arg.startsWith("-"))[index];
  if (found === undefined) throw new Error("缺少参数");
  return found;
}

function positionalOptional(args: string[], index: number): string | null {
  return args.filter((arg) => !arg.startsWith("-"))[index] ?? null;
}

function flagPresent(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** 支持 `--name=value` 与 `--name value` 两种写法（与 Rust option_value 一致）。 */
function optionValue(args: string[], name: string): string | null {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === name) return args[index + 1] ?? null;
  }
  return null;
}

interface ProfileContext {
  /** 环境变量前缀：显式 profile 时为 `{默认前缀}_{ALIAS}`，否则为 provider 默认前缀。 */
  prefix: string;
  /** 显式 `--profile` 的大写别名；未传为 null。 */
  profile: string | null;
}

/**
 * 解析 `--profile=<alias>`（phase2 契约 §2.2）：
 * - 未传/空 → provider 默认前缀（GITLAB / DOCKHAND / JENKINS，与第一期完全兼容）；
 * - 否则转大写并按环境变量前缀规则校验，再组合成 `{默认前缀}_{ALIAS}`：
 *   `--profile=work`（gitlab）→ 键 `GITLAB_WORK_URL` / `GITLAB_WORK_TOKEN`。
 */
function resolveProfile(args: string[], defaultPrefix: string): ProfileContext {
  const raw = optionValue(args, "--profile");
  if (raw === null) return { prefix: defaultPrefix, profile: null };
  const alias = raw.trim().toUpperCase();
  if (alias === "") return { prefix: defaultPrefix, profile: null };
  if (!/^[A-Z][A-Z0-9_]{0,23}$/.test(alias)) {
    throw new Error("--profile 只能包含字母、数字和下划线，且以字母开头");
  }
  return { prefix: `${defaultPrefix}_${alias}`, profile: alias };
}

type CredentialProvider = "gitlab" | "dockhand" | "jenkins" | "beszel" | "uptime-kuma";

interface ProfileKeys {
  /** 地址键：所有 provider 都是 `{prefix}_URL`。 */
  urlKey: string;
  /** 用户名/邮箱键：jenkins → `{prefix}_USER`，beszel → `{prefix}_EMAIL`；其它 provider 空串。 */
  userKey: string;
  /** 令牌/密码键：默认 `{prefix}_TOKEN`，beszel → `{prefix}_PASSWORD`，uptime-kuma → `{prefix}_API_KEY`。 */
  tokenKey: string;
}

/**
 * 前缀决定本机存储键与 pull 写入的变量名（按 provider 泛化）：
 * - gitlab / dockhand：`_URL` / `_TOKEN`；
 * - jenkins：`_URL` / `_USER` / `_TOKEN`；
 * - beszel：`_URL` / `_EMAIL` / `_PASSWORD`；
 * - uptime-kuma：`_URL` / `_API_KEY`。
 * 不传 provider 时保持旧行为（URL/USER/TOKEN）：GitLab/Dockhand 只读 urlKey/tokenKey，
 * Jenkins 读三把，与第一~三期逐字节兼容。
 */
function profileKeys(prefix: string, provider?: CredentialProvider): ProfileKeys {
  switch (provider) {
    case "gitlab":
    case "dockhand":
      return { urlKey: `${prefix}_URL`, userKey: "", tokenKey: `${prefix}_TOKEN` };
    case "jenkins":
      return { urlKey: `${prefix}_URL`, userKey: `${prefix}_USER`, tokenKey: `${prefix}_TOKEN` };
    case "beszel":
      return { urlKey: `${prefix}_URL`, userKey: `${prefix}_EMAIL`, tokenKey: `${prefix}_PASSWORD` };
    case "uptime-kuma":
      return { urlKey: `${prefix}_URL`, userKey: "", tokenKey: `${prefix}_API_KEY` };
    default:
      // 不传 provider 时保持旧行为（URL/USER/TOKEN）；GitLab/Dockhand 只读 urlKey/tokenKey，
      // Jenkins 读三把，与第一~三期逐字节兼容。
      return { urlKey: `${prefix}_URL`, userKey: `${prefix}_USER`, tokenKey: `${prefix}_TOKEN` };
  }
}

/**
 * set 成功文案：只有显式传了 `--profile` 才拼生效别名。
 * 无 `--profile` 时保持第一期文案，Rust legacy 对拍（compat.mjs）逐字节一致。
 */
function profileDescription(profile: ProfileContext): string {
  return profile.profile === null ? "" : `（profile: ${profile.profile}）`;
}

/** 错误提示里补上 `--profile=<别名>`，避免用户重跑时漏掉 profile。 */
function profileHint(profile: ProfileContext): string {
  return profile.profile === null ? "" : ` --profile=${profile.profile}`;
}

function storedValue(store: CredentialStore, key: string): string | null {
  const value = store.get(key)?.trim() ?? "";
  return value === "" ? null : value;
}

function parseKeyList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function readStdinValue(): string {
  try {
    return readFileSync(0, "utf8").replace(/[\r\n]+$/, "");
  } catch (error) {
    throw new Error(`读取 stdin 失败：${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mask(value: string): string {
  const chars = [...value];
  if (chars.length <= 8) return "•".repeat(Math.min(chars.length, 8));
  const head = chars.slice(0, 4).join("");
  const tail = chars.slice(chars.length - 4).join("");
  return `${head}…${tail}`;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** serde_json::Value 的对象键是 BTreeMap（字典序）；透传端点输出必须按此排序。 */
function prettyJsonSorted(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// ─── 入口 ───────────────────────────────────────────────────────────────────

async function run(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);
  if (command === undefined) {
    out(USAGE);
    return 0;
  }
  switch (command) {
    case "-h":
    case "--help":
    case "help":
      out(USAGE);
      return 0;
    case "-V":
    case "--version":
    case "version":
      outLine(`flowlet ${VERSION}`);
      return 0;
    case "init": {
      const store = openStore();
      store.init();
      outLine(`已初始化：${store.envPath()}`);
      return 0;
    }
    case "path":
      outLine(openStore().envPath());
      return 0;
    case "list":
      return listCommand(rest);
    case "get":
      return getCommand(rest);
    case "set":
      return setCommand(rest);
    case "unset":
    case "rm":
      return unsetCommand(rest);
    case "clear":
      return clearCommand();
    case "env":
      return envCommand(rest);
    case "export":
      return exportCommand(rest);
    case "run":
      return runCommand(rest);
    case "doctor": {
      for (const line of openStore().doctor()) outLine(line);
      return 0;
    }
    case "pull":
      return pullCommand(rest);
    case "login":
      return loginCommand(rest);
    case "logout":
      return logoutCommand(rest);
    case "gitlab":
      return gitlabCommand(rest);
    case "dockhand":
      return dockhandCommand(rest);
    case "jenkins":
      return jenkinsCommand(rest);
    case "beszel":
      return beszelCommand(rest);
    case "uptime-kuma":
      return uptimeKumaCommand(rest);
    default:
      throw new Error(`未知命令：${command}\n\n${USAGE}`);
  }
}

function openStore(): CredentialStore {
  return CredentialStore.fromDefaultDir();
}

// ─── 本地凭据命令 ───────────────────────────────────────────────────────────

function listCommand(args: string[]): number {
  const store = openStore();
  const json = flagPresent(args, "--json");
  const entries = store.list();
  if (json) {
    outLine(prettyJson(entries));
    return 0;
  }
  if (entries.length === 0) {
    outLine("（暂无凭据）");
    return 0;
  }
  for (const entry of entries) {
    const note = entry.note === null ? "" : `  # ${entry.note}`;
    const updated = entry.updated_at === "" ? "" : `  (${entry.updated_at})`;
    outLine(`${entry.key}  [${entry.kind}]${note}${updated}`);
  }
  return 0;
}

function getCommand(args: string[]): number {
  const key = positional(args, 0);
  const store = openStore();
  const value = store.get(key);
  if (value === null) throw new Error(`凭据不存在：${key}`);
  // 安全默认：掩码；--reveal 才输出明文（--mask 兼容旧脚本）。
  const reveal = flagPresent(args, "--reveal") && !flagPresent(args, "--mask");
  outLine(reveal ? value : mask(value));
  return 0;
}

function setCommand(args: string[]): number {
  const key = positional(args, 0);
  const value = optionValue(args, "--value") ?? readStdinValue();
  if (value === "") throw new Error("凭据值不能为空（用 stdin 或 --value=V 传入）");
  const store = openStore();
  const entry = store.set(key, value, optionValue(args, "--kind"), optionValue(args, "--note"));
  outLine(`已保存 ${entry.key} [${entry.kind}]`);
  return 0;
}

function unsetCommand(args: string[]): number {
  const key = positional(args, 0);
  const store = openStore();
  if (store.unset(key)) outLine(`已删除 ${key}`);
  else outLine(`凭据不存在：${key}`);
  return 0;
}

function clearCommand(): number {
  const store = openStore();
  const removed = store.clear();
  outLine(removed > 0 ? `已清空全部凭据（${removed} 个）` : "（暂无可清空的凭据）");
  return 0;
}

function envCommand(args: string[]): number {
  const store = openStore();
  const only = optionValue(args, "--only");
  out(store.export(only === null ? [] : parseKeyList(only), "dotenv"));
  return 0;
}

function exportCommand(args: string[]): number {
  const store = openStore();
  const only = optionValue(args, "--only");
  const formatRaw = optionValue(args, "--format");
  let format: ExportFormat;
  if (formatRaw === null || formatRaw === "dotenv") format = "dotenv";
  else if (formatRaw === "shell") format = "shell";
  else if (formatRaw === "json") format = "json";
  else throw new Error(`未知格式：${formatRaw}（dotenv|shell|json）`);
  out(store.export(only === null ? [] : parseKeyList(only), format));
  return 0;
}

interface RunArgs {
  keys: string[];
  command: string[];
}

/** `run --with=A,B -- cmd ...`；`--` 之后全部视为要执行的命令。 */
function parseRunArgs(args: string[]): RunArgs {
  const rawKeys = optionValue(args, "--with");
  if (rawKeys === null) throw new Error("run 需要 --with=A,B 指定要注入的凭据名");
  const keys = parseKeyList(rawKeys);
  if (keys.length === 0) throw new Error("--with 至少需要一个凭据名");
  const separator = args.indexOf("--");
  if (separator < 0) {
    throw new Error("run 需要 `--` 分隔符，例如：flowlet run --with=GITHUB_PAT -- gh pr list");
  }
  const command = args.slice(separator + 1);
  if (command.length === 0) {
    throw new Error("run 需要指定要执行的命令，例如：flowlet run --with=GITHUB_PAT -- gh pr list");
  }
  return { keys, command };
}

function runCommand(args: string[]): number {
  const { keys, command } = parseRunArgs(args);
  const store = openStore();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of keys) {
    const value = store.get(key);
    if (value === null) throw new Error(`凭据不存在：${key}`);
    env[key] = value;
  }
  return runChild(command[0]!, command.slice(1), env);
}

/** 同步等待子进程（退出码透传），子进程 stdout/stderr 直接继承。 */
function runChild(command: string, args: string[], env: NodeJS.ProcessEnv): number {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`启动子进程失败：${errorMessage(result.error)}`);
  }
  return result.status ?? 1;
}

// ─── 浏览器授权（login / logout） ──────────────────────────────────────────

function parseLoginTimeoutSeconds(args: string[]): number {
  const raw = optionValue(args, "--timeout");
  if (raw === null) return DEFAULT_LOGIN_TIMEOUT_SECONDS;
  if (!/^\d+$/.test(raw.trim())) throw new Error("--timeout 需要正整数秒（默认 180）");
  const seconds = Number(raw.trim());
  if (seconds < 1) throw new Error("--timeout 需要正整数秒（默认 180）");
  return seconds;
}

/** 打开系统浏览器；失败不影响流程（授权 URL 已经打印，可手动访问）。 */
function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      errLine("未能自动打开浏览器，请手动访问上面的授权 URL。");
    });
    child.unref();
  } catch {
    errLine("未能自动打开浏览器，请手动访问上面的授权 URL。");
  }
}

async function loginCommand(args: string[]): Promise<number> {
  const rawServer = optionValue(args, "--server");
  if (rawServer === null) throw new Error("login 需要 --server=http://<flowlet-web-host>:<port>");
  const server = normalizeServer(rawServer);
  const rawName = optionValue(args, "--name");
  let name = rawName === null ? hostname() : rawName.trim();
  if (name === "") name = hostname();
  if (name.length > MAX_AUTH_NAME_LENGTH) {
    throw new Error(`--name 最多 ${MAX_AUTH_NAME_LENGTH} 个字符`);
  }
  const insecure = flagPresent(args, "--insecure");
  const noBrowser = flagPresent(args, "--no-browser");
  const timeoutSeconds = parseLoginTimeoutSeconds(args);
  const timeoutMs = timeoutSeconds * 1000;

  const result = await loginWithBrowser({
    server,
    name,
    insecure,
    timeoutMs,
    onAuthorizeUrl: (authorizeUrl) => {
      outLine("请在浏览器中完成授权：");
      outLine(`  ${authorizeUrl}`);
      outLine(`等待授权回调（${timeoutSeconds} 秒）…`);
      if (!noBrowser) openBrowser(authorizeUrl);
    },
  });

  const store = AuthStore.fromDefaultDir();
  store.set(server, {
    token: result.token,
    expiresAt: result.expiresAt,
    name,
    savedAt: nowRfc3339(),
  });
  outLine(`已登录 ${server}`);
  outLine(`授权：${name}（仅可用于 flowlet pull 同步服务凭据）`);
  outLine(`接下来：flowlet pull --server=${server}`);
  return 0;
}

function logoutCommand(args: string[]): number {
  const rawServer = optionValue(args, "--server");
  if (rawServer === null) throw new Error("logout 需要 --server=http://<flowlet-web-host>:<port>");
  const server = normalizeServer(rawServer);
  const removed = AuthStore.fromDefaultDir().remove(server);
  outLine(removed ? `已退出 ${server}` : `未找到 ${server} 的登录记录`);
  return 0;
}

// ─── 远程同步（pull） ───────────────────────────────────────────────────────

interface ServiceCredentialExport {
  name: string;
  provider: string;
  baseUrl: string;
  token: string;
  /** 第三期新增：Jenkins 的用户名（其它 provider 恒为 null / 缺失）。 */
  username?: string | null;
  /** 第二期新增：服务端解析后的环境前缀；旧服务端没有该字段。 */
  envPrefix?: string | null;
}

const PROVIDER_DEFAULT_PREFIX: Record<string, string> = {
  gitlab: "GITLAB",
  dockhand: "DOCKHAND",
  jenkins: "JENKINS",
  beszel: "BESZEL",
  "uptime-kuma": "UPTIME_KUMA",
};

function envKeys(entry: ServiceCredentialExport): Array<[string, string, string]> {
  if (PROVIDER_DEFAULT_PREFIX[entry.provider] === undefined) return [];
  const raw = typeof entry.envPrefix === "string" ? entry.envPrefix.trim() : "";
  // 旧服务端 export 无 envPrefix：回退 provider 大写（与 Rust/Node Host 的默认前缀一致）。
  const prefix = raw === "" ? entry.provider.toUpperCase() : raw.toUpperCase();
  if (entry.provider === "beszel") {
    // 契约 §7：Beszel 是「邮箱 + 密码」（每次现场换短期 token），三把键顺序固定。
    // 旧服务端 export 无 username 时 EMAIL 写空串（与 Jenkins 期策略一致）。
    const email = typeof entry.username === "string" ? entry.username : "";
    return [
      [`${prefix}_URL`, entry.baseUrl, "service"],
      [`${prefix}_EMAIL`, email, "service"],
      [`${prefix}_PASSWORD`, entry.token, "cli_token"],
    ];
  }
  if (entry.provider === "jenkins") {
    // 契约 §6：Jenkins 必须带上用户名（API Token 与用户名成对认证）。
    // 缺失时按空串写入，保持三个键的固定顺序。
    const username = typeof entry.username === "string" ? entry.username : "";
    return [
      [`${prefix}_URL`, entry.baseUrl, "service"],
      [`${prefix}_USER`, username, "service"],
      [`${prefix}_TOKEN`, entry.token, "cli_token"],
    ];
  }
  // Uptime Kuma 的 Key 只用于 /metrics 鉴权，沿用公司 infra skill 的 `_API_KEY` 命名。
  const tokenKey = entry.provider === "uptime-kuma" ? `${prefix}_API_KEY` : `${prefix}_TOKEN`;
  return [
    [`${prefix}_URL`, entry.baseUrl, "service"],
    [tokenKey, entry.token, "cli_token"],
  ];
}

type PullTokenSource = "option" | "environment" | "login";

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * pull 凭据解析（spec §3.3）：`--token` > `FLOWLET_ADMIN_TOKEN` > 本机 auth.json。
 * 本机记录先按 `scheme://host[:port]` 归一查找；都没有时提示先 `flowlet login`。
 */
function resolvePullToken(
  args: string[],
  server: string,
): { token: string; source: PullTokenSource } {
  const optionToken = nonEmpty(optionValue(args, "--token"));
  if (optionToken !== null) return { token: optionToken, source: "option" };
  const envToken = nonEmpty(process.env.FLOWLET_ADMIN_TOKEN);
  if (envToken !== null) return { token: envToken, source: "environment" };
  const record = AuthStore.fromDefaultDir().get(server);
  if (record !== null) return { token: record.token, source: "login" };
  throw new Error(
    `缺少凭据：先运行 flowlet login --server=${server}（或 --token=管理凭据 / FLOWLET_ADMIN_TOKEN）`,
  );
}

async function pullCommand(args: string[]): Promise<number> {
  const rawServer = optionValue(args, "--server");
  if (rawServer === null) throw new Error("pull 需要 --server=http://<flowlet-web-host>:<port>");
  const server = rawServer.trim().replace(/\/+$/, "");
  const serverKey = normalizeServer(server);
  const { token, source } = resolvePullToken(args, serverKey);
  const insecure = flagPresent(args, "--insecure");
  const dryRun = flagPresent(args, "--dry-run");
  const url = `${server}/api/commands/export_service_credentials`;

  let status: number;
  let text: string;
  try {
    const response = await request(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: "{}",
      dispatcher: insecure ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined,
      signal: AbortSignal.timeout(30_000),
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    });
    status = response.statusCode;
    text = await response.body.text();
  } catch (error) {
    throw new Error(
      `请求 ${url} 失败：${requestErrorDetail(error)}（内网自签证书请加 --insecure）`,
    );
  }
  if (status === 401) {
    if (source === "login") {
      throw new Error(`登录已过期或被撤销，请重新 flowlet login --server=${serverKey}`);
    }
    throw new Error("管理凭据无效（401）：请检查 --token / FLOWLET_ADMIN_TOKEN");
  }
  if (status === 403 && source === "login") {
    throw new Error(`该凭据只能同步服务凭据，请重新 flowlet login --server=${serverKey}`);
  }
  if (status < 200 || status >= 300) throw new Error(`拉取失败（${status}）：${text}`);
  let entries: unknown;
  try {
    entries = JSON.parse(text);
  } catch (error) {
    throw new Error(`解析服务端响应失败：${errorMessage(error)}`);
  }
  if (!Array.isArray(entries)) throw new Error("解析服务端响应失败：expected a sequence");
  if (entries.length === 0) {
    outLine("服务端没有启用中的服务凭据");
    return 0;
  }
  const store = openStore();
  let written = 0;
  for (const rawEntry of entries) {
    if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      continue;
    }
    const entry = rawEntry as ServiceCredentialExport;
    const pairs = envKeys(entry);
    if (pairs.length === 0) {
      errLine(`跳过未知服务类型：${entry.provider}（${entry.name}）`);
      continue;
    }
    for (const [key, value, kind] of pairs) {
      if (dryRun) {
        outLine(`将写入 ${key}（来自 ${entry.provider} / ${entry.name}）`);
        continue;
      }
      store.set(key, value, kind, `${entry.provider} / ${entry.name}`);
      outLine(`已写入 ${key}（来自 ${entry.provider} / ${entry.name}）`);
      written += 1;
    }
  }
  if (dryRun) outLine("dry-run：未写入任何凭据");
  else outLine(`完成：写入 ${written} 个键 → ${store.envPath()}`);
  return 0;
}

function requestErrorDetail(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const base = errorMessage(error);
  return cause instanceof Error ? `${base}: ${cause.message}` : base;
}

// ─── GitLab 子命令 ─────────────────────────────────────────────────────────

async function gitlabCommand(args: string[]): Promise<number> {
  const sub = positional(args, 0);
  const insecure = flagPresent(args, "--insecure");
  const profile = resolveProfile(args, GITLAB_DEFAULT_PREFIX);
  switch (sub) {
    case "set":
      return gitlabSet(args, insecure, profile);
    case "status":
      return gitlabStatus(args, insecure, profile);
    case "projects":
      return gitlabProjects(args, insecure, profile);
    case "api":
      return gitlabApi(args, insecure, profile);
    case "env": {
      const keys = profileKeys(profile.prefix);
      const store = openStore();
      const url = storedValue(store, keys.urlKey);
      if (url === null) {
        throw new Error(
          `尚未配置 GitLab 地址，先运行 flowlet gitlab set --url=...${profileHint(profile)}`,
        );
      }
      const token = storedValue(store, keys.tokenKey);
      if (token === null) {
        throw new Error(
          `尚未保存 GitLab token，先运行 flowlet gitlab set --url=...${profileHint(profile)}`,
        );
      }
      errLine("注意：下面输出包含明文 token，只应在可信 shell 中使用。");
      outLine(`${keys.urlKey}=${url}`);
      outLine(`${keys.tokenKey}=${token}`);
      return 0;
    }
    case "clear": {
      const keys = profileKeys(profile.prefix);
      const store = openStore();
      const urlRemoved = store.unset(keys.urlKey);
      const tokenRemoved = store.unset(keys.tokenKey);
      const suffix = profileDescription(profile);
      outLine(
        urlRemoved || tokenRemoved ? `已移除 GitLab 凭据${suffix}` : `没有可移除的 GitLab 凭据${suffix}`,
      );
      return 0;
    }
    default:
      throw new Error(`未知的 gitlab 子命令：${sub}（set|status|projects|api|env|clear）`);
  }
}

async function gitlabSet(args: string[], insecure: boolean, profile: ProfileContext): Promise<number> {
  const store = openStore();
  const keys = profileKeys(profile.prefix);
  let url = optionValue(args, "--url");
  if (url === null) url = storedValue(store, keys.urlKey);
  if (url === null) {
    throw new Error(
      `缺少 --url，例如：flowlet gitlab set --url=https://gitlab.example.com${profileHint(profile)}`,
    );
  }
  const token = readStdinValue();
  if (token === "") {
    throw new Error(
      "GitLab token 不能为空：用 `printf '%s' \"$TOKEN\" | flowlet gitlab set ...`",
    );
  }
  const client = new GitlabClient(url, token, { insecure });
  let user: unknown;
  try {
    user = await client.currentUser();
  } catch (error) {
    const detail = error instanceof GitlabError ? error.toString() : errorMessage(error);
    throw new Error(`${detail}\n未保存。请检查实例地址、token 是否有效（需要 api scope）。`);
  }
  const base = normalizeBaseUrl(url);
  store.set(keys.urlKey, base, "service", "gitlab 实例地址（API v4）");
  store.set(keys.tokenKey, token, "cli_token", "gitlab personal access token");
  outLine(`已保存 GitLab 凭据${profileDescription(profile)}：${client.apiBase()}`);
  outLine(describeUser(user));
  return 0;
}

async function gitlabStatus(args: string[], insecure: boolean, profile: ProfileContext): Promise<number> {
  const client = storedGitlabClient(args, insecure, profile);
  const user = await client.currentUser();
  outLine(`API：${client.apiBase()}`);
  outLine(describeUser(user));
  const version = await client.version();
  if (version === null) {
    outLine("版本：未知（/version 需要管理员 token；不影响 10.8 其它接口）");
  } else {
    outLine(`版本：${version}`);
    if (!version.startsWith("10.8")) {
      outLine(
        `提示：当前按 GitLab CE 10.8.7 实现；实例版本是 ${version}，若有接口差异请用 \`gitlab api\` 验证。`,
      );
    }
  }
  return 0;
}

async function gitlabProjects(args: string[], insecure: boolean, profile: ProfileContext): Promise<number> {
  const client = storedGitlabClient(args, insecure, profile);
  const search = optionValue(args, "--search");
  const rawLimit = optionValue(args, "--limit");
  let limit = 20;
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit)) throw new Error("--limit 需要整数");
    limit = Number(rawLimit);
  }
  const membership = !flagPresent(args, "--all");
  const projects = await client.projects(search, membership, limit);
  if (flagPresent(args, "--json")) {
    outLine(prettyJson(projects));
    return 0;
  }
  if (projects.length === 0) {
    outLine("（没有匹配的项目）");
    return 0;
  }
  for (const project of projects) outLine(describeProject(project));
  return 0;
}

async function gitlabApi(args: string[], insecure: boolean, profile: ProfileContext): Promise<number> {
  const first = positional(args, 1);
  // `gitlab api /projects` 与 `gitlab api GET /projects` 都接受。
  const method = first.startsWith("/") ? "GET" : first.toUpperCase();
  const path = first.startsWith("/") ? first : positional(args, 2);
  const rawData = optionValue(args, "--data");
  let body: unknown;
  if (rawData !== null) {
    try {
      body = JSON.parse(rawData);
    } catch (error) {
      throw new Error(`--data 不是合法 JSON：${errorMessage(error)}`);
    }
  }
  const client = storedGitlabClient(args, insecure, profile);
  const { value, pagination } = await client.request(method, path, body);
  outLine(prettyJsonSorted(value));
  if (pagination.nextPage !== null || pagination.total !== null) {
    errLine(
      `分页：page=${debugOption(pagination.page)} next=${debugOption(pagination.nextPage)} total=${debugOption(pagination.total)}`,
    );
  }
  return 0;
}

/** Rust `{:?}` for Option<T>：Some(1) / None。 */
function debugOption(value: number | null): string {
  return value === null ? "None" : `Some(${value})`;
}

function storedGitlabClient(args: string[], insecure: boolean, profile: ProfileContext): GitlabClient {
  const store = openStore();
  const keys = profileKeys(profile.prefix);
  const hint = profileHint(profile);
  const url = storedValue(store, keys.urlKey);
  if (url === null) {
    throw new Error(
      `尚未配置 GitLab 地址，先运行 flowlet gitlab set --url=https://gitlab.example.com${hint}`,
    );
  }
  const token = storedValue(store, keys.tokenKey);
  if (token === null) {
    throw new Error(
      `尚未保存 GitLab token，先运行 flowlet gitlab set --url=https://gitlab.example.com${hint}`,
    );
  }
  return new GitlabClient(url, token, { insecure });
}

function describeUser(value: unknown): string {
  const row = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const username = typeof row.username === "string" ? row.username : "unknown";
  const name = typeof row.name === "string" ? row.name : "";
  const id = typeof row.id === "number" && Number.isInteger(row.id) ? ` id=${row.id}` : "";
  return name === "" ? `用户：@${username}${id}` : `用户：${name} (@${username})${id}`;
}

function describeProject(project: ProjectSummary): string {
  const branch = project.default_branch === null ? "" : `  ${project.default_branch}`;
  const visibility = project.visibility === null ? "" : `  ${project.visibility}`;
  return `${String(project.id).padStart(8)}  ${project.path_with_namespace}${branch}${visibility}`;
}

// ─── Dockhand 子命令 ───────────────────────────────────────────────────────

async function dockhandCommand(args: string[]): Promise<number> {
  const sub = positional(args, 0);
  const insecure = flagPresent(args, "--insecure");
  const profile = resolveProfile(args, DOCKHAND_DEFAULT_PREFIX);
  switch (sub) {
    case "set":
      return dockhandSet(args, insecure, profile);
    case "status":
      return dockhandStatus(args, insecure, profile);
    case "envs":
      return dockhandEnvs(args, insecure, profile);
    case "stacks":
      return dockhandStacks(args, insecure, profile);
    case "api":
      return dockhandApi(args, insecure, profile);
    case "env": {
      const keys = profileKeys(profile.prefix);
      const store = openStore();
      const url = storedValue(store, keys.urlKey);
      if (url === null) {
        throw new Error(
          `尚未配置 Dockhand 地址，先运行 flowlet dockhand set --url=http://dockhand.example.com:3000${profileHint(profile)}`,
        );
      }
      const token = storedValue(store, keys.tokenKey);
      if (token === null) {
        throw new Error(
          `尚未保存 Dockhand token，先运行 flowlet dockhand set --url=http://dockhand.example.com:3000${profileHint(profile)}`,
        );
      }
      errLine("注意：下面输出包含明文 token，只应在可信 shell 中使用。");
      outLine(`${keys.urlKey}=${url}`);
      outLine(`${keys.tokenKey}=${token}`);
      return 0;
    }
    case "clear": {
      const keys = profileKeys(profile.prefix);
      const store = openStore();
      const urlRemoved = store.unset(keys.urlKey);
      const tokenRemoved = store.unset(keys.tokenKey);
      const suffix = profileDescription(profile);
      outLine(
        urlRemoved || tokenRemoved
          ? `已移除 Dockhand 凭据${suffix}`
          : `没有可移除的 Dockhand 凭据${suffix}`,
      );
      return 0;
    }
    default:
      throw new Error(`未知的 dockhand 子命令：${sub}（set|status|envs|stacks|api|env|clear）`);
  }
}

async function dockhandSet(args: string[], insecure: boolean, profile: ProfileContext): Promise<number> {
  const store = openStore();
  const keys = profileKeys(profile.prefix);
  let url = optionValue(args, "--url");
  if (url === null) url = storedValue(store, keys.urlKey);
  if (url === null) {
    throw new Error(
      `缺少 --url，例如：flowlet dockhand set --url=http://dockhand.example.com:3000${profileHint(profile)}`,
    );
  }
  const token = readStdinValue();
  if (token === "") {
    throw new Error(
      "Dockhand token 不能为空：用 `printf '%s' \"$TOKEN\" | flowlet dockhand set ...`",
    );
  }
  const client = new DockhandClient(url, token, { insecure });
  let environments: DockhandEnvironment[];
  try {
    // 与 GitLab 一致：先用一个需要认证的接口验证，再落库。
    environments = await client.environments();
  } catch (error) {
    const detail = error instanceof DockhandError ? error.toString() : errorMessage(error);
    throw new Error(
      `${detail}\n未保存。请检查实例地址、token 是否有效（Dockhand 设置 → API 令牌）。`,
    );
  }
  const base = normalizeDockhandBaseUrl(url);
  store.set(keys.urlKey, base, "service", "dockhand 面板地址");
  store.set(keys.tokenKey, token, "cli_token", "dockhand API token");
  outLine(`已保存 Dockhand 凭据${profileDescription(profile)}：${client.apiBase()}`);
  outLine(`环境：${environments.length} 个`);
  return 0;
}

async function dockhandStatus(args: string[], insecure: boolean, profile: ProfileContext): Promise<number> {
  const client = storedDockhandClient(args, insecure, profile);
  const health = await client.health();
  const environments = await client.environments();
  outLine(`API：${client.apiBase()}`);
  outLine(`健康：${describeHealth(health)}`);
  outLine(`环境：${environments.length} 个`);
  for (const environment of environments) outLine(describeEnvironment(environment));
  const first = environments[0];
  if (first !== undefined) {
    // Docker 版本只是附加信息：system 接口失败不影响状态查询主体。
    let version: string | null = null;
    try {
      version = dockerVersion(await client.system(first.id));
    } catch {
      version = null;
    }
    outLine(version === null ? "Docker 版本：未知" : `Docker 版本：${version}`);
  }
  return 0;
}

async function dockhandEnvs(args: string[], insecure: boolean, profile: ProfileContext): Promise<number> {
  const client = storedDockhandClient(args, insecure, profile);
  const environments = await client.environments();
  if (flagPresent(args, "--json")) {
    outLine(prettyJson(environments));
    return 0;
  }
  if (environments.length === 0) {
    outLine("（没有环境）");
    return 0;
  }
  for (const environment of environments) outLine(describeEnvironment(environment));
  return 0;
}

async function dockhandStacks(args: string[], insecure: boolean, profile: ProfileContext): Promise<number> {
  const rawEnv = optionValue(args, "--env");
  if (rawEnv === null) throw new Error("缺少 --env，例如 --env=2");
  if (!/^\d+$/.test(rawEnv)) throw new Error("--env 需要整数，例如 --env=2");
  const client = storedDockhandClient(args, insecure, profile);
  const stacks = await client.stacks(Number(rawEnv));
  if (flagPresent(args, "--json")) {
    outLine(prettyJson(stacks));
    return 0;
  }
  if (!Array.isArray(stacks)) {
    throw new Error("解析 stack 列表失败：expected a sequence");
  }
  if (stacks.length === 0) {
    outLine("（没有 stack）");
    return 0;
  }
  for (const stack of stacks) outLine(describeStack(stack));
  return 0;
}

async function dockhandApi(args: string[], insecure: boolean, profile: ProfileContext): Promise<number> {
  const first = positional(args, 1);
  // `dockhand api /environments` 与 `dockhand api GET /environments` 都接受。
  const method = first.startsWith("/") ? "GET" : first.toUpperCase();
  const path = first.startsWith("/") ? first : positional(args, 2);
  const rawData = optionValue(args, "--data");
  let body: unknown;
  if (rawData !== null) {
    try {
      body = JSON.parse(rawData);
    } catch (error) {
      throw new Error(`--data 不是合法 JSON：${errorMessage(error)}`);
    }
  }
  const client = storedDockhandClient(args, insecure, profile);
  outLine(prettyJsonSorted(await client.request(method, path, body)));
  return 0;
}

function storedDockhandClient(args: string[], insecure: boolean, profile: ProfileContext): DockhandClient {
  const store = openStore();
  const keys = profileKeys(profile.prefix);
  const hint = profileHint(profile);
  const url = storedValue(store, keys.urlKey);
  if (url === null) {
    throw new Error(
      `尚未配置 Dockhand 地址，先运行 flowlet dockhand set --url=http://dockhand.example.com:3000${hint}`,
    );
  }
  const token = storedValue(store, keys.tokenKey);
  if (token === null) {
    throw new Error(
      `尚未保存 Dockhand token，先运行 flowlet dockhand set --url=http://dockhand.example.com:3000${hint}`,
    );
  }
  return new DockhandClient(url, token, { insecure });
}

function describeHealth(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const status = (value as Record<string, unknown>).status;
    if (typeof status === "string" && status !== "") return status;
  }
  return "未知";
}

function dockerVersion(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const docker = (value as Record<string, unknown>).docker;
  if (docker === null || typeof docker !== "object" || Array.isArray(docker)) return null;
  const row = docker as Record<string, unknown>;
  const version = typeof row.serverVersion === "string" ? row.serverVersion : row.version;
  return typeof version === "string" && version !== "" ? version : null;
}

function describeEnvironment(environment: DockhandEnvironment): string {
  const endpoint =
    environment.host === null
      ? ""
      : `  ${environment.protocol ?? "http"}://${environment.host}${
          environment.port === null ? "" : `:${environment.port}`
        }`;
  return `${String(environment.id).padStart(4)}  ${environment.name}${endpoint}`;
}

function describeStack(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "（无法识别的 stack 条目）";
  }
  const row = value as Record<string, unknown>;
  const name = typeof row.name === "string" && row.name !== "" ? row.name : "（未命名）";
  const containers = Array.isArray(row.containers) ? row.containers.length : 0;
  return `${name}  ${containers} 个容器`;
}

// ─── Jenkins 子命令 ────────────────────────────────────────────────────────

async function jenkinsCommand(args: string[]): Promise<number> {
  const sub = positional(args, 0);
  const insecure = flagPresent(args, "--insecure");
  const profile = resolveProfile(args, JENKINS_DEFAULT_PREFIX);
  switch (sub) {
    case "set":
      return jenkinsSet(args, insecure, profile);
    case "status":
      return jenkinsStatus(args, insecure, profile);
    case "api":
      return jenkinsApi(args, insecure, profile);
    case "env": {
      const keys = profileKeys(profile.prefix);
      const store = openStore();
      const url = storedValue(store, keys.urlKey);
      if (url === null) {
        throw new Error(
          `尚未配置 Jenkins 地址，先运行 flowlet jenkins set --url=https://jenkins.example.com --user=NAME${profileHint(profile)}`,
        );
      }
      const username = storedValue(store, keys.userKey);
      if (username === null) {
        throw new Error(
          `尚未保存 Jenkins 用户名，先运行 flowlet jenkins set --url=https://jenkins.example.com --user=NAME${profileHint(profile)}`,
        );
      }
      const token = storedValue(store, keys.tokenKey);
      if (token === null) {
        throw new Error(
          `尚未保存 Jenkins token，先运行 flowlet jenkins set --url=https://jenkins.example.com --user=NAME${profileHint(profile)}`,
        );
      }
      errLine("注意：下面输出包含明文 token，只应在可信 shell 中使用。");
      outLine(`${keys.urlKey}=${url}`);
      outLine(`${keys.userKey}=${username}`);
      outLine(`${keys.tokenKey}=${token}`);
      return 0;
    }
    case "clear": {
      const keys = profileKeys(profile.prefix);
      const store = openStore();
      const urlRemoved = store.unset(keys.urlKey);
      const userRemoved = store.unset(keys.userKey);
      const tokenRemoved = store.unset(keys.tokenKey);
      const suffix = profileDescription(profile);
      outLine(
        urlRemoved || userRemoved || tokenRemoved
          ? `已移除 Jenkins 凭据${suffix}`
          : `没有可移除的 Jenkins 凭据${suffix}`,
      );
      return 0;
    }
    default:
      throw new Error(`未知的 jenkins 子命令：${sub}（set|status|api|env|clear）`);
  }
}

/** `--url` / `--user` 必填（Jenkins 的 API Token 必须与用户名成对使用）。 */
async function jenkinsSet(args: string[], insecure: boolean, profile: ProfileContext): Promise<number> {
  const store = openStore();
  const keys = profileKeys(profile.prefix);
  const url = optionValue(args, "--url");
  if (url === null) {
    throw new Error(
      `缺少 --url，例如：flowlet jenkins set --url=https://jenkins.example.com --user=NAME${profileHint(profile)}`,
    );
  }
  const rawUsername = optionValue(args, "--user");
  if (rawUsername === null) {
    throw new Error(
      `缺少 --user，例如：flowlet jenkins set --url=https://jenkins.example.com --user=NAME${profileHint(profile)}`,
    );
  }
  const username = rawUsername.trim();
  if (username === "") throw new Error("Jenkins 用户名不能为空");
  const token = readStdinValue();
  if (token === "") {
    throw new Error(
      "Jenkins token 不能为空：用 `printf '%s' \"$TOKEN\" | flowlet jenkins set ...`",
    );
  }
  const client = new JenkinsClient(url, username, token, { insecure });
  let identity: JenkinsIdentity;
  try {
    // 与 GitLab / Dockhand 一致：先用一个需要认证的接口验证，再落库。
    identity = await client.identity();
  } catch (error) {
    const detail = error instanceof JenkinsError ? error.toString() : errorMessage(error);
    throw new Error(
      `${detail}\n未保存。请检查实例地址、用户名与 API Token 是否有效（Jenkins 用户设置 → API Token）。`,
    );
  }
  const base = normalizeJenkinsBaseUrl(url);
  store.set(keys.urlKey, base, "service", "jenkins 实例地址");
  store.set(keys.userKey, username, "service", "jenkins 用户名");
  store.set(keys.tokenKey, token, "cli_token", "jenkins API token");
  outLine(`已保存 Jenkins 凭据${profileDescription(profile)}：${base}`);
  const version = identity.version === null ? "" : `（Jenkins ${identity.version}）`;
  outLine(`用户：${identity.username ?? username}${version}`);
  return 0;
}

async function jenkinsStatus(args: string[], insecure: boolean, profile: ProfileContext): Promise<number> {
  const client = storedJenkinsClient(args, insecure, profile);
  const identity = await client.identity();
  outLine(`URL：${client.base()}`);
  outLine(`版本：${identity.version ?? "未知"}`);
  outLine(`用户：${identity.username ?? "未知"}`);
  return 0;
}

async function jenkinsApi(args: string[], insecure: boolean, profile: ProfileContext): Promise<number> {
  const first = positional(args, 1);
  // `jenkins api /me/api/json` 与 `jenkins api GET /me/api/json` 都接受。
  const method = first.startsWith("/") ? "GET" : first.toUpperCase();
  const path = first.startsWith("/") ? first : positional(args, 2);
  const rawData = optionValue(args, "--data");
  let body: unknown;
  if (rawData !== null) {
    try {
      body = JSON.parse(rawData);
    } catch (error) {
      throw new Error(`--data 不是合法 JSON：${errorMessage(error)}`);
    }
  }
  const client = storedJenkinsClient(args, insecure, profile);
  outLine(prettyJsonSorted(await client.request(method, path, body)));
  return 0;
}

function storedJenkinsClient(args: string[], insecure: boolean, profile: ProfileContext): JenkinsClient {
  const store = openStore();
  const keys = profileKeys(profile.prefix);
  const hint = profileHint(profile);
  const url = storedValue(store, keys.urlKey);
  if (url === null) {
    throw new Error(
      `尚未配置 Jenkins 地址，先运行 flowlet jenkins set --url=https://jenkins.example.com --user=NAME${hint}`,
    );
  }
  const username = storedValue(store, keys.userKey);
  if (username === null) {
    throw new Error(
      `尚未保存 Jenkins 用户名，先运行 flowlet jenkins set --url=https://jenkins.example.com --user=NAME${hint}`,
    );
  }
  const token = storedValue(store, keys.tokenKey);
  if (token === null) {
    throw new Error(
      `尚未保存 Jenkins token，先运行 flowlet jenkins set --url=https://jenkins.example.com --user=NAME${hint}`,
    );
  }
  return new JenkinsClient(url, username, token, { insecure });
}

// ─── Beszel 子命令（PocketBase 底座，邮箱 + 密码换短期 token） ─────────────

async function beszelCommand(args: string[]): Promise<number> {
  const sub = positional(args, 0);
  const insecure = flagPresent(args, "--insecure");
  const profile = resolveProfile(args, BESZEL_DEFAULT_PREFIX);
  switch (sub) {
    case "set":
      return beszelSet(args, insecure, profile);
    case "status":
      return beszelStatus(args, insecure, profile);
    case "systems":
      return beszelSystems(args, insecure, profile);
    case "api":
      return beszelApi(args, insecure, profile);
    case "env": {
      const keys = profileKeys(profile.prefix, "beszel");
      const store = openStore();
      const url = storedValue(store, keys.urlKey);
      if (url === null) {
        throw new Error(
          `尚未配置 Beszel 地址，先运行 flowlet beszel set --url=http://beszel.example.com:8090 --email=you@example.com${profileHint(profile)}`,
        );
      }
      const email = storedValue(store, keys.userKey);
      if (email === null) {
        throw new Error(
          `尚未保存 Beszel 邮箱，先运行 flowlet beszel set --url=http://beszel.example.com:8090 --email=you@example.com${profileHint(profile)}`,
        );
      }
      const password = storedValue(store, keys.tokenKey);
      if (password === null) {
        throw new Error(
          `尚未保存 Beszel 密码，先运行 flowlet beszel set --url=http://beszel.example.com:8090 --email=you@example.com${profileHint(profile)}`,
        );
      }
      errLine("注意：下面输出包含明文密码，只应在可信 shell 中使用。");
      outLine(`${keys.urlKey}=${url}`);
      outLine(`${keys.userKey}=${email}`);
      outLine(`${keys.tokenKey}=${password}`);
      return 0;
    }
    case "clear": {
      const keys = profileKeys(profile.prefix, "beszel");
      const store = openStore();
      const urlRemoved = store.unset(keys.urlKey);
      const emailRemoved = store.unset(keys.userKey);
      const passwordRemoved = store.unset(keys.tokenKey);
      const suffix = profileDescription(profile);
      outLine(
        urlRemoved || emailRemoved || passwordRemoved
          ? `已移除 Beszel 凭据${suffix}`
          : `没有可移除的 Beszel 凭据${suffix}`,
      );
      return 0;
    }
    default:
      throw new Error(`未知的 beszel 子命令：${sub}（set|status|systems|api|env|clear）`);
  }
}

/** `--url` / `--email` 必填（Beszel 只能用邮箱 + 密码换 token）。 */
async function beszelSet(
  args: string[],
  insecure: boolean,
  profile: ProfileContext,
): Promise<number> {
  const store = openStore();
  const keys = profileKeys(profile.prefix, "beszel");
  const url = optionValue(args, "--url");
  if (url === null) {
    throw new Error(
      `缺少 --url，例如：flowlet beszel set --url=http://beszel.example.com:8090 --email=you@example.com${profileHint(profile)}`,
    );
  }
  const rawEmail = optionValue(args, "--email");
  if (rawEmail === null) {
    throw new Error(
      `缺少 --email，例如：flowlet beszel set --url=http://beszel.example.com:8090 --email=you@example.com${profileHint(profile)}`,
    );
  }
  const email = rawEmail.trim();
  if (email === "") throw new Error("Beszel 邮箱不能为空");
  const password = readStdinValue();
  if (password === "") {
    throw new Error(
      "Beszel 密码不能为空：用 `printf '%s' \"$PASSWORD\" | flowlet beszel set ...`",
    );
  }
  const client = new BeszelClient(url, email, password, { insecure });
  let auth: BeszelAuth;
  let version: string | null = null;
  let totalItems: number;
  try {
    // 与其它 provider 一致：先认证再落库。info 失败不致命（版本显示未知）。
    auth = await client.auth();
    try {
      version = await client.info();
    } catch {
      version = null;
    }
    totalItems = (await client.systems(1)).totalItems;
  } catch (error) {
    const detail = error instanceof BeszelError ? error.toString() : errorMessage(error);
    throw new Error(
      `${detail}\n未保存。请检查实例地址、邮箱与密码是否有效（Beszel 用户账号，不是 PocketBase 超级管理员）。`,
    );
  }
  const base = normalizeBeszelBaseUrl(url);
  const savedEmail = auth.email ?? email;
  store.set(keys.urlKey, base, "service", "beszel 实例地址");
  store.set(keys.userKey, savedEmail, "service", "beszel 登录邮箱");
  store.set(keys.tokenKey, password, "cli_token", "beszel 登录密码");
  outLine(`已保存 Beszel 凭据${profileDescription(profile)}：${base}`);
  const versionText = version === null ? "" : `（Beszel ${version}）`;
  outLine(`邮箱：${savedEmail}${versionText}`);
  outLine(`系统：${totalItems} 台`);
  return 0;
}

async function beszelStatus(
  args: string[],
  insecure: boolean,
  profile: ProfileContext,
): Promise<number> {
  const client = storedBeszelClient(args, insecure, profile);
  const auth = await client.auth();
  let version: string | null = null;
  try {
    // info 失败不致命：与校验语义一致，版本未知不影响主体状态。
    version = await client.info();
  } catch {
    version = null;
  }
  const systems = await client.systems(1);
  outLine(`URL：${client.base()}`);
  outLine(`版本：${version ?? "未知"}`);
  outLine(`邮箱：${auth.email ?? "未知"}`);
  outLine(`系统：${systems.totalItems} 台`);
  return 0;
}

async function beszelSystems(
  args: string[],
  insecure: boolean,
  profile: ProfileContext,
): Promise<number> {
  const client = storedBeszelClient(args, insecure, profile);
  const systems: BeszelSystems = await client.systems();
  if (flagPresent(args, "--json")) {
    outLine(prettyJson(systems.items));
    return 0;
  }
  if (systems.items.length === 0) {
    outLine("（没有系统）");
    return 0;
  }
  for (const system of systems.items) outLine(describeBeszelSystem(system));
  return 0;
}

async function beszelApi(args: string[], insecure: boolean, profile: ProfileContext): Promise<number> {
  const first = positional(args, 1);
  // `beszel api /collections/systems/records` 与 `beszel api GET /api/...` 都接受。
  const method = first.startsWith("/") ? "GET" : first.toUpperCase();
  const path = first.startsWith("/") ? first : positional(args, 2);
  const rawData = optionValue(args, "--data");
  let body: unknown;
  if (rawData !== null) {
    try {
      body = JSON.parse(rawData);
    } catch (error) {
      throw new Error(`--data 不是合法 JSON：${errorMessage(error)}`);
    }
  }
  const client = storedBeszelClient(args, insecure, profile);
  outLine(prettyJsonSorted(await client.request(method, path, body)));
  return 0;
}

function storedBeszelClient(
  args: string[],
  insecure: boolean,
  profile: ProfileContext,
): BeszelClient {
  const store = openStore();
  const keys = profileKeys(profile.prefix, "beszel");
  const hint = profileHint(profile);
  const url = storedValue(store, keys.urlKey);
  if (url === null) {
    throw new Error(
      `尚未配置 Beszel 地址，先运行 flowlet beszel set --url=http://beszel.example.com:8090 --email=you@example.com${hint}`,
    );
  }
  const email = storedValue(store, keys.userKey);
  if (email === null) {
    throw new Error(
      `尚未保存 Beszel 邮箱，先运行 flowlet beszel set --url=http://beszel.example.com:8090 --email=you@example.com${hint}`,
    );
  }
  const password = storedValue(store, keys.tokenKey);
  if (password === null) {
    throw new Error(
      `尚未保存 Beszel 密码，先运行 flowlet beszel set --url=http://beszel.example.com:8090 --email=you@example.com${hint}`,
    );
  }
  return new BeszelClient(url, email, password, { insecure });
}

function describeBeszelSystem(system: BeszelSystem): string {
  const endpoint =
    system.host === "" ? "" : system.port === "" ? system.host : `${system.host}:${system.port}`;
  const status = system.status === "" ? "未知" : system.status;
  const name = system.name === "" ? "（未命名）" : system.name;
  const id = system.id === "" ? "?" : system.id;
  return `${id.padStart(8)}  ${name}  ${status}${endpoint === "" ? "" : `  ${endpoint}`}`;
}

// ─── Uptime Kuma 子命令（Prometheus /metrics 只读） ────────────────────────

/** Uptime Kuma 的 token 键是 `{PREFIX}_API_KEY`（不是其它 provider 的 `_TOKEN`）。 */
function kumaKeys(prefix: string): { urlKey: string; tokenKey: string } {
  return { urlKey: `${prefix}_URL`, tokenKey: `${prefix}_API_KEY` };
}

async function uptimeKumaCommand(args: string[]): Promise<number> {
  const sub = positional(args, 0);
  const insecure = flagPresent(args, "--insecure");
  const profile = resolveProfile(args, UPTIME_KUMA_DEFAULT_PREFIX);
  switch (sub) {
    case "set":
      return uptimeKumaSet(args, insecure, profile);
    case "status":
      return uptimeKumaStatus(args, insecure, profile);
    case "monitors":
      return uptimeKumaMonitors(args, insecure, profile);
    case "env": {
      const keys = kumaKeys(profile.prefix);
      const store = openStore();
      const url = storedValue(store, keys.urlKey);
      if (url === null) {
        throw new Error(
          `尚未配置 Uptime Kuma 地址，先运行 flowlet uptime-kuma set --url=https://host/uptime-kuma${profileHint(profile)}`,
        );
      }
      const token = storedValue(store, keys.tokenKey);
      if (token === null) {
        throw new Error(
          `尚未保存 Uptime Kuma API Key，先运行 flowlet uptime-kuma set --url=https://host/uptime-kuma${profileHint(profile)}`,
        );
      }
      errLine("注意：下面输出包含明文 API Key，只应在可信 shell 中使用。");
      outLine(`${keys.urlKey}=${url}`);
      outLine(`${keys.tokenKey}=${token}`);
      return 0;
    }
    case "clear": {
      const keys = kumaKeys(profile.prefix);
      const store = openStore();
      const urlRemoved = store.unset(keys.urlKey);
      const tokenRemoved = store.unset(keys.tokenKey);
      const suffix = profileDescription(profile);
      outLine(
        urlRemoved || tokenRemoved
          ? `已移除 Uptime Kuma 凭据${suffix}`
          : `没有可移除的 Uptime Kuma 凭据${suffix}`,
      );
      return 0;
    }
    default:
      throw new Error(`未知的 uptime-kuma 子命令：${sub}（set|status|monitors|env|clear）`);
  }
}

async function uptimeKumaSet(
  args: string[],
  insecure: boolean,
  profile: ProfileContext,
): Promise<number> {
  const store = openStore();
  const keys = kumaKeys(profile.prefix);
  const url = optionValue(args, "--url");
  if (url === null) {
    throw new Error(
      `缺少 --url，例如：flowlet uptime-kuma set --url=https://host/uptime-kuma${profileHint(profile)}`,
    );
  }
  const token = readStdinValue();
  if (token === "") {
    throw new Error(
      "Uptime Kuma API Key 不能为空：用 `printf '%s' \"$API_KEY\" | flowlet uptime-kuma set ...`",
    );
  }
  const client = new UptimeKumaClient(url, token, { insecure });
  let metrics: KumaMetrics;
  try {
    // 与其它 provider 一致：先用需要认证的 `/metrics` 验证，再落库。
    metrics = await client.metrics();
  } catch (error) {
    const detail = error instanceof UptimeKumaError ? error.toString() : errorMessage(error);
    throw new Error(
      `${detail}\n未保存。请检查实例地址与 API Key 是否有效（设置 → API 密钥）。`,
    );
  }
  const base = normalizeUptimeKumaBaseUrl(url);
  store.set(keys.urlKey, base, "service", "uptime kuma 面板地址");
  store.set(keys.tokenKey, token, "cli_token", "uptime kuma API key（仅 /metrics 鉴权）");
  outLine(`已保存 Uptime Kuma 凭据${profileDescription(profile)}：${base}`);
  outLine(`监控：${summarizeMetrics(metrics)}`);
  if (metrics.version !== null) outLine(`版本：${metrics.version}`);
  return 0;
}

async function uptimeKumaStatus(
  args: string[],
  insecure: boolean,
  profile: ProfileContext,
): Promise<number> {
  const client = storedUptimeKumaClient(args, insecure, profile);
  const metrics = await client.metrics();
  outLine(`地址：${client.base()}`);
  outLine(`指标：Prometheus 文本，${metrics.samples} 个样本`);
  outLine(`版本：${metrics.version ?? "未知"}`);
  outLine(`监控：${summarizeMetrics(metrics)}`);
  outLine("说明：API Key 只用于 /metrics 指标鉴权，不能管理监控项或通知");
  return 0;
}

async function uptimeKumaMonitors(
  args: string[],
  insecure: boolean,
  profile: ProfileContext,
): Promise<number> {
  const client = storedUptimeKumaClient(args, insecure, profile);
  const metrics = await client.metrics();
  if (flagPresent(args, "--json")) {
    outLine(prettyJsonSorted(metrics.monitors));
    return 0;
  }
  if (metrics.monitors.length === 0) {
    outLine("（没有监控项）");
    return 0;
  }
  for (const monitor of metrics.monitors) {
    const status = monitor.up ? "UP  " : "DOWN";
    outLine(`${status}  ${monitor.id}  ${monitor.name}  (${monitor.type})`);
  }
  return 0;
}

function storedUptimeKumaClient(
  args: string[],
  insecure: boolean,
  profile: ProfileContext,
): UptimeKumaClient {
  const store = openStore();
  const keys = kumaKeys(profile.prefix);
  const hint = profileHint(profile);
  const url = storedValue(store, keys.urlKey);
  if (url === null) {
    throw new Error(
      `尚未配置 Uptime Kuma 地址，先运行 flowlet uptime-kuma set --url=https://host/uptime-kuma${hint}`,
    );
  }
  const token = storedValue(store, keys.tokenKey);
  if (token === null) {
    throw new Error(
      `尚未保存 Uptime Kuma API Key，先运行 flowlet uptime-kuma set --url=https://host/uptime-kuma${hint}`,
    );
  }
  return new UptimeKumaClient(url, token, { insecure });
}

// ─── main ───────────────────────────────────────────────────────────────────

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    errLine(errorMessage(error));
    process.exitCode = 1;
  });