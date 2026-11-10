// Codex 账号观测与授权。权威实现：`src-tauri/src/core/codex_account.rs`。
//
// 数据位置：`<dataDir>/codex-accounts/<account-id>/{config.toml,auth.json,snapshot.json}`。
// 观测路径：优先直接调用 ChatGPT 官方用量接口（auth.json 里的 OAuth access token），
// 失败时回退 `codex app-server` 的 JSONL RPC；两者都失败则保留旧快照并标记 stale。
// 删除只移除 Flowlet 托管副本与快照，不触碰 Codex 客户端自身登录态。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { JsonRow } from "../types.ts";
import type { SqliteStorage } from "../storage/index.ts";
import {
  addJobEvent,
  createJob,
  failJob,
  finishJob,
  updateJobProgress,
} from "../storage/background-jobs.ts";
import { codexNodeBinDirs } from "./environment.ts";
import { describeNetworkError, httpJson, type AgentProxySettings } from "./http.ts";
import { codexAuthPath, codexHome } from "./paths.ts";

const RPC_TIMEOUT_MS = 12_000;
/** ChatGPT 官方用量接口（测试可覆盖为本地 fixture 服务）。 */
let codexUsageEndpoint = "https://chatgpt.com/backend-api/wham/usage";

export function setCodexUsageEndpointForTests(url: string | null): void {
  codexUsageEndpoint = url ?? "https://chatgpt.com/backend-api/wham/usage";
}
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const MANAGED_PROFILE_CONFIG = 'cli_auth_credentials_store = "file"\n';
const CODEX_SYNC_JOB_TYPE = "codex-account-sync";

export interface CodexUsageWindow {
  used_percent: number;
  window_duration_mins: number;
  resets_at: number;
}

export interface CodexCredits {
  has_credits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexRateLimitResetCredit {
  id: string;
  reset_type?: string | null;
  status?: string | null;
  granted_at?: number | null;
  expires_at?: number | null;
  title?: string | null;
  description?: string | null;
}

export interface CodexRateLimitResetCredits {
  available_count: number;
  credits: CodexRateLimitResetCredit[] | null;
}

export interface CodexAccountReport {
  account_id: string;
  signed_in: boolean;
  auth_mode: string | null;
  email: string | null;
  plan_type: string | null;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  credits: CodexCredits | null;
  rate_limit_reset_credits: CodexRateLimitResetCredits | null;
  rate_limit_reached_type: string | null;
  source: string;
  updated_at: string;
  stale: boolean;
  error: string | null;
}

export interface CodexAccountsReport {
  accounts: CodexAccountReport[];
}

export interface CodexAccountSyncResult {
  started: boolean;
  jobId: string | null;
  accounts: number;
  stale: number;
  failed: number;
  message: string;
}

export interface CodexAccountDeletionResult {
  accountId: string;
  email: string | null;
}

export function codexAccountsDir(dataDir: string): string {
  return path.join(dataDir, "codex-accounts");
}

function nowRfc3339(): string {
  return new Date().toISOString();
}

function isJsonObject(value: unknown): value is JsonRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(file: string): JsonRow {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`无法读取 ${file}：${message(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Codex 登录文件格式无效：${message(error)}`);
  }
  if (!isJsonObject(parsed)) throw new Error("Codex 登录文件格式无效：顶层必须是 JSON 对象");
  return parsed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSnapshot(file: string): CodexAccountReport | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isJsonObject(parsed)) return null;
    return normalizeStoredReport(parsed);
  } catch {
    return null;
  }
}

function normalizeStoredReport(row: JsonRow): CodexAccountReport {
  return {
    account_id: typeof row.account_id === "string" ? row.account_id : "",
    signed_in: row.signed_in === true,
    auth_mode: typeof row.auth_mode === "string" ? row.auth_mode : null,
    email: typeof row.email === "string" ? row.email : null,
    plan_type: typeof row.plan_type === "string" ? row.plan_type : null,
    primary: (row.primary as CodexUsageWindow | null | undefined) ?? null,
    secondary: (row.secondary as CodexUsageWindow | null | undefined) ?? null,
    credits: (row.credits as CodexCredits | null | undefined) ?? null,
    rate_limit_reset_credits:
      (row.rate_limit_reset_credits as CodexRateLimitResetCredits | null | undefined) ?? null,
    rate_limit_reached_type:
      typeof row.rate_limit_reached_type === "string" ? row.rate_limit_reached_type : null,
    source: typeof row.source === "string" ? row.source : "oauth",
    updated_at: typeof row.updated_at === "string" ? row.updated_at : nowRfc3339(),
    stale: row.stale === true,
    error: typeof row.error === "string" ? row.error : null,
  };
}

function writePrivateJson(file: string, value: unknown): void {
  // 与 Rust write_private_json 一致：先写同目录临时文件（0600）再原子替换。
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function profileDirectoryName(accountId: string): string {
  const safe = [...accountId]
    .map((character) => (/[A-Za-z0-9._-]/u.test(character) ? character : "_"))
    .join("");
  return safe === "" ? "unknown-account" : safe;
}

function isManagedProfileDirectory(target: string): boolean {
  try {
    if (!fs.statSync(target).isDirectory()) return false;
  } catch {
    return false;
  }
  return !path.basename(target).startsWith(".pending-");
}

function accountIdentity(accountId: string | null, email: string | null): string {
  if (accountId !== null && accountId !== "") return accountId;
  if (email !== null) return email;
  return "unknown-account";
}

function normalizedEmail(report: CodexAccountReport): string | null {
  const email = report.email?.trim();
  return email === undefined || email === "" ? null : email.toLowerCase();
}

function isFallbackAccountId(report: CodexAccountReport): boolean {
  if (report.account_id === "") return true;
  const email = normalizedEmail(report);
  return email !== null && report.account_id.toLowerCase() === email;
}

function sortAccounts(accounts: CodexAccountReport[]): void {
  accounts.sort((left, right) => {
    if (left.stale !== right.stale) return left.stale ? 1 : -1;
    if (left.email === right.email) return 0;
    if (left.email === null) return -1;
    if (right.email === null) return 1;
    return left.email < right.email ? -1 : 1;
  });
}

function sameAccountIdentity(left: CodexAccountReport, right: CodexAccountReport): boolean {
  if (left.account_id === right.account_id) return true;
  const leftEmail = normalizedEmail(left);
  const rightEmail = normalizedEmail(right);
  return leftEmail !== null && rightEmail !== null && leftEmail === rightEmail;
}

function mergeAccountReport(existing: CodexAccountReport, duplicate: CodexAccountReport): void {
  if (isFallbackAccountId(existing) && !isFallbackAccountId(duplicate)) {
    existing.account_id = duplicate.account_id;
  }
  existing.signed_in ||= duplicate.signed_in;
  existing.stale &&= duplicate.stale;
  if (duplicate.updated_at > existing.updated_at) {
    existing.updated_at = duplicate.updated_at;
    existing.primary = duplicate.primary;
    existing.secondary = duplicate.secondary;
    existing.credits = duplicate.credits;
    existing.rate_limit_reset_credits = duplicate.rate_limit_reset_credits;
    existing.rate_limit_reached_type = duplicate.rate_limit_reached_type;
    existing.error = duplicate.error;
  }
  existing.auth_mode ??= duplicate.auth_mode;
  existing.email ??= duplicate.email;
  existing.plan_type ??= duplicate.plan_type;
}

function deduplicateAccounts(accounts: CodexAccountReport[]): CodexAccountReport[] {
  const merged: CodexAccountReport[] = [];
  for (const account of accounts) {
    const existing = merged.find((item) => sameAccountIdentity(item, account));
    if (existing !== undefined) mergeAccountReport(existing, account);
    else merged.push(account);
  }
  return merged;
}

function listManagedProfileDirs(managedRoot: string): string[] {
  const entries = fs.readdirSync(managedRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(managedRoot, entry.name))
    .filter(isManagedProfileDirectory);
}

/** 只读托管目录快照（不联网、不启动子进程）。 */
export function listCachedCodexAccounts(managedRoot: string): CodexAccountsReport {
  ensureManagedRoot(managedRoot);
  const accounts = listManagedProfileDirs(managedRoot)
    .map((dir) => readSnapshot(path.join(dir, "snapshot.json")))
    .filter((report): report is CodexAccountReport => report !== null && report.signed_in);
  sortAccounts(accounts);
  return { accounts: deduplicateAccounts(accounts) };
}

function ensureManagedRoot(managedRoot: string): void {
  try {
    fs.mkdirSync(managedRoot, { recursive: true });
  } catch (error) {
    throw new Error(`无法创建 Codex 多账号目录：${message(error)}`);
  }
}

export async function queryCodexAccounts(
  managedRoot: string,
  proxy?: AgentProxySettings | null,
): Promise<CodexAccountsReport> {
  ensureManagedRoot(managedRoot);
  let currentError: string | null = null;
  let current: CodexAccountReport | null = null;
  try {
    current = await queryCurrentCodexAccount(proxy);
  } catch (error) {
    currentError = message(error);
  }
  if (current !== null && !current.signed_in) current = null;
  if (current !== null) {
    if (isFallbackAccountId(current)) {
      const canonical = canonicalManagedAccountId(managedRoot, current);
      if (canonical !== null) current.account_id = canonical;
    }
    try {
      const auth = readJson(codexAuthPath());
      persistManagedProfile(managedRoot, auth, current);
    } catch {
      // 无法读取当前登录文件时仍返回实时观测结果。
    }
  }
  const nativeAccountIdHint = current?.account_id ?? null;
  const nativeEmail = current === null ? null : normalizedEmail(current);
  const accounts: CodexAccountReport[] = current === null ? [] : [current];

  for (const profileDir of listManagedProfileDirs(managedRoot)) {
    const authPath = path.join(profileDir, "auth.json");
    const snapshotPath = path.join(profileDir, "snapshot.json");
    const storedSnapshot = readSnapshot(snapshotPath);
    const storedId = storedSnapshot?.account_id ?? readAuthAccountId(authPath);
    const matchesNativeEmail =
      storedSnapshot !== null &&
      normalizedEmail(storedSnapshot) !== null &&
      normalizedEmail(storedSnapshot) === nativeEmail;
    if (storedId !== null && storedId === nativeAccountIdHint) continue;
    if (matchesNativeEmail) continue;

    try {
      const report = await queryCodexAccountViaOauthPath(authPath, proxy);
      writePrivateJson(snapshotPath, report);
      accounts.push(report);
    } catch (oauthError) {
      try {
        const report = await queryCodexAccountViaAppServer(profileDir, proxy);
        if (report.signed_in) {
          writePrivateJson(snapshotPath, report);
          accounts.push(report);
          continue;
        }
      } catch (appServerError) {
        if (storedSnapshot !== null) {
          storedSnapshot.stale = true;
          storedSnapshot.error = `Codex 账号刷新失败。OAuth 会话：${message(oauthError)}；app-server：${message(appServerError)}`;
          accounts.push(storedSnapshot);
        }
        continue;
      }
      if (storedSnapshot !== null) {
        storedSnapshot.stale = true;
        storedSnapshot.error = "登录凭据已失效，请在 Codex 中重新登录该账号后刷新";
        accounts.push(storedSnapshot);
      }
    }
  }

  const deduplicated = deduplicateAccounts(accounts);
  sortAccounts(deduplicated);
  if (deduplicated.length === 0 && currentError !== null) throw new Error(currentError);
  return { accounts: deduplicated };
}

function readAuthAccountId(authPath: string): string | null {
  try {
    const auth = readJson(authPath);
    const tokens = auth.tokens;
    if (!isJsonObject(tokens)) return null;
    const accountId = tokens.account_id;
    return typeof accountId === "string" ? accountId : null;
  } catch {
    return null;
  }
}

function canonicalManagedAccountId(managedRoot: string, current: CodexAccountReport): string | null {
  const currentEmail = normalizedEmail(current);
  if (currentEmail === null) return null;
  for (const profileDir of listManagedProfileDirs(managedRoot)) {
    const snapshot = readSnapshot(path.join(profileDir, "snapshot.json"));
    if (snapshot === null) continue;
    if (normalizedEmail(snapshot) === currentEmail && !isFallbackAccountId(snapshot)) {
      return snapshot.account_id;
    }
  }
  return null;
}

function persistManagedProfile(managedRoot: string, auth: JsonRow, report: CodexAccountReport): void {
  const profileDir = path.join(managedRoot, profileDirectoryName(report.account_id));
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch (error) {
    throw new Error(`无法创建 Codex 账号目录：${message(error)}`);
  }
  writeManagedProfileConfig(profileDir);
  writePrivateJson(path.join(profileDir, "auth.json"), auth);
  writePrivateJson(path.join(profileDir, "snapshot.json"), report);
}

function writeManagedProfileConfig(profileDir: string): void {
  try {
    fs.writeFileSync(path.join(profileDir, "config.toml"), MANAGED_PROFILE_CONFIG);
  } catch (error) {
    throw new Error(`写入 Codex 独立账号配置失败：${message(error)}`);
  }
}

/** 刷新指定账号：只定向刷新该托管目录，不触碰其它账号。 */
export async function queryCodexAccount(
  managedRoot: string,
  accountId: string,
  proxy?: AgentProxySettings | null,
): Promise<CodexAccountReport> {
  ensureManagedRoot(managedRoot);
  const direct = path.join(managedRoot, profileDirectoryName(accountId));
  let profileDir: string;
  if (fs.existsSync(path.join(direct, "auth.json"))) {
    profileDir = direct;
  } else {
    const found = listManagedProfileDirs(managedRoot).find((candidate) => {
      const snapshot = readSnapshot(path.join(candidate, "snapshot.json"));
      return snapshot !== null && snapshot.account_id === accountId;
    });
    if (found === undefined) throw new Error(`未找到 Codex 账号 ${accountId} 的托管配置`);
    profileDir = found;
  }
  const authPath = path.join(profileDir, "auth.json");
  const snapshotPath = path.join(profileDir, "snapshot.json");
  if (!fs.existsSync(authPath)) {
    throw new Error(`未找到 Codex 账号 ${accountId} 的登录凭据`);
  }
  try {
    const report = await queryCodexAccountViaOauthPath(authPath, proxy);
    writePrivateJson(snapshotPath, report);
    return report;
  } catch (oauthError) {
    // 与 Rust 一致：app-server 成功但未登录 = 凭据失效；app-server 失败 = 组合错误。
    let appServerFailure: string | null = null;
    try {
      const report = await queryCodexAccountViaAppServer(profileDir, proxy);
      if (report.signed_in) {
        writePrivateJson(snapshotPath, report);
        return report;
      }
    } catch (appServerError) {
      appServerFailure = message(appServerError);
    }
    const snapshot = readSnapshot(snapshotPath);
    if (snapshot !== null) {
      snapshot.stale = true;
      snapshot.error =
        appServerFailure === null
          ? "登录凭据已失效，请在 Codex 中重新登录该账号后刷新"
          : `Codex 账号刷新失败。OAuth 会话：${message(oauthError)}；app-server：${appServerFailure}`;
      writePrivateJson(snapshotPath, snapshot);
      return snapshot;
    }
    throw new Error(`Codex 账号 ${accountId} 刷新失败。OAuth 会话：${message(oauthError)}`);
  }
}

export function deleteCodexAccount(
  managedRoot: string,
  accountId: string,
): CodexAccountDeletionResult {
  ensureManagedRoot(managedRoot);
  const direct = path.join(managedRoot, profileDirectoryName(accountId));
  let profileDir: string;
  if (fs.existsSync(path.join(direct, "auth.json"))) {
    profileDir = direct;
  } else {
    const found = listManagedProfileDirs(managedRoot).find((candidate) => {
      const snapshot = readSnapshot(path.join(candidate, "snapshot.json"));
      return snapshot !== null && snapshot.account_id === accountId;
    });
    if (found === undefined) throw new Error(`未找到 Codex 账号 ${accountId} 的托管配置`);
    profileDir = found;
  }
  const snapshot = readSnapshot(path.join(profileDir, "snapshot.json"));
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`删除 Codex 账号 ${accountId} 托管配置失败：${message(error)}`);
  }
  return { accountId, email: snapshot?.email ?? null };
}

function hasCodexAccountSources(managedRoot: string, home: string): boolean {
  if (fs.existsSync(path.join(home, "auth.json"))) return true;
  try {
    return listManagedProfileDirs(managedRoot).length > 0;
  } catch {
    return false;
  }
}

export interface SyncCodexAccountsInput {
  storage: SqliteStorage;
  managedRoot: string;
  home?: string;
  trigger: string;
  proxy?: AgentProxySettings | null;
  /** 由命令层提供的租约（存在并发同步时返回 false）。 */
  tryAcquire: () => boolean;
  release: () => void;
}

/** 后台刷新 Codex 账号与用量，并写入后台任务日志。 */
export async function syncCodexAccounts(input: SyncCodexAccountsInput): Promise<CodexAccountSyncResult> {
  const home = input.home ?? codexHome();
  if (!hasCodexAccountSources(input.managedRoot, home)) {
    return {
      started: false,
      jobId: null,
      accounts: 0,
      stale: 0,
      failed: 0,
      message: "未发现 Codex 账号，已跳过本次同步",
    };
  }
  if (!input.tryAcquire()) {
    return {
      started: false,
      jobId: null,
      accounts: 0,
      stale: 0,
      failed: 0,
      message: "已有 Codex 账号同步正在运行",
    };
  }
  try {
    const jobId = randomUUID();
    input.storage.withDatabase((db) => {
      createJob(db, {
        id: jobId,
        jobType: CODEX_SYNC_JOB_TYPE,
        title: "Codex 账号与用量同步",
        stage: "查询账号与用量",
        trigger: input.trigger,
        total: 0,
        firstEventMessage: "开始查询 Codex 账号与用量",
        eventId: randomUUID(),
      });
    });
    const startedAt = Date.now();
    try {
      const report = await queryCodexAccounts(input.managedRoot, input.proxy);
      const total = report.accounts.length;
      const stale = report.accounts.filter((account) => account.stale).length;
      const failed = report.accounts.filter((account) => account.error !== null).length;
      input.storage.withDatabase((db) => {
        updateJobProgress(db, jobId, total, total);
        for (const account of report.accounts) {
          if (account.error === null) continue;
          const identity =
            account.email !== null && account.email.trim() !== ""
              ? account.email
              : accountIdentity(account.account_id, null);
          addJobEvent(db, {
            eventId: randomUUID(),
            jobId,
            level: "warning",
            stage: "账号刷新失败",
            message: `${identity}：${account.error}`,
          });
        }
        const status = failed === 0 && stale === 0 ? "succeeded" : "succeeded_with_warnings";
        finishJob(db, {
          jobId,
          status,
          summaryJson: JSON.stringify({
            accounts: total,
            staleAccounts: stale,
            failedAccounts: failed,
            durationMs: Date.now() - startedAt,
          }),
          doneMessage: "Codex 账号与用量同步完成",
          eventId: randomUUID(),
        });
      });
      return {
        started: true,
        jobId,
        accounts: total,
        stale,
        failed,
        message:
          failed === 0
            ? `已同步 ${total} 个 Codex 账号与用量`
            : `已同步 ${total} 个 Codex 账号，其中 ${failed} 个刷新失败`,
      };
    } catch (error) {
      input.storage.withDatabase((db) =>
        failJob(db, { jobId, error: message(error), eventId: randomUUID() }),
      );
      return {
        started: true,
        jobId,
        accounts: 0,
        stale: 0,
        failed: 1,
        message: `Codex 账号同步失败：${message(error)}`,
      };
    }
  } finally {
    input.release();
  }
}

// ─── 授权 ───────────────────────────────────────────────────────────────────

/**
 * 通过 `codex app-server` 启动 ChatGPT 登录：打开浏览器 → 等待登录完成 →
 * 读取独立目录的 auth.json → 写入托管副本与快照。
 */
export async function authorizeCodexAccount(
  managedRoot: string,
  openAuthUrl: (url: string) => Promise<void>,
  proxy?: AgentProxySettings | null,
): Promise<CodexAccountReport> {
  ensureManagedRoot(managedRoot);
  const pendingDir = path.join(managedRoot, `.pending-${randomUUID()}`);
  fs.mkdirSync(pendingDir, { recursive: true });
  try {
    writeManagedProfileConfig(pendingDir);
  } catch (error) {
    fs.rmSync(pendingDir, { recursive: true, force: true });
    throw error;
  }

  let rpc: CodexRpc;
  try {
    rpc = await startCodexRpc(pendingDir);
  } catch (error) {
    fs.rmSync(pendingDir, { recursive: true, force: true });
    throw error;
  }
  try {
    await initializeCodexRpc(rpc);
    const login = await rpc.call(2, "account/login/start", {
      type: "chatgpt",
      useHostedLoginSuccessPage: true,
      appBrand: "chatgpt",
    });
    const loginId = login.loginId;
    const authUrl = login.authUrl;
    if (typeof loginId !== "string" || loginId === "") throw new Error("Codex 登录流程未返回 loginId");
    if (typeof authUrl !== "string" || authUrl === "") throw new Error("Codex 登录流程未返回授权地址");
    await openAuthUrl(authUrl);
    await rpc.waitForLoginCompleted(loginId);

    const authPath = path.join(pendingDir, "auth.json");
    let report: CodexAccountReport;
    try {
      report = await queryCodexAccountViaOauthPath(authPath, proxy);
    } catch {
      report = await readCodexAccountReport(rpc, false, 3);
    }
    if (!report.signed_in) {
      throw new Error("Codex 独立账号授权完成后仍未检测到登录状态");
    }
    const auth = readJson(authPath);
    persistManagedProfile(managedRoot, auth, report);
    return report;
  } finally {
    await rpc.stop();
    fs.rmSync(pendingDir, { recursive: true, force: true });
  }
}

// ─── OAuth 用量 ─────────────────────────────────────────────────────────────

async function queryCurrentCodexAccount(proxy?: AgentProxySettings | null): Promise<CodexAccountReport> {
  try {
    return await queryCodexAccountViaOauthPath(codexAuthPath(), proxy);
  } catch (oauthError) {
    try {
      return await queryCodexAccountViaAppServer(null, proxy);
    } catch (appServerError) {
      throw new Error(
        `Codex 账号查询失败。OAuth 会话：${message(oauthError)}；app-server：${message(appServerError)}`,
      );
    }
  }
}

async function queryCodexAccountViaOauthPath(
  authPath: string,
  proxy?: AgentProxySettings | null,
): Promise<CodexAccountReport> {
  const auth = readJson(authPath);
  const tokens = auth.tokens;
  const accessToken =
    isJsonObject(tokens) && typeof tokens.access_token === "string" ? tokens.access_token : "";
  if (accessToken === "") throw new Error("未找到 ChatGPT OAuth 会话");
  let response;
  try {
    response = await httpJson(codexUsageEndpoint, {
      timeoutMs: RPC_TIMEOUT_MS,
      proxy: proxy ?? null,
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
  } catch (error) {
    throw new Error(`官方用量接口请求失败：${describeNetworkError(error)}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`官方用量接口返回 HTTP ${response.status}`);
  }
  if (!isJsonObject(response.value)) throw new Error("官方用量接口返回了无效数据");
  const authAccountId =
    isJsonObject(tokens) && typeof tokens.account_id === "string" ? tokens.account_id : undefined;
  return parseOauthUsage(response.value, authAccountId);
}

function optionalString(row: JsonRow, camel: string, snake: string): string | null {
  const value = row[camel] ?? row[snake];
  return typeof value === "string" ? value : null;
}

function optionalInteger(row: JsonRow, camel: string, snake: string): number | null {
  const value = row[camel] ?? row[snake];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseOauthUsageWindow(value: unknown): CodexUsageWindow | null {
  if (!isJsonObject(value)) return null;
  const usedPercent = asNumber(value.used_percent);
  const limitSeconds = asNumber(value.limit_window_seconds);
  const resetAt = asNumber(value.reset_at);
  if (usedPercent === null || limitSeconds === null || resetAt === null) return null;
  return {
    used_percent: usedPercent,
    window_duration_mins: Math.trunc(limitSeconds / 60),
    resets_at: Math.trunc(resetAt),
  };
}

function parseOauthCredits(value: unknown): CodexCredits | null {
  if (!isJsonObject(value)) return null;
  if (typeof value.has_credits !== "boolean" || typeof value.unlimited !== "boolean") return null;
  const balance = value.balance;
  return {
    has_credits: value.has_credits,
    unlimited: value.unlimited,
    balance:
      typeof balance === "string" ? balance : typeof balance === "number" ? String(balance) : null,
  };
}

function parseRateLimitResetCredit(value: unknown): CodexRateLimitResetCredit | null {
  if (!isJsonObject(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    reset_type: optionalString(value, "resetType", "reset_type"),
    status: typeof value.status === "string" ? value.status : null,
    granted_at: optionalInteger(value, "grantedAt", "granted_at"),
    expires_at: optionalInteger(value, "expiresAt", "expires_at"),
    title: typeof value.title === "string" ? value.title : null,
    description: typeof value.description === "string" ? value.description : null,
  };
}

function parseRateLimitResetCredits(value: unknown): CodexRateLimitResetCredits | null {
  if (!isJsonObject(value)) return null;
  const availableCount = value.availableCount ?? value.available_count;
  if (typeof availableCount !== "number" || !Number.isInteger(availableCount)) return null;
  let credits: CodexRateLimitResetCredit[] | null = null;
  if (Array.isArray(value.credits)) {
    credits = value.credits
      .map(parseRateLimitResetCredit)
      .filter((credit): credit is CodexRateLimitResetCredit => credit !== null);
  } else if (value.credits !== undefined && value.credits !== null) {
    return null;
  }
  return { available_count: availableCount, credits };
}

/** 解析官方用量接口响应（导出以便单测覆盖字段映射与错误分支）。 */
export function parseOauthUsage(
  usage: JsonRow,
  authAccountId: string | undefined,
): CodexAccountReport {
  const email = typeof usage.email === "string" ? usage.email : null;
  const planType = typeof usage.plan_type === "string" ? usage.plan_type : null;
  if (email === null && planType === null) throw new Error("官方用量接口未返回账号信息");
  const rateLimit = isJsonObject(usage.rate_limit) ? usage.rate_limit : null;
  const accountIdFromUsage =
    typeof usage.account_id === "string" && usage.account_id !== "" ? usage.account_id : undefined;
  return {
    account_id: accountIdentity(accountIdFromUsage ?? authAccountId ?? null, email),
    signed_in: true,
    auth_mode: "chatgpt",
    email,
    plan_type: planType,
    primary: rateLimit === null ? null : parseOauthUsageWindow(rateLimit.primary_window),
    secondary: rateLimit === null ? null : parseOauthUsageWindow(rateLimit.secondary_window),
    credits: parseOauthCredits(usage.credits),
    rate_limit_reset_credits: parseRateLimitResetCredits(
      usage.rate_limit_reset_credits ?? usage.rateLimitResetCredits,
    ),
    rate_limit_reached_type:
      typeof usage.rate_limit_reached_type === "string" ? usage.rate_limit_reached_type : null,
    source: "oauth",
    updated_at: nowRfc3339(),
    stale: false,
    error: null,
  };
}

// ─── codex app-server RPC ──────────────────────────────────────────────────

async function queryCodexAccountViaAppServer(
  homeOverride: string | null,
  proxy?: AgentProxySettings | null,
): Promise<CodexAccountReport> {
  const rpc = await startCodexRpc(homeOverride, proxy);
  try {
    await initializeCodexRpc(rpc);
    return await readCodexAccountReport(rpc, true, 2);
  } finally {
    await rpc.stop();
  }
}

let codexExecutableOverride: string | null = null;

/** 覆盖 Codex CLI 可执行文件（测试用；避免依赖开发机是否安装 Codex CLI）。 */
export function setCodexExecutableForTests(executable: string | null): void {
  codexExecutableOverride = executable;
}

async function resolveCodexExecutable(): Promise<string> {
  if (codexExecutableOverride !== null) return codexExecutableOverride;
  const { detectAgentEnvironment } = await import("./environment.ts");
  const report = await detectAgentEnvironment("codex");
  const installation = report.installations.find(
    (item) => item.surface === "cli" && item.version_output !== null && item.error === null,
  );
  if (installation !== undefined) return installation.executable_path;
  const desktopDetected = report.installations.some((item) => item.surface === "desktop");
  throw new Error(
    desktopDetected
      ? "已检测到 ChatGPT/Codex Desktop，但账号授权需要独立安装且可运行的 Codex CLI。请先安装 Codex CLI，安装完成后再授权"
      : "未检测到可运行的 Codex CLI。请先安装 Codex CLI，安装完成后再授权",
  );
}

async function startCodexRpc(
  homeOverride: string | null,
  proxy?: AgentProxySettings | null,
): Promise<CodexRpc> {
  const executable = await resolveCodexExecutable();
  // Windows 没有可执行位：不存在的路径必须自己判掉，否则 powershell 会「成功启动」再报
  // CommandNotFoundException，错误原因被吞进子进程 stderr 且文案随系统语言变化。
  if (process.platform === "win32" && !fs.existsSync(executable)) {
    throw new Error(`无法启动 Codex app-server（${executable}）：可执行文件不存在或不可访问`);
  }
  const args =
    process.platform === "win32"
      ? [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `& '${executable.replace(/'/gu, "''")}' -s read-only -a never app-server`,
        ]
      : ["-s", "read-only", "-a", "never", "app-server"];
  const program = process.platform === "win32" ? "powershell.exe" : executable;
  const env = { ...process.env };
  if (homeOverride !== null) env.CODEX_HOME = homeOverride;
  const extraPath = codexNodeBinDirs();
  if (extraPath.length > 0) {
    const separator = process.platform === "win32" ? ";" : ":";
    env.PATH = `${extraPath.join(separator)}${separator}${env.PATH ?? ""}`;
  }
  if (proxy !== null && proxy !== undefined && proxy.enabled && proxy.url.trim() !== "") {
    env.HTTPS_PROXY = proxy.url.trim();
    env.HTTP_PROXY = proxy.url.trim();
  }
  const child = spawn(program, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error) => {
      reject(
        new Error(
          `无法启动 Codex app-server（${executable}）：${message(error)}`,
        ),
      );
    });
  });
  return new CodexRpc(child);
}

async function initializeCodexRpc(rpc: CodexRpc): Promise<void> {
  await rpc.call(1, "initialize", {
    clientInfo: { name: "flowlet", title: "Flowlet", version: "0.1.0" },
  });
  rpc.notify("initialized", null);
}

function asUsageWindow(value: unknown): CodexUsageWindow | null {
  if (!isJsonObject(value)) return null;
  const usedPercent = asNumber(value.usedPercent);
  const duration = asNumber(value.windowDurationMins);
  const resetsAt = asNumber(value.resetsAt);
  if (usedPercent === null || duration === null || resetsAt === null) return null;
  return {
    used_percent: usedPercent,
    window_duration_mins: Math.trunc(duration),
    resets_at: Math.trunc(resetsAt),
  };
}

function asCredits(value: unknown): CodexCredits | null {
  if (!isJsonObject(value)) return null;
  if (typeof value.hasCredits !== "boolean" || typeof value.unlimited !== "boolean") return null;
  const balance = value.balance;
  return {
    has_credits: value.hasCredits,
    unlimited: value.unlimited,
    balance:
      typeof balance === "string" ? balance : typeof balance === "number" ? String(balance) : null,
  };
}

async function readCodexAccountReport(
  rpc: CodexRpc,
  refreshToken: boolean,
  accountCallId: number,
): Promise<CodexAccountReport> {
  const account = await rpc.call(accountCallId, "account/read", {
    refreshToken,
  });
  const accountValue = isJsonObject(account.account) ? account.account : null;
  const authMode = accountValue !== null && typeof accountValue.type === "string" ? accountValue.type : null;
  const email = accountValue !== null && typeof accountValue.email === "string" ? accountValue.email : null;
  const accountPlan =
    accountValue !== null && typeof accountValue.planType === "string" ? accountValue.planType : null;
  if (accountValue === null) {
    return {
      account_id: "",
      signed_in: false,
      auth_mode: null,
      email: null,
      plan_type: null,
      primary: null,
      secondary: null,
      credits: null,
      rate_limit_reset_credits: null,
      rate_limit_reached_type: null,
      source: "app_server",
      updated_at: nowRfc3339(),
      stale: false,
      error: null,
    };
  }
  let rateLimitResult: JsonRow | null = null;
  if (authMode === "chatgpt") {
    rateLimitResult = await rpc.call(accountCallId + 1, "account/rateLimits/read", null);
  }
  const rateLimits =
    rateLimitResult !== null && isJsonObject(rateLimitResult.rateLimits)
      ? rateLimitResult.rateLimits
      : null;
  return {
    account_id:
      accountValue !== null && typeof accountValue.accountId === "string"
        ? accountValue.accountId
        : accountIdentity(null, email),
    signed_in: true,
    auth_mode: authMode,
    email,
    plan_type:
      (rateLimits !== null && typeof rateLimits.planType === "string" ? rateLimits.planType : null) ??
      accountPlan,
    primary: rateLimits === null ? null : asUsageWindow(rateLimits.primary),
    secondary: rateLimits === null ? null : asUsageWindow(rateLimits.secondary),
    credits: rateLimits === null ? null : asCredits(rateLimits.credits),
    rate_limit_reset_credits:
      rateLimitResult === null ? null : parseRateLimitResetCredits(rateLimitResult.rateLimitResetCredits),
    rate_limit_reached_type:
      rateLimits !== null && typeof rateLimits.rateLimitReachedType === "string"
        ? rateLimits.rateLimitReachedType
        : null,
    source: "app_server",
    updated_at: nowRfc3339(),
    stale: false,
    error: null,
  };
}

interface RpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

class CodexRpc {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    number,
    {
      method: string;
      resolve: (value: JsonRow) => void;
      reject: (error: Error) => void;
    }
  >();
  readonly #notifications: JsonRow[] = [];
  readonly #waiters: Array<() => void> = [];
  #buffer = "";
  #stderr = "";
  #closed = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    child.once("exit", () => {
      this.#closed = true;
      for (const waiter of this.#pending.values()) {
        waiter.reject(new Error(this.#exitMessage("意外退出")));
      }
      this.#pending.clear();
      this.#wake();
    });
  }

  #exitMessage(context: string): string {
    const statusDetail = this.#child.exitCode === null ? "退出状态未知" : `退出状态：${this.#child.exitCode}`;
    const stderr = this.#stderr.trim();
    return stderr === ""
      ? `Codex app-server ${context}（${statusDetail}）`
      : `Codex app-server ${context}（${statusDetail}）：${compactProcessOutput(stderr)}`;
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const index = this.#buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isJsonObject(parsed)) continue;
      this.#handle(parsed as RpcMessage);
    }
  }

  #handle(message: RpcMessage): void {
    if (typeof message.id === "number" && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (pending === undefined) return;
      if (message.error !== undefined) {
        const detail =
          isJsonObject(message.error) && typeof message.error.message === "string"
            ? message.error.message
            : "未知错误";
        pending.reject(new Error(`Codex app-server 调用 ${pending.method} 失败：${detail}`));
        return;
      }
      if (!isJsonObject(message.result)) {
        pending.reject(new Error(`Codex app-server 调用 ${pending.method} 缺少结果`));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      this.#notifications.push(message as JsonRow);
      this.#wake();
    }
  }

  #wake(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      waiter?.();
    }
  }

  async call(id: number, method: string, params: JsonRow | null): Promise<JsonRow> {
    const request: JsonRow = { method, id };
    if (params !== null) request.params = params;
    this.#send(request);
    return await new Promise<JsonRow>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new Error(`Codex app-server 调用 ${method} 超时`));
        }
      }, RPC_TIMEOUT_MS);
      this.#pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (this.#closed) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new Error(this.#exitMessage("意外退出")));
      }
    });
  }

  notify(method: string, params: JsonRow | null): void {
    const request: JsonRow = { method };
    if (params !== null) request.params = params;
    this.#send(request);
  }

  #send(value: JsonRow): void {
    if (this.#closed) throw new Error(this.#exitMessage("已退出"));
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async waitForLoginCompleted(expectedLoginId: string): Promise<void> {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    for (;;) {
      const index = this.#notifications.findIndex((notification) => {
        if (notification.method !== "account/login/completed") return false;
        const params = notification.params;
        return isJsonObject(params) && params.loginId === expectedLoginId;
      });
      if (index >= 0) {
        const [notification] = this.#notifications.splice(index, 1);
        const params = isJsonObject(notification.params) ? notification.params : {};
        if (params.success === true) return;
        const detail = typeof params.error === "string" ? params.error : "未知错误";
        throw new Error(`Codex 账号授权失败：${detail}`);
      }
      if (this.#closed) throw new Error(this.#exitMessage("在登录完成前意外退出"));
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("等待 Codex 账号授权超时，请重试");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 250));
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function compactProcessOutput(output: string): string {
  const compact = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" | ");
  return compact.length <= 600 ? compact : `${compact.slice(0, 600)}…`;
}