#!/usr/bin/env node
// `flowlet-cred`：Flowlet 全局凭据库的 Node 入口。Owner: node-web。
//
// 权威实现：src-tauri/src/bin/flowlet_cred.rs（606 行）+ core/credential_store.rs +
// core/gitlab.rs。Node 版为默认实现（不再需要 Rust 产物）；Rust 版标 legacy。
//
// 与 Rust 的刻意差异（docs/credential-cli.md §3）：
// - `get` 默认掩码，`--reveal` 才输出明文（安全默认）；`--mask` 仍兼容；
// - 额外提供 `clear` 清空全部凭据（保留注释与文件头）。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Agent, request } from "undici";

import { GitlabClient, GitlabError, normalizeBaseUrl, type ProjectSummary } from "./gitlab.ts";
import { CredentialStore, type ExportFormat } from "./store.ts";

const GITLAB_URL_KEY = "GITLAB_URL";
const GITLAB_TOKEN_KEY = "GITLAB_TOKEN";

const USAGE = `flowlet-cred — Flowlet 全局凭据库

用法：
  flowlet-cred init                              初始化凭据目录
  flowlet-cred path                              打印凭据文件路径
  flowlet-cred list [--json]                     列出凭据名（永不含明文值）
  flowlet-cred get <KEY> [--reveal]              输出单个凭据值（默认掩码）
  flowlet-cred set <KEY> [--kind=K] [--note=N]   新增/更新（值从 stdin 读取，或 --value=V）
  flowlet-cred unset <KEY>                       删除
  flowlet-cred clear                             清空全部凭据（保留注释）
  flowlet-cred env [--only=A,B]                  输出 dotenv，可 eval/写入其它 .env
  flowlet-cred export [--only=A,B] [--format=dotenv|shell|json]
  flowlet-cred run --with=A,B -- <程序> [参数...]  只把指定凭据注入子进程环境
  flowlet-cred doctor                            检查权限、重复键与元数据

GitLab（API v4，按 GitLab CE 10.8.7 实现）：
  flowlet-cred gitlab set --url=https://gitlab.example.com     token 从 stdin 读取并校验
  flowlet-cred gitlab status [--insecure]                       用户、版本、API 地址
  flowlet-cred gitlab projects [--search=S] [--limit=N] [--all] [--json]
  flowlet-cred gitlab api <METHOD> <PATH> [--data=JSON]         透传 10.8 已存在的端点
  flowlet-cred gitlab env                                       输出 GITLAB_URL / GITLAB_TOKEN
  flowlet-cred gitlab clear                                     移除 GitLab 凭据

远程同步（Docker / 服务端管理的凭据 → 本机 .env）：
  flowlet-cred pull --server=http://10.100.217.60:20134 [--token=管理凭据]
  flowlet-cred pull --server=... --dry-run                       只显示将要写入的键名

说明：
  - 值永远不会被 list 打印；set 时建议通过 stdin 传值，避免出现在进程列表里。
  - \`run\` 是推荐用法：Agent 不需要看到明文，只要让命令用上凭据。
  - 凭据类型（--kind）目前只是标签，默认 api_key。
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
      outLine(`flowlet-cred ${VERSION}`);
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
    case "gitlab":
      return gitlabCommand(rest);
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
    throw new Error("run 需要 `--` 分隔符，例如：flowlet-cred run --with=GITHUB_PAT -- gh pr list");
  }
  const command = args.slice(separator + 1);
  if (command.length === 0) {
    throw new Error("run 需要指定要执行的命令，例如：flowlet-cred run --with=GITHUB_PAT -- gh pr list");
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

// ─── 远程同步（pull） ───────────────────────────────────────────────────────

interface ServiceCredentialExport {
  name: string;
  provider: string;
  baseUrl: string;
  token: string;
}

function envKeys(entry: ServiceCredentialExport): Array<[string, string, string]> {
  if (entry.provider === "gitlab") {
    return [
      ["GITLAB_URL", entry.baseUrl, "service"],
      ["GITLAB_TOKEN", entry.token, "cli_token"],
    ];
  }
  return [];
}

async function pullCommand(args: string[]): Promise<number> {
  const rawServer = optionValue(args, "--server");
  if (rawServer === null) throw new Error("pull 需要 --server=http://<flowlet-web-host>:<port>");
  const server = rawServer.replace(/\/+$/, "");
  if (!(server.startsWith("http://") || server.startsWith("https://"))) {
    throw new Error("--server 必须是 http 或 https 地址");
  }
  const tokenOption = optionValue(args, "--token");
  const token = tokenOption ?? process.env.FLOWLET_ADMIN_TOKEN;
  if (token === undefined) {
    throw new Error("缺少管理凭据：用 --token=... 或设置 FLOWLET_ADMIN_TOKEN");
  }
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
    throw new Error("管理凭据无效（401）：请检查 --token / FLOWLET_ADMIN_TOKEN");
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
  switch (sub) {
    case "set":
      return gitlabSet(args, insecure);
    case "status":
      return gitlabStatus(insecure);
    case "projects":
      return gitlabProjects(args, insecure);
    case "api":
      return gitlabApi(args, insecure);
    case "env": {
      const store = openStore();
      const url = storedGitlabUrl(store);
      if (url === null) {
        throw new Error("尚未配置 GitLab 地址，先运行 flowlet-cred gitlab set --url=...");
      }
      const token = storedGitlabToken(store);
      if (token === null) {
        throw new Error("尚未保存 GitLab token，先运行 flowlet-cred gitlab set --url=...");
      }
      errLine("注意：下面输出包含明文 token，只应在可信 shell 中使用。");
      outLine(`GITLAB_URL=${url}`);
      outLine(`GITLAB_TOKEN=${token}`);
      return 0;
    }
    case "clear": {
      const store = openStore();
      const urlRemoved = store.unset(GITLAB_URL_KEY);
      const tokenRemoved = store.unset(GITLAB_TOKEN_KEY);
      outLine(urlRemoved || tokenRemoved ? "已移除 GitLab 凭据" : "没有可移除的 GitLab 凭据");
      return 0;
    }
    default:
      throw new Error(`未知的 gitlab 子命令：${sub}（set|status|projects|api|env|clear）`);
  }
}

async function gitlabSet(args: string[], insecure: boolean): Promise<number> {
  const store = openStore();
  let url = optionValue(args, "--url");
  if (url === null) url = storedGitlabUrl(store);
  if (url === null) {
    throw new Error("缺少 --url，例如：flowlet-cred gitlab set --url=https://gitlab.example.com");
  }
  const token = readStdinValue();
  if (token === "") {
    throw new Error(
      "GitLab token 不能为空：用 `printf '%s' \"$TOKEN\" | flowlet-cred gitlab set ...`",
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
  store.set(GITLAB_URL_KEY, base, "service", "gitlab 实例地址（API v4）");
  store.set(GITLAB_TOKEN_KEY, token, "cli_token", "gitlab personal access token");
  outLine(`已保存 GitLab 凭据：${client.apiBase()}`);
  outLine(describeUser(user));
  return 0;
}

async function gitlabStatus(insecure: boolean): Promise<number> {
  const client = storedGitlabClient(insecure);
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

async function gitlabProjects(args: string[], insecure: boolean): Promise<number> {
  const client = storedGitlabClient(insecure);
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

async function gitlabApi(args: string[], insecure: boolean): Promise<number> {
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
  const client = storedGitlabClient(insecure);
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

function storedGitlabUrl(store: CredentialStore): string | null {
  const value = store.get(GITLAB_URL_KEY)?.trim() ?? "";
  return value === "" ? null : value;
}

function storedGitlabToken(store: CredentialStore): string | null {
  const value = store.get(GITLAB_TOKEN_KEY)?.trim() ?? "";
  return value === "" ? null : value;
}

function storedGitlabClient(insecure: boolean): GitlabClient {
  const store = openStore();
  const url = storedGitlabUrl(store);
  if (url === null) {
    throw new Error(
      "尚未配置 GitLab 地址，先运行 flowlet-cred gitlab set --url=https://gitlab.example.com",
    );
  }
  const token = storedGitlabToken(store);
  if (token === null) {
    throw new Error(
      "尚未保存 GitLab token，先运行 flowlet-cred gitlab set --url=https://gitlab.example.com",
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

// ─── main ───────────────────────────────────────────────────────────────────

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    errLine(errorMessage(error));
    process.exitCode = 1;
  });