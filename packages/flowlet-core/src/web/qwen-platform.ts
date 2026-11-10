// 千问平台 HTTP 通道（Node Host 版）：device-flow 登录 + BssOpenAPI / cs-data 直连查询。
//
// 权威实现：src-tauri/src/core/qwen_platform.rs（Rust 版已用真实账号验证）。本文件
// 逐条等价移植：命令返回形状、错误文案、凭据落盘位置与权限、device flow 轮询状态
// 映射、网关信封校验、免费额度单位归一、slot bundle 形状都必须与 Rust 一致，因为
// 前端 `qwenFreetierDetails` / 余额快照表直接消费同一份 bundle。
//
// 与 Rust 的差异仅限运行时能力：
// - 网络走全局 `fetch`（Node 26），超时用 `AbortSignal.timeout`；Rust 版按账号套用
//   上游代理，Web Host 的平台请求暂不经过 upstream proxy。
// - 数据目录用 `ctx.catalogDir`（Docker 为 /data），即 `<catalogDir>/qwen-platform/`；
//   Rust 用 SQLite 所在目录。两者都只写「数据卷」，不写 SQLite。
//
// 令牌没有 refresh token：过期后只能重新走一次 device flow。凭据按**千问平台账号**
// 共享，保存在 `qwen-platform/credentials.json`（0600）：同一个平台账号下多个 Flowlet
// Qwen 账号只登录一次。旧版按账号的 `qwen-platform/<account_id>.json` 会惰性迁移。
// 凭据不写入 SQLite，也不复用模型 API Key。
//
// 一次同步同时拉取「按量付费」与「Token Plan」两套数据，合并成一个 rawScrapedJson
// slot bundle：{billing_amount, fq_instance, settle_bill?, subscription,
// quota_config, usage, reset_card_list?}。balance/currency 取按量付费结果；Token Plan
// 无订阅（业务错误/缺失）时只跳过其槽位，鉴权失效仍整体报登录过期。
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { CommandError } from "../types.ts";
import type { JsonRow } from "../types.ts";
import type { WebContext } from "./context.ts";

export const QWEN_CHANNEL_ID = "qwen";
/** 登录失效时返回给前端的固定文案（与 Rust 一致，前端据此提示重新登录）。 */
export const LOGIN_EXPIRED_MESSAGE = "千问平台登录已过期，请重新登录千问平台";
const NOT_LOGGED_IN_MESSAGE = "尚未登录千问平台";
/** 与前端 `isQwenPayAsYouGoAccount` 保持一致：缺省视为历史默认的按量付费。 */
const QWEN_PAY_AS_YOU_GO_MODE = "pay_as_you_go";
const QWEN_TOKEN_PLAN_MODE = "token_plan";

const AUTH_BASE = "https://t.qianwenai.com";
const API_BASE = "https://cli.qianwenai.com";
const MODEL_MAPPING_URL = "https://alioth.alicdn.com/model-mapping";
const CS_DATA_BASE = "https://cs-data.qianwenai.com";
const BSS_PRODUCT = "BssOpenAPI-V3";
const REGION = "cn-beijing";
const SOURCE = "qwen_platform";
const REMARK = "千问平台 API";
const HTTP_TIMEOUT_MS = 20_000;
const FQ_PAGE_SIZE = 500;
const MAX_FQ_PAGES = 10;
const CREDENTIALS_DIR = "qwen-platform";
const CLIENT_ID_FILE = "client-id";
/** 共享平台凭据存储（所有 Qwen 账号共用一份）。 */
const CREDENTIALS_FILE = "credentials.json";

const CLI_ACCESS_PRODUCT = "ModelStudioRegional";
const CLI_ACCESS_ACTION = "GenerateCLIAccessToken";
const CLI_ACCESS_VERSION = "2026-02-10";
/** Token Plan 个人版套餐商品码（CLI `features.tokenPlanCommodityCodes.soloBuy`）。 */
export const TOKEN_PLAN_SOLO_BUY_COMMODITY = "sfm_tokenplansolo_public_cn";

export const CS_API_SUBSCRIPTION = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription";
export const CS_API_QUOTA_CONFIG = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config";
export const CS_API_USAGE = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
export const CS_API_RESET_CARDS = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/reset-card/list";

// ─── 对外返回结构（camelCase，与 Rust serde 输出一致） ──────────────────────

export interface PlatformStatus {
  accountId: string;
  loggedIn: boolean;
  aliyunId: string | null;
  email: string | null;
  expiresAt: string | null;
}

export interface LoginChallenge {
  verificationUrl: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type LoginPollStatus = "pending" | "slow_down" | "complete" | "expired" | "denied";

export interface LoginPoll {
  status: LoginPollStatus;
  aliyunId: string | null;
  email: string | null;
}

export interface PlatformSyncResult {
  accountId: string;
  balance: number | null;
  currency: string | null;
  syncedAt: string;
  rawScrapedJson: string;
}

export interface PlatformCredentials {
  accessToken: string;
  expiresAt: string | null;
  aliyunId: string | null;
  email: string | null;
  updatedAt: string;
}

export type PlatformAccountKind = "pay_as_you_go" | "token_plan";

// ─── 错误 ───────────────────────────────────────────────────────────────────

/**
 * 平台侧错误。区分「未登录」「令牌过期」「其它」三类：同步/轮询对前两类有专门的
 * 前端契约（固定过期文案），其它错误原样作为可读 message 返回。
 */
export class PlatformError extends Error {
  readonly kind: "not_logged_in" | "auth_expired" | "message";

  constructor(kind: "not_logged_in" | "auth_expired" | "message", message: string) {
    super(message);
    this.name = "PlatformError";
    this.kind = kind;
  }

  static notLoggedIn(): PlatformError {
    return new PlatformError("not_logged_in", NOT_LOGGED_IN_MESSAGE);
  }

  static authExpired(): PlatformError {
    return new PlatformError("auth_expired", LOGIN_EXPIRED_MESSAGE);
  }

  static message(message: string): PlatformError {
    return new PlatformError("message", message);
  }

  /** 登录态问题（需要用户重新授权）。 */
  get isLoginIssue(): boolean {
    return this.kind !== "message";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 命令边界：任何内部错误都折叠成 (400, command_failed, 可读 message)。 */
function commandError(error: unknown): CommandError {
  if (error instanceof CommandError) return error;
  if (error instanceof PlatformError) return CommandError.badRequest(error.message);
  return CommandError.badRequest(errorText(error));
}

// ─── 小型 JSON / HTTP 工具 ──────────────────────────────────────────────────

function isPlainObject(value: unknown): value is JsonRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasField(record: JsonRow, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function encodeQuery(value: string): string {
  return encodeURIComponent(value);
}

/** Rust `error_suffix`：空 body 不加后缀，否则附前 200 个字符。 */
function errorSuffix(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "") return "";
  return `: ${[...trimmed].slice(0, 200).join("")}`;
}

interface HttpResponseText {
  status: number;
  body: string;
}

async function requestText(
  requestLabel: string,
  readLabel: string,
  url: string,
  init: RequestInit,
): Promise<HttpResponseText> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (error) {
    throw PlatformError.message(`${requestLabel}失败: ${errorText(error)}`);
  }
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw PlatformError.message(`${readLabel}失败: ${errorText(error)}`);
  }
  return { status: response.status, body };
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

// ─── 账号 / 凭据 ────────────────────────────────────────────────────────────

interface PlatformStorage {
  listChannelAccounts(): JsonRow[];
  saveBalanceSnapshot(snapshot: JsonRow): void;
}

function storageOf(ctx: WebContext): PlatformStorage {
  return ctx.storage as unknown as PlatformStorage;
}

function accountOrError(ctx: WebContext, accountId: string): JsonRow {
  const account = storageOf(ctx)
    .listChannelAccounts()
    .find((row) => isPlainObject(row) && row.id === accountId);
  if (account === undefined) throw PlatformError.message("账号不存在");
  if (account.channel_id !== QWEN_CHANNEL_ID) {
    throw PlatformError.message("该账号不属于千问渠道");
  }
  return account;
}

/**
 * 千问账号的两种资源模式需要不同的平台接口：
 * - API 按量付费：余额 + 各模型免费额度（BssOpenAPI）；
 * - Token Plan 订阅：订阅状态 + 额度窗口 + 重置券（cs-data）。
 */
export function platformAccountKind(account: JsonRow): PlatformAccountKind | null {
  if (account.channel_id !== QWEN_CHANNEL_ID) return null;
  const mode = account.resource_mode;
  if (mode === QWEN_TOKEN_PLAN_MODE) return "token_plan";
  if (mode === null || mode === undefined || mode === QWEN_PAY_AS_YOU_GO_MODE) return "pay_as_you_go";
  return null;
}

function supportsPlatformSync(account: JsonRow): boolean {
  return platformAccountKind(account) !== null;
}

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function validateAccountId(accountId: string): void {
  // 只允许安全字符，避免路径穿越到凭据目录之外。
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw PlatformError.message(`非法账号 id: ${accountId}`);
  }
}

function platformDir(catalogDir: string): string {
  return path.join(catalogDir, CREDENTIALS_DIR);
}

/** 共享凭据存储路径：所有 Qwen 账号共用一份平台令牌表。 */
export function credentialStorePath(catalogDir: string): string {
  return path.join(platformDir(catalogDir), CREDENTIALS_FILE);
}

function restrictPermissions(filePath: string): void {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // 非 POSIX 平台或权限受限时尽力而为；不因此阻断凭据读写。
  }
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 共享凭据存储：
 * - `platforms`：按千问**平台账号**保存的访问令牌（同一平台账号只登录一次）；
 * - `accounts`：Flowlet 账号 id → 平台账号键的绑定。
 */
export interface CredentialStore {
  version: 1;
  platforms: Record<string, PlatformCredentials>;
  accounts: Record<string, string>;
}

function emptyCredentialStore(): CredentialStore {
  return { version: 1, platforms: {}, accounts: {} };
}

/** 平台账号键：`aliyunId ?? email ?? "default"`（全部 trim，空串视为缺失）。 */
export function platformKeyOf(
  aliyunId: string | null | undefined,
  email: string | null | undefined,
): string {
  return optionalText(aliyunId) ?? optionalText(email) ?? "default";
}

function parseStoredCredentials(value: unknown): PlatformCredentials | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.accessToken !== "string" || value.accessToken.trim() === "") return null;
  if (typeof value.updatedAt !== "string") return null;
  for (const key of ["expiresAt", "aliyunId", "email"] as const) {
    const field = value[key];
    if (field !== undefined && field !== null && typeof field !== "string") return null;
  }
  return {
    accessToken: value.accessToken,
    expiresAt: optionalText(value.expiresAt),
    aliyunId: optionalText(value.aliyunId),
    email: optionalText(value.email),
    updatedAt: value.updatedAt,
  };
}

function compareUpdatedAt(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isNaN(leftMs) && !Number.isNaN(rightMs)) return leftMs - rightMs;
  return left.localeCompare(right);
}

/** 读取 `credentials.json`（不触发迁移）。损坏时按空存储处理，不影响登录流程。 */
function readCredentialStoreFile(catalogDir: string): CredentialStore {
  const filePath = credentialStorePath(catalogDir);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCredentialStore();
    throw PlatformError.message(`读取千问平台凭据失败: ${errorText(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`千问平台凭据文件解析失败，按未登录处理：${errorText(error)}`);
    return emptyCredentialStore();
  }
  if (
    !isPlainObject(parsed) ||
    (parsed.version !== undefined && parsed.version !== 1)
  ) {
    console.warn("千问平台凭据文件解析失败，按未登录处理：version 或结构不符");
    return emptyCredentialStore();
  }
  const store = emptyCredentialStore();
  const platforms = isPlainObject(parsed.platforms) ? parsed.platforms : {};
  for (const [key, value] of Object.entries(platforms)) {
    const platformKey = key.trim();
    if (platformKey === "") continue;
    const credentials = parseStoredCredentials(value);
    if (credentials === null) {
      console.warn(`千问平台凭据文件跳过无效平台令牌：${platformKey}`);
      continue;
    }
    store.platforms[platformKey] = credentials;
  }
  const accounts = isPlainObject(parsed.accounts) ? parsed.accounts : {};
  for (const [accountId, platformKey] of Object.entries(accounts)) {
    if (typeof platformKey !== "string") continue;
    if (!ACCOUNT_ID_PATTERN.test(accountId)) continue;
    store.accounts[accountId] = platformKey;
  }
  return store;
}

/** 先写 tmp、收紧权限、再 rename，避免半个凭据文件被读到。 */
export function saveCredentialStore(catalogDir: string, store: CredentialStore): void {
  const filePath = credentialStorePath(catalogDir);
  const dir = path.dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw PlatformError.message(`创建千问平台凭据目录失败: ${errorText(error)}`);
  }
  const body = JSON.stringify(store, null, 2);
  const temp = `${filePath}.tmp`;
  try {
    writeFileSync(temp, body);
  } catch (error) {
    throw PlatformError.message(`写入千问平台凭据失败: ${errorText(error)}`);
  }
  restrictPermissions(temp);
  try {
    renameSync(temp, filePath);
  } catch (error) {
    throw PlatformError.message(`保存千问平台凭据失败: ${errorText(error)}`);
  }
}

function removeLegacyFile(filePath: string): void {
  try {
    rmSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn(`千问平台旧凭据文件删除失败（忽略）：${errorText(error)}`);
  }
}

/** 旧版单账号凭据文件：`qwen-platform/<accountId>.json`（与 `client-id` 同级）。 */
function legacyCredentialFiles(catalogDir: string): { accountId: string; filePath: string }[] {
  const dir = platformDir(catalogDir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw PlatformError.message(`读取千问平台凭据目录失败: ${errorText(error)}`);
  }
  const files: { accountId: string; filePath: string }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json") || entry.name === CREDENTIALS_FILE) continue;
    const accountId = entry.name.slice(0, -".json".length);
    if (!ACCOUNT_ID_PATTERN.test(accountId)) continue;
    files.push({ accountId, filePath: path.join(dir, entry.name) });
  }
  return files.sort((left, right) => left.accountId.localeCompare(right.accountId));
}

/**
 * 旧版按账号凭据惰性迁移到共享存储：导入平台令牌、绑定账号，随后删除旧文件。
 * 无法识别的旧文件保留原样（不静默丢弃用户数据），已有绑定的旧文件视为残留直接清理。
 */
export function migrateLegacyCredentials(catalogDir: string): CredentialStore {
  const store = readCredentialStoreFile(catalogDir);
  let changed = false;
  for (const legacy of legacyCredentialFiles(catalogDir)) {
    if (store.accounts[legacy.accountId] !== undefined) {
      removeLegacyFile(legacy.filePath);
      changed = true;
      continue;
    }
    let credentials: PlatformCredentials | null = null;
    try {
      credentials = parseStoredCredentials(JSON.parse(readFileSync(legacy.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      console.warn(`千问平台旧凭据迁移失败，跳过 ${legacy.accountId}：${errorText(error)}`);
    }
    if (credentials === null) continue;
    const platformKey = platformKeyOf(credentials.aliyunId, credentials.email);
    const existing = store.platforms[platformKey];
    // 同一平台账号出现多份旧文件时以 updatedAt 最新的为准。
    if (existing === undefined || compareUpdatedAt(credentials.updatedAt, existing.updatedAt) >= 0) {
      store.platforms[platformKey] = credentials;
    }
    store.accounts[legacy.accountId] = platformKey;
    removeLegacyFile(legacy.filePath);
    changed = true;
  }
  if (changed) saveCredentialStore(catalogDir, store);
  return store;
}

/** 读取共享凭据存储；顺带完成旧格式惰性迁移（status/sync/登录入口都走这里）。 */
export function loadCredentialStore(catalogDir: string): CredentialStore {
  return migrateLegacyCredentials(catalogDir);
}

function pruneUnreferencedPlatform(store: CredentialStore, platformKey: string): void {
  for (const bound of Object.values(store.accounts)) {
    if (bound === platformKey) return;
  }
  delete store.platforms[platformKey];
}

/** 登录完成：写入/覆盖平台令牌，并把当前 Flowlet 账号绑定到该平台账号。 */
export function saveCredentials(
  catalogDir: string,
  accountId: string,
  credentials: PlatformCredentials,
): void {
  validateAccountId(accountId);
  const store = loadCredentialStore(catalogDir);
  const platformKey = platformKeyOf(credentials.aliyunId, credentials.email);
  const previousKey = store.accounts[accountId];
  store.platforms[platformKey] = credentials;
  store.accounts[accountId] = platformKey;
  if (previousKey !== undefined && previousKey !== platformKey) {
    pruneUnreferencedPlatform(store, previousKey);
  }
  saveCredentialStore(catalogDir, store);
}

/** 该账号**已绑定**的平台令牌（不做过期/跨平台回退；回退见 `resolveAccountCredentials`）。 */
export function loadCredentials(
  catalogDir: string,
  accountId: string,
): PlatformCredentials | null {
  validateAccountId(accountId);
  const store = loadCredentialStore(catalogDir);
  const platformKey = store.accounts[accountId];
  if (platformKey === undefined) return null;
  return store.platforms[platformKey] ?? null;
}

/**
 * 登出当前 Flowlet 账号：删除它的绑定；平台令牌只在没有任何账号继续引用时删除。
 * 返回是否真的解绑了账号。
 */
export function removeCredentials(catalogDir: string, accountId: string): boolean {
  validateAccountId(accountId);
  const store = loadCredentialStore(catalogDir);
  const platformKey = store.accounts[accountId];
  if (platformKey === undefined) return false;
  delete store.accounts[accountId];
  pruneUnreferencedPlatform(store, platformKey);
  saveCredentialStore(catalogDir, store);
  return true;
}

/**
 * 设备 id：device flow 的 `client_id`。与 CLI 一样持久化在数据目录，保证同一台
 * 设备重复登录时服务端看到同一个客户端。
 */
export function loadOrCreateClientId(catalogDir: string): string {
  const dir = platformDir(catalogDir);
  const filePath = path.join(dir, CLIENT_ID_FILE);
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (raw !== "") return raw;
  } catch {
    // 不存在/不可读：按未初始化处理，下面重新生成。
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw PlatformError.message(`创建千问平台目录失败: ${errorText(error)}`);
  }
  const clientId = randomUUID();
  try {
    writeFileSync(filePath, `${clientId}\n`);
  } catch (error) {
    throw PlatformError.message(`写入千问平台设备 id 失败: ${errorText(error)}`);
  }
  restrictPermissions(filePath);
  return clientId;
}

/** 服务端 `ExpireTime` 可能是 RFC3339，也可能是纯数字秒/毫秒时间戳。 */
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseExpireTime(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isSafeInteger(numeric)) return null;
    // 毫秒时间戳（>= 1e12）与秒级时间戳都接受。
    return numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  if (!RFC3339_PATTERN.test(trimmed)) return null;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/** 解析不出过期时间时按「未过期」处理（真实失效由网关 401 兜底）。 */
export function isCredentialsExpired(
  credentials: PlatformCredentials,
  now: number = Date.now(),
): boolean {
  if (credentials.expiresAt === null) return false;
  const expireAt = parseExpireTime(credentials.expiresAt);
  return expireAt !== null && expireAt <= now;
}

function latestValidPlatform(
  store: CredentialStore,
): { platformKey: string; credentials: PlatformCredentials } | null {
  let best: { platformKey: string; credentials: PlatformCredentials } | null = null;
  for (const [platformKey, credentials] of Object.entries(store.platforms)) {
    if (isCredentialsExpired(credentials)) continue;
    if (best === null || compareUpdatedAt(credentials.updatedAt, best.credentials.updatedAt) > 0) {
      best = { platformKey, credentials };
    }
  }
  return best;
}

/**
 * 解析账号当前可用的共享平台令牌：
 * 1) 已绑定且未过期 → 直接用；
 * 2) 否则取 `platforms` 里 `updatedAt` 最新且未过期的令牌，并重新绑定到当前账号
 *    （这就是「同一平台账号只需登录一次」的实现）；
 * 3) 只剩过期令牌 → `expired`（status 用它展示过期身份，sync 报登录过期）；
 * 4) 完全没有可用令牌 → `missing`。
 */
export type CredentialResolution =
  | {
      state: "ok";
      platformKey: string;
      credentials: PlatformCredentials;
      /** 是否因为共享回退而改写了账号绑定。 */
      rebound: boolean;
    }
  | { state: "expired"; platformKey: string; credentials: PlatformCredentials }
  | { state: "missing" };

export function resolveAccountCredentials(
  catalogDir: string,
  accountId: string,
): CredentialResolution {
  validateAccountId(accountId);
  const store = loadCredentialStore(catalogDir);
  const boundKey = store.accounts[accountId];
  const bound = boundKey === undefined ? undefined : store.platforms[boundKey];
  if (bound !== undefined && !isCredentialsExpired(bound)) {
    return { state: "ok", platformKey: boundKey!, credentials: bound, rebound: false };
  }
  const fallback = latestValidPlatform(store);
  if (fallback !== null) {
    const rebound = boundKey !== fallback.platformKey;
    if (rebound) {
      store.accounts[accountId] = fallback.platformKey;
      saveCredentialStore(catalogDir, store);
    }
    return {
      state: "ok",
      platformKey: fallback.platformKey,
      credentials: fallback.credentials,
      rebound,
    };
  }
  if (bound !== undefined) {
    return { state: "expired", platformKey: boundKey!, credentials: bound };
  }
  return { state: "missing" };
}

// ─── PKCE / device flow ─────────────────────────────────────────────────────

const base64url = (buffer: Buffer): string => buffer.toString("base64url");

export function generateCodeVerifier(): string {
  // RFC 7636：43–128 个 base64url 字符。32 字节随机量恰好编码成 43 字符。
  return base64url(randomBytes(32));
}

export function codeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "utf8").digest());
}

interface PendingLogin {
  clientId: string;
  codeVerifier: string;
  deviceToken: string;
  expiresAt: number;
}

/** 进程内 pending device flow（Rust 用 `Mutex<HashMap>`，语义相同）。 */
const pendingLogins = new Map<string, PendingLogin>();

export interface DeviceCodeData {
  token: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

function parseJsonObject(body: string, label: string): JsonRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw PlatformError.message(`${label}: ${errorText(error)}`);
  }
  if (!isPlainObject(parsed)) {
    throw PlatformError.message(`${label}: invalid type: sequence, expected a map`);
  }
  return parsed;
}

function envelopeField(record: JsonRow, name: string): unknown {
  return hasField(record, name) ? record[name] : record[name.charAt(0).toUpperCase() + name.slice(1)];
}

/** device-code 响应信封 `{Success, Data:{Token, VerificationUrl, ExpiresIn, Interval}}`。 */
export function parseDeviceCodeBody(body: string): DeviceCodeData {
  const root = parseJsonObject(body, "解析千问登录响应失败");
  if (envelopeField(root, "success") !== true) {
    const message = envelopeField(root, "message");
    throw PlatformError.message(
      typeof message === "string" && message.trim() !== ""
        ? message
        : "千问平台拒绝发起登录",
    );
  }
  const rawData = envelopeField(root, "data");
  if (!isPlainObject(rawData)) throw PlatformError.message("千问登录响应缺少 Data");
  const tokenValue = rawData.Token ?? rawData.token;
  const verificationUrlValue = rawData.VerificationUrl ?? rawData.verificationUrl;
  if (typeof tokenValue !== "string" || typeof verificationUrlValue !== "string") {
    throw PlatformError.message("解析千问登录响应失败: missing field `Token` 或 `VerificationUrl`");
  }
  if (tokenValue.trim() === "" || verificationUrlValue.trim() === "") {
    throw PlatformError.message("千问登录响应缺少 Token 或 VerificationUrl");
  }
  const expiresInValue = rawData.ExpiresIn ?? rawData.expiresIn;
  const intervalValue = rawData.Interval ?? rawData.interval;
  return {
    token: tokenValue,
    verificationUrl: verificationUrlValue,
    expiresIn: typeof expiresInValue === "number" && Number.isFinite(expiresInValue) ? Math.trunc(expiresInValue) : 0,
    interval: typeof intervalValue === "number" && Number.isFinite(intervalValue) ? Math.trunc(intervalValue) : 0,
  };
}

export type TokenPollOutcome =
  | { status: "pending" }
  | { status: "slow_down" }
  | {
      status: "complete";
      accessToken: string;
      expiresAt: string | null;
      aliyunId: string | null;
      email: string | null;
    }
  | { status: "expired" }
  | { status: "denied" };

/** 线上实测 `User.Id` 是数字，CLI 也会把 aliyunId 放在数字/字符串两种形态里。 */
function valueText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (value === null || value === undefined) return null;
  const text = JSON.stringify(value);
  return text === undefined || text === "null" ? null : text;
}

function credentialValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  const text = valueText(value);
  return text === null ? null : text;
}

/** token 轮询响应解析：`{Success, Data:{Status, Credentials:{AccessToken, ExpireTime, User}}}`。 */
export function parseTokenBody(body: string): TokenPollOutcome {
  const root = parseJsonObject(body, "解析千问登录结果失败");
  if (envelopeField(root, "success") !== true) {
    const message = envelopeField(root, "message");
    throw PlatformError.message(
      typeof message === "string" && message.trim() !== "" ? message : "千问登录状态查询失败",
    );
  }
  const rawData = envelopeField(root, "data");
  if (!isPlainObject(rawData)) throw PlatformError.message("千问登录结果缺少 Data");
  const statusValue = rawData.Status ?? rawData.status;
  const status = (typeof statusValue === "string" ? statusValue : "authorization_pending")
    .trim()
    .toLowerCase();
  switch (status) {
    case "complete":
    case "success": {
      const credentialsValue = rawData.Credentials ?? rawData.credentials;
      if (!isPlainObject(credentialsValue)) {
        throw PlatformError.message("千问登录完成但未返回访问令牌");
      }
      const accessTokenValue = credentialsValue.AccessToken ?? credentialsValue.access_token;
      const accessToken = typeof accessTokenValue === "string" ? accessTokenValue.trim() : "";
      if (accessToken === "") throw PlatformError.message("千问登录完成但访问令牌为空");
      const expireTimeValue = credentialsValue.ExpireTime ?? credentialsValue.expire_time;
      const userValue = credentialsValue.User ?? credentialsValue.user;
      const user = isPlainObject(userValue) ? userValue : {};
      const aliyunIdValue = user.AliyunId ?? user.aliyunId;
      const idValue = user.Id ?? user.id;
      return {
        status: "complete",
        accessToken,
        expiresAt: credentialValue(expireTimeValue),
        aliyunId: valueText(aliyunIdValue) ?? valueText(idValue),
        email: valueText(user.Email ?? user.email),
      };
    }
    case "slow_down":
      return { status: "slow_down" };
    case "expired_token":
    case "expired":
      return { status: "expired" };
    case "access_denied":
    case "denied":
      return { status: "denied" };
    default:
      return { status: "pending" };
  }
}

/** device flow 的失败是 HTTP 400 + 文本原因，CLI 也是按文本匹配的。 */
export function classifyDeviceError(status: number, body: string): PlatformError {
  const lower = body.toLowerCase();
  if (lower.includes("expired")) return PlatformError.authExpired();
  if (lower.includes("access_denied") || lower.includes("denied")) {
    return PlatformError.message("用户拒绝了千问平台授权");
  }
  if (lower.includes("slow_down")) {
    return PlatformError.message("登录轮询过快，请稍后重试（千问平台要求放慢轮询）");
  }
  return PlatformError.message(`千问登录服务返回 HTTP ${status}${errorSuffix(body)}`);
}

const emptyLoginPoll = (status: LoginPollStatus): LoginPoll => ({
  status,
  aliyunId: null,
  email: null,
});

// ─── 登录命令 ───────────────────────────────────────────────────────────────

export async function startLogin(ctx: WebContext, accountId: string): Promise<LoginChallenge> {
  try {
    const account = accountOrError(ctx, accountId);
    if (!supportsPlatformSync(account)) {
      throw PlatformError.message("该账号的资源模式不支持千问平台登录");
    }
    // 登录入口同样触发旧凭据惰性迁移：用户可能先点了登录才看状态。
    loadCredentialStore(ctx.catalogDir);
    const clientId = loadOrCreateClientId(ctx.catalogDir);
    const verifier = generateCodeVerifier();
    const challenge = codeChallenge(verifier);
    const url =
      `${AUTH_BASE}/cli/device/code?client_id=${encodeQuery(clientId)}` +
      `&code_challenge=${encodeQuery(challenge)}&code_challenge_method=S256`;
    const { status, body } = await requestText("请求千问登录服务", "读取千问登录响应", url, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    if (!isSuccessStatus(status)) throw classifyDeviceError(status, body);
    const data = parseDeviceCodeBody(body);
    const expiresIn = data.expiresIn === 0 ? 300 : data.expiresIn;
    const interval = data.interval === 0 ? 2 : data.interval;
    pendingLogins.set(accountId, {
      clientId,
      codeVerifier: verifier,
      deviceToken: data.token,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    return {
      verificationUrl: data.verificationUrl,
      expiresInSeconds: expiresIn,
      intervalSeconds: interval,
    };
  } catch (error) {
    throw commandError(error);
  }
}

export async function pollLogin(ctx: WebContext, accountId: string): Promise<LoginPoll> {
  try {
    accountOrError(ctx, accountId);
    const pending = pendingLogins.get(accountId);
    if (pending === undefined) throw PlatformError.message("请先发起千问平台登录");
    if (pending.expiresAt <= Date.now()) {
      pendingLogins.delete(accountId);
      return emptyLoginPoll("expired");
    }
    const url =
      `${AUTH_BASE}/cli/device/token?client_id=${encodeQuery(pending.clientId)}` +
      `&token=${encodeQuery(pending.deviceToken)}` +
      `&code_verifier=${encodeQuery(pending.codeVerifier)}`;
    const { status, body } = await requestText("请求千问登录服务", "读取千问登录响应", url, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    if (!isSuccessStatus(status)) {
      // RFC 8628 的失败是 HTTP 400 + 文本原因。任务契约要求这三种原因分别映射为
      // 终态/继续轮询状态，而不是抛错（前端收到 slow_down 会加大轮询间隔）。
      const lower = body.toLowerCase();
      if (lower.includes("expired")) {
        pendingLogins.delete(accountId);
        return emptyLoginPoll("expired");
      }
      if (lower.includes("access_denied") || lower.includes("denied")) {
        pendingLogins.delete(accountId);
        return emptyLoginPoll("denied");
      }
      if (lower.includes("slow_down")) {
        return emptyLoginPoll("slow_down");
      }
      throw classifyDeviceError(status, body);
    }
    const outcome = parseTokenBody(body);
    switch (outcome.status) {
      case "pending":
      case "slow_down":
        return emptyLoginPoll(outcome.status);
      case "denied":
        pendingLogins.delete(accountId);
        return emptyLoginPoll("denied");
      case "expired":
        pendingLogins.delete(accountId);
        return emptyLoginPoll("expired");
      case "complete": {
        let aliyunId = outcome.aliyunId;
        let email = outcome.email;
        if (aliyunId === null || email === null) {
          const identity = await fetchAccountIdentity(outcome.accessToken);
          if (identity !== null) {
            aliyunId = aliyunId ?? identity.aliyunId;
            email = email ?? identity.email;
          }
        }
        saveCredentials(ctx.catalogDir, accountId, {
          accessToken: outcome.accessToken,
          expiresAt: outcome.expiresAt,
          aliyunId,
          email,
          updatedAt: new Date().toISOString(),
        });
        pendingLogins.delete(accountId);
        return { status: "complete", aliyunId, email };
      }
    }
  } catch (error) {
    throw commandError(error);
  }
}

/**
 * 平台账号展示身份：device flow 只返回数字 `User.Id`，`/api/account/info.json`
 * 才有掩码后的 `aliyunId`（如 `nich*****@outlook.com`）。失败忽略，仅缺展示身份。
 */
async function fetchAccountIdentity(
  accessToken: string,
): Promise<{ aliyunId: string | null; email: string | null } | null> {
  try {
    const { status, body } = await requestText(
      "请求千问平台",
      "读取千问平台响应",
      `${API_BASE}/api/account/info.json`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      },
    );
    if (!isSuccessStatus(status)) return null;
    const data = parseGatewayBody(body);
    if (!isPlainObject(data)) return null;
    const aliyunId = typeof data.aliyunId === "string" ? data.aliyunId.trim() : "";
    const displayId = aliyunId === "" ? null : aliyunId;
    return {
      aliyunId: displayId,
      email: displayId !== null && displayId.includes("@") ? displayId : null,
    };
  } catch {
    return null;
  }
}

export function status(ctx: WebContext, accountId: string): PlatformStatus {
  try {
    accountOrError(ctx, accountId);
    const resolution = resolveAccountCredentials(ctx.catalogDir, accountId);
    if (resolution.state !== "missing") {
      // 过期时仍返回已绑定令牌的身份/到期时间，供 UI 展示过期身份。
      return {
        accountId,
        loggedIn: resolution.state === "ok",
        aliyunId: resolution.credentials.aliyunId,
        email: resolution.credentials.email,
        expiresAt: resolution.credentials.expiresAt,
      };
    }
    return { accountId, loggedIn: false, aliyunId: null, email: null, expiresAt: null };
  } catch (error) {
    throw commandError(error);
  }
}

export function logout(ctx: WebContext, accountId: string): void {
  try {
    accountOrError(ctx, accountId);
    removeCredentials(ctx.catalogDir, accountId);
    pendingLogins.delete(accountId);
  } catch (error) {
    throw commandError(error);
  }
}

// ─── 网关信封 / 调用 ────────────────────────────────────────────────────────

function stringifyParams(params: JsonRow): JsonRow {
  const result: JsonRow = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      result[key] = value;
    } else {
      const text = JSON.stringify(value);
      result[key] = text === undefined ? "null" : text;
    }
  }
  return result;
}

function codeText(code: unknown): string {
  if (typeof code === "string") return code;
  if (typeof code === "number") return String(code);
  if (code === null || code === undefined) return "null";
  const text = JSON.stringify(code);
  return text === undefined ? "null" : text;
}

/** 解析 `{code, message, data}` 信封；`code` 为数字或字符串 "200" 都接受。 */
export function parseGatewayBody(body: string): unknown {
  const root = parseJsonObject(body, "解析千问平台响应失败");
  const code = hasField(root, "code") ? codeText(root.code) : "null";
  if (code === "200") {
    return hasField(root, "data") ? root.data : null;
  }
  const message = typeof root.message === "string" ? root.message : `千问平台返回 code=${code}`;
  const lower = `${code} ${message}`.toLowerCase();
  if (
    lower.includes("401") ||
    lower.includes("unauthor") ||
    lower.includes("notlogined") ||
    lower.includes("not_login") ||
    (lower.includes("token") && lower.includes("expire"))
  ) {
    throw PlatformError.authExpired();
  }
  throw PlatformError.message(message);
}

async function gatewayCallWith(
  accessToken: string,
  product: string,
  action: string,
  version: string | null,
  params: JsonRow,
): Promise<unknown> {
  const payload: JsonRow = {
    product,
    action,
    region: REGION,
    params: stringifyParams(params),
  };
  if (version !== null) payload.version = version;
  const { status, body } = await requestText(
    "请求千问平台",
    "读取千问平台响应",
    `${API_BASE}/data/v2/api.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  if (status === 401 || status === 403) throw PlatformError.authExpired();
  if (!isSuccessStatus(status)) {
    throw PlatformError.message(`千问平台返回 HTTP ${status}${errorSuffix(body)}`);
  }
  return parseGatewayBody(body);
}

function gatewayCall(accessToken: string, action: string, params: JsonRow): Promise<unknown> {
  return gatewayCallWith(accessToken, BSS_PRODUCT, action, null, params);
}

// ─── cs-data（Token Plan） ──────────────────────────────────────────────────

export function csDataRequest(api: string, data: JsonRow): { url: string; form: string } {
  const payload: JsonRow = {
    ...data,
    cornerstoneParam: {
      protocol: "V2",
      console: "ONE_CONSOLE",
      productCode: "p_efm",
      switchUserType: 3,
      consoleSite: "QIANWENAI",
    },
  };
  const envelope = { Api: api, V: "1.0", Data: payload };
  const form = `params=${encodeQuery(JSON.stringify(envelope))}&region=${encodeQuery(REGION)}`;
  const url =
    `${CS_DATA_BASE}/cli/api.json?action=BroadScopeAspnGateway` +
    `&product=sfm_bailian&api=${encodeQuery(api)}`;
  return { url, form };
}

function classifyCsDataFailure(code: string, message: string): PlatformError {
  const lower = `${code} ${message}`.toLowerCase();
  if (
    lower.includes("notlogined") ||
    lower.includes("not_login") ||
    lower.includes("not logged in") ||
    lower.includes("unauthor") ||
    lower.includes("401") ||
    lower.includes("403") ||
    (lower.includes("token") && lower.includes("expire"))
  ) {
    return PlatformError.authExpired();
  }
  return PlatformError.message(
    message.trim() === "" ? `Token Plan 接口返回 ${code}` : `${message} (${code})`,
  );
}

/**
 * cs-data 业务信封：`{code:"200", successResponse, data:{DataV2:{ret:["SUCCESS::"], data:{data:<业务>}}}}`。
 * 返回完整响应对象，因为它会被原样写入 bundle 槽位（前端沿 `data.DataV2.data.data` 解析）。
 */
export function validateCsDataBody(body: string): JsonRow {
  const root = parseJsonObject(body, "解析 Token Plan 响应失败");
  const code = hasField(root, "code") ? codeText(root.code) : "";
  if (code !== "200") {
    const message =
      typeof root.message === "string" ? root.message : "Token Plan 接口未确认成功";
    throw classifyCsDataFailure(code, message);
  }
  const data = isPlainObject(root.data) ? root.data : {};
  if (hasField(data, "success") && data.success === false) {
    const errorCode =
      typeof data.errorCode === "string" && data.errorCode.trim() !== ""
        ? data.errorCode
        : "TokenPlanGatewayError";
    throw classifyCsDataFailure(errorCode, errorCode);
  }
  const dataV2 = isPlainObject(data.DataV2) ? data.DataV2 : {};
  const retList = Array.isArray(dataV2.ret) ? dataV2.ret : [];
  const ret = typeof retList[0] === "string" ? retList[0] : "";
  if (!ret.startsWith("SUCCESS")) {
    const separator = ret.indexOf("::");
    const errorCode = separator >= 0 ? ret.slice(0, separator) : ret;
    const message = separator >= 0 ? ret.slice(separator + 2) : "Token Plan 业务返回失败";
    throw classifyCsDataFailure(errorCode, message);
  }
  return root;
}

/** cs-data 信封里真正的业务对象 `data.DataV2.data.data`（前端解析器走同一条路径）。 */
function csDataInnerData(root: JsonRow): JsonRow | null {
  const data = isPlainObject(root.data) ? root.data : null;
  const dataV2 = data !== null && isPlainObject(data.DataV2) ? data.DataV2 : null;
  const envelope = dataV2 !== null && isPlainObject(dataV2.data) ? dataV2.data : null;
  if (envelope === null) return null;
  return isPlainObject(envelope.data) ? envelope.data : null;
}

async function callCsDataApi(
  cliAccessToken: string,
  api: string,
  data: JsonRow,
): Promise<JsonRow> {
  const { url, form } = csDataRequest(api, data);
  const { status, body } = await requestText("请求 Token Plan 接口", "读取 Token Plan 响应", url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cliAccessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form,
  });
  if (status === 401 || status === 403) throw PlatformError.authExpired();
  if (!isSuccessStatus(status)) {
    throw PlatformError.message(`Token Plan 接口返回 HTTP ${status}${errorSuffix(body)}`);
  }
  return validateCsDataBody(body);
}

/** 用 device-flow 访问令牌换 cs-data 需要的派生令牌（CLI 同样先换再用）。 */
async function deriveCliAccessToken(accessToken: string): Promise<string> {
  const data = await gatewayCallWith(
    accessToken,
    CLI_ACCESS_PRODUCT,
    CLI_ACCESS_ACTION,
    CLI_ACCESS_VERSION,
    {},
  );
  const token =
    isPlainObject(data) && typeof data.cliAccessToken === "string"
      ? data.cliAccessToken.trim()
      : "";
  if (token === "") {
    throw PlatformError.message("千问平台未返回 Token Plan 访问令牌");
  }
  return token;
}

/**
 * Token Plan 槽位 bundle：subscription / quota_config / usage 必需，reset_card_list 可选。
 *
 * 返回 `null` 表示「该平台账号没有 Token Plan 订阅」：订阅业务错误、或订阅/额度/用量
 * 业务数据缺失时跳过全部 Token Plan 槽位，不阻断整体同步。鉴权失效仍抛出（整体报登录过期）。
 */
async function fetchTokenPlanBundle(accessToken: string): Promise<JsonRow | null> {
  try {
    return await fetchTokenPlanSlots(accessToken);
  } catch (error) {
    if (error instanceof PlatformError && error.kind === "auth_expired") throw error;
    console.warn(`千问平台同步：Token Plan 数据不可用，跳过该槽位组（${errorText(error)}）`);
    return null;
  }
}

async function fetchTokenPlanSlots(accessToken: string): Promise<JsonRow | null> {
  const cliToken = await deriveCliAccessToken(accessToken);

  let subscription: JsonRow;
  try {
    subscription = await callCsDataApi(cliToken, CS_API_SUBSCRIPTION, {
      commodityCode: TOKEN_PLAN_SOLO_BUY_COMMODITY,
    });
  } catch (error) {
    // 团队/其它套餐形态可能不接受 commodityCode：去掉参数再试一次。
    if (!(error instanceof PlatformError) || error.kind !== "message") throw error;
    subscription = await callCsDataApi(cliToken, CS_API_SUBSCRIPTION, {});
  }

  const quotaConfig = await callCsDataApi(cliToken, CS_API_QUOTA_CONFIG, {});
  const usage = await callCsDataApi(cliToken, CS_API_USAGE, {});

  // 业务信封里没有真正的订阅/额度/用量对象时，前端解析器无法解析，按「无订阅」跳过。
  if (
    csDataInnerData(subscription) === null ||
    csDataInnerData(quotaConfig) === null ||
    csDataInnerData(usage) === null
  ) {
    console.warn("千问平台同步：Token Plan 订阅数据缺失，跳过 Token Plan 槽位");
    return null;
  }

  // 重置券是可选能力：接口不可用时不阻断订阅同步（与控制台抓取一致）。
  let resetCards: JsonRow | null = null;
  try {
    resetCards = await callCsDataApi(cliToken, CS_API_RESET_CARDS, {});
  } catch (error) {
    if (error instanceof PlatformError && error.kind === "auth_expired") throw error;
    console.warn(`千问平台：重置券接口不可用，跳过该槽位（${errorText(error)}）`);
    resetCards = null;
  }

  const bundle: JsonRow = {
    subscription,
    quota_config: quotaConfig,
    usage,
  };
  if (resetCards !== null) bundle.reset_card_list = resetCards;
  return bundle;
}

// ─── 免费额度 / 余额（BssOpenAPI） ──────────────────────────────────────────

async function fetchModelMapping(): Promise<Map<string, string>> {
  const { status, body } = await requestText(
    "请求千问模型映射",
    "读取千问模型映射",
    MODEL_MAPPING_URL,
    { method: "GET" },
  );
  if (!isSuccessStatus(status)) {
    throw PlatformError.message(`千问模型映射返回 HTTP ${status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw PlatformError.message(`解析千问模型映射失败: ${errorText(error)}`);
  }
  if (!isPlainObject(parsed)) {
    throw PlatformError.message("解析千问模型映射失败: invalid type: sequence, expected a map");
  }
  // 公开 CDN 是 model → templateCode，反转成 code → model。
  const inverse = new Map<string, string>();
  for (const [model, templateCode] of Object.entries(parsed)) {
    if (typeof templateCode !== "string") {
      throw PlatformError.message("解析千问模型映射失败: invalid type, expected a string");
    }
    inverse.set(templateCode, model);
  }
  return inverse;
}

async function fetchFreeTierInstances(
  accessToken: string,
  templateCodes: string[],
): Promise<unknown[]> {
  const instances: unknown[] = [];
  for (let page = 1; page <= MAX_FQ_PAGES; page += 1) {
    const params: JsonRow = { PageSize: FQ_PAGE_SIZE, PageNumber: page };
    if (templateCodes.length > 0) params.templateCodes = templateCodes;
    const data = await gatewayCall(accessToken, "DescribeFqInstance", params);
    const pageInstances =
      isPlainObject(data) && Array.isArray(data.Data) ? (data.Data as unknown[]) : [];
    instances.push(...pageInstances);
    if (pageInstances.length < FQ_PAGE_SIZE) break;
  }
  return instances;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 金额/数量字符串化：避免 `1e6` 之类的科学计数法进入展示。 */
function numberText(value: number): string {
  if (Math.abs(value % 1) < Number.EPSILON && Math.abs(value) < 1e15) {
    return value.toFixed(0);
  }
  return String(value);
}

/** `ShowUnit` 的数量级前缀（服务端给英文，历史控制台给中文）。 */
export function unitScale(rawUnit: string): number {
  const lower = rawUnit.toLowerCase();
  if (lower.includes("hundred thousand") || lower.includes("hundredthousand") || rawUnit.includes("十万")) {
    return 100_000;
  }
  // 「百万 / 千万」也含「万」，必须先按数量级更大的单位匹配。
  if (lower.includes("million") || rawUnit.includes("百万")) return 1_000_000;
  if (lower.includes("billion") || rawUnit.includes("亿")) return 100_000_000;
  if (
    lower.includes("ten thousand") ||
    lower.includes("tenthousand") ||
    rawUnit.includes("万")
  ) {
    return 10_000;
  }
  if (lower.includes("thousand") || rawUnit.includes("千")) return 1_000;
  return 1;
}

export function canonicalUnit(rawUnit: string): string | null {
  const lower = rawUnit.toLowerCase();
  if (lower.includes("token") || rawUnit.includes("千")) return "tokens";
  if (lower.includes("word") || lower.includes("char") || rawUnit.includes("字")) return "字";
  if (lower.includes("second") || lower.includes("sec") || rawUnit.includes("秒")) return "秒";
  if (lower.includes("piece") || lower.includes("image") || lower.includes("page") || rawUnit.includes("张")) {
    return "张";
  }
  if (lower.includes("voice") || rawUnit.includes("次")) return "次";
  return null;
}

function capacityUnit(record: JsonRow | null): string {
  if (record === null) return "";
  const value = hasField(record, "ShowUnit")
    ? record.ShowUnit
    : hasField(record, "BaseUnit")
      ? record.BaseUnit
      : undefined;
  return typeof value === "string" ? value : "";
}

/**
 * 容量归一：`BaseValue` 保持基础单位数量，`ShowValue` 用同一基础单位数值字符串，
 * `ShowUnit`/`BaseUnit` 换成前端可识别的单位标签。`BaseValue` 缺失时用
 * `ShowValue × 数量级` 推导。
 */
export function normalizeCapacity(capacity: unknown): JsonRow {
  const record = isPlainObject(capacity) ? capacity : null;
  const rawUnit = capacityUnit(record);
  const showValue = numericValue(record?.ShowValue);
  const baseValue =
    numericValue(record?.BaseValue) ?? (showValue === null ? null : showValue * unitScale(rawUnit));
  const unit = canonicalUnit(rawUnit);

  const normalized: JsonRow = {};
  if (baseValue !== null) {
    normalized.BaseValue = baseValue;
    normalized.ShowValue = numberText(baseValue);
  } else if (showValue !== null) {
    normalized.ShowValue = numberText(showValue);
  }
  if (unit !== null) {
    normalized.ShowUnit = unit;
    normalized.BaseUnit = unit;
  }
  return normalized;
}

/**
 * 免费额度实例 → 控制台抓取同构、且不含账号身份的裁剪结果：
 * - 只保留 Template/Status/InitCapacity/CurrCapacity/周期与结束时间，丢弃账号身份字段；
 * - `Template.Name` 缺失时用公开 model-mapping 反查回填，再缺失退回 `Code`。
 */
export function normalizeFreeTierInstance(
  instance: unknown,
  modelByTemplate: Map<string, string>,
): JsonRow | null {
  if (!isPlainObject(instance)) return null;
  const template = instance.Template;
  if (!isPlainObject(template)) return null;
  const code = typeof template.Code === "string" ? template.Code.trim() : "";
  const rawName = typeof template.Name === "string" ? template.Name.trim() : "";
  const name =
    rawName !== ""
      ? rawName
      : (modelByTemplate.get(code) ?? (code !== "" ? code : null));
  if (name === null) return null;

  const normalized: JsonRow = { Template: { Code: code, Name: name } };
  if (hasField(instance, "Status")) normalized.Status = instance.Status;
  for (const key of ["InitCapacity", "CurrCapacity"] as const) {
    if (hasField(instance, key)) normalized[key] = normalizeCapacity(instance[key]);
  }
  for (const key of ["CurrentCycleStartTime", "CurrentCycleEndTime", "EndTime"] as const) {
    if (hasField(instance, key)) normalized[key] = instance[key];
  }
  return normalized;
}

export function buildSlotBundle(
  instances: unknown[],
  modelByTemplate: Map<string, string>,
  billing: unknown | null,
  settle: unknown | null,
): JsonRow {
  const normalized = instances
    .map((instance) => normalizeFreeTierInstance(instance, modelByTemplate))
    .filter((instance): instance is JsonRow => instance !== null);
  const bundle: JsonRow = {};
  if (billing !== null) bundle.billing_amount = { data: billing };
  bundle.fq_instance = { data: { Data: normalized } };
  if (settle !== null) bundle.settle_bill = { data: settle };
  return bundle;
}

/** `billing_amount` 槽位：原样保留网关返回的账户余额对象（不裁剪字段）。 */
export function billingSlotFromGateway(data: unknown): JsonRow | null {
  if (!isPlainObject(data)) return null;
  if (!hasField(data, "AvailableAmount") || data.AvailableAmount === null) return null;
  return data;
}

/** 北京时区当前账单周期 `YYYYMM`。 */
export function nowBillingCycleYyyymm(now: Date): string {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const year = beijing.getUTCFullYear();
  const month = String(beijing.getUTCMonth() + 1).padStart(2, "0");
  return `${year}${month}`;
}

/**
 * 账户余额：优先 `GetBillingAccountAvailableAmount`（字段更全），失败时退回
 * `GetFundAccountAvailableAmount`（只有可用余额与币种）。
 */
async function fetchBillingData(accessToken: string): Promise<unknown> {
  let data: unknown;
  try {
    data = await gatewayCall(accessToken, "GetBillingAccountAvailableAmount", {});
  } catch (error) {
    if (error instanceof PlatformError && error.kind === "auth_expired") throw error;
    console.warn(`千问平台同步：GetBillingAccountAvailableAmount 不可用，改用 GetFundAccountAvailableAmount（${errorText(error)}）`);
    return gatewayCall(accessToken, "GetFundAccountAvailableAmount", {});
  }
  if (billingSlotFromGateway(data) !== null) return data;
  return gatewayCall(accessToken, "GetFundAccountAvailableAmount", {});
}

/** API 按量付费：余额 + 各模型免费额度 + 当月结算账单。 */
async function fetchPayAsYouGoBundle(
  accessToken: string,
): Promise<{ bundle: JsonRow; balance: number | null; currency: string | null }> {
  // 模型映射是公开 CDN 上的静态 JSON；取不到只影响模型名回填，不阻断同步。
  let modelByTemplate: Map<string, string>;
  try {
    modelByTemplate = await fetchModelMapping();
  } catch (error) {
    console.warn(`千问平台同步：模型映射获取失败，按实例自带名称回填（${errorText(error)}）`);
    modelByTemplate = new Map();
  }
  const templateCodes = [...modelByTemplate.keys()].sort();

  const instances = await fetchFreeTierInstances(accessToken, templateCodes);

  let billingSlot: JsonRow | null;
  try {
    billingSlot = billingSlotFromGateway(await fetchBillingData(accessToken));
  } catch (error) {
    if (error instanceof PlatformError && error.kind === "auth_expired") throw error;
    console.warn(`千问平台同步：账户余额查询失败（${errorText(error)}）`);
    billingSlot = null;
  }

  const month = nowBillingCycleYyyymm(new Date());
  let settleData: unknown | null = null;
  try {
    const data = await gatewayCall(accessToken, "ListSettleBillTotalSummary", {
      StartBillingCycle: month,
      EndBillingCycle: month,
    });
    settleData = isPlainObject(data) ? data : null;
  } catch (error) {
    if (error instanceof PlatformError && error.kind === "auth_expired") throw error;
    console.warn(`千问平台同步：结算账单查询失败（${errorText(error)}）`);
    settleData = null;
  }

  const balance = billingSlot === null ? null : numericValue(billingSlot.AvailableAmount);
  let currency: string | null = null;
  if (billingSlot !== null) {
    for (const key of ["SettleCurrency", "Currency"]) {
      if (typeof billingSlot[key] === "string") {
        currency = billingSlot[key];
        break;
      }
    }
  }

  return {
    bundle: buildSlotBundle(instances, modelByTemplate, billingSlot, settleData),
    balance,
    currency,
  };
}

// ─── 同步命令 ───────────────────────────────────────────────────────────────

export async function syncAccount(ctx: WebContext, accountId: string): Promise<PlatformSyncResult> {
  try {
    const account = accountOrError(ctx, accountId);
    if (platformAccountKind(account) === null) {
      throw PlatformError.message("该账号的资源模式不支持千问平台同步");
    }
    const resolution = resolveAccountCredentials(ctx.catalogDir, accountId);
    if (resolution.state === "missing") throw PlatformError.notLoggedIn();
    if (resolution.state === "expired") throw PlatformError.authExpired();
    const accessToken = resolution.credentials.accessToken;

    // 不再按 resource_mode 二选一：同一个平台令牌同时拉两套数据，合并成一个
    // 与 WebView 抓取同构的 slot bundle：
    // 按量付费 → billing_amount / fq_instance / settle_bill；
    // Token Plan → subscription / quota_config / usage(/ reset_card_list)。
    const payAsYouGo = await fetchPayAsYouGoBundle(accessToken);
    const tokenPlan = await fetchTokenPlanBundle(accessToken);
    const bundle: JsonRow = { ...payAsYouGo.bundle };
    if (tokenPlan !== null) Object.assign(bundle, tokenPlan);
    const { balance, currency } = payAsYouGo;

    const rawScrapedJson = JSON.stringify(bundle);
    const syncedAt = new Date().toISOString();
    const snapshot: JsonRow = {
      id: `balance-${accountId}-${randomUUID()}`,
      account_id: accountId,
      balance,
      currency,
      token_pack_total: null,
      token_pack_used: null,
      token_pack_remaining: null,
      token_pack_expire_at: null,
      token_packs: null,
      raw_scraped_json: rawScrapedJson,
      source: SOURCE,
      synced_at: syncedAt,
      remark: REMARK,
      created_at: syncedAt,
      updated_at: syncedAt,
    };
    try {
      storageOf(ctx).saveBalanceSnapshot(snapshot);
    } catch (error) {
      throw PlatformError.message(`保存余额快照失败: ${errorText(error)}`);
    }

    return { accountId, balance, currency, syncedAt, rawScrapedJson };
  } catch (error) {
    throw commandError(error);
  }
}