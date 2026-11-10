// Antigravity 浏览器 OAuth 与账号级远端额度观测。
// 权威实现：`src-tauri/src/core/antigravity_oauth.rs`。
//
// 安全边界：OAuth client 只从环境变量成对读取（仓库不内置密钥）；凭据按账号邮箱
// 的 SHA-256 命名保存在 `<root>/<hash>.json`（目录 0700、文件 0600，原子写入）；
// 错误消息不回显 URL、OAuth code、请求体或凭据。
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import type { JsonRow } from "../types.ts";
import {
  fraction,
  resetAt,
  string,
  summaryQuotas,
  type AntigravityAccountReport,
  type AntigravityAccountsReport,
  type AntigravityQuota,
} from "./antigravity.ts";
import { httpJson, type AgentProxySettings } from "./http.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const CLOUD_URL = "https://cloudcode-pa.googleapis.com";
const SUMMARY_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const LOGIN_WAIT_MS = 180_000;
const REMOTE_TIMEOUT_MS = 30_000;

export interface OAuthClient {
  client_id: string;
  client_secret: string;
}

interface Credentials {
  client: OAuthClient;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  email: string;
  project: string | null;
}

interface StoredAccount {
  credentials: Credentials;
  snapshot: AntigravityAccountReport;
}

export interface Endpoints {
  token: string;
  userinfo: string;
  cloud: string;
  summary: string;
}

let endpointsOverride: Endpoints | null = null;

/** 覆盖远端端点（测试用本地 fixture 服务；不影响生产默认值）。 */
export function setAntigravityEndpointsForTests(endpoints: Endpoints | null): void {
  endpointsOverride = endpoints;
}

const DEFAULT_ENDPOINTS: Endpoints = {
  token: TOKEN_URL,
  userinfo: USERINFO_URL,
  cloud: CLOUD_URL,
  summary: SUMMARY_URL,
};

class RemoteError extends Error {
  readonly reauthorize: boolean;
  readonly status: number | null;

  constructor(message: string, reauthorize = false, status: number | null = null) {
    super(message);
    this.name = "RemoteError";
    this.reauthorize = reauthorize;
    this.status = status;
  }
}

function isJsonObject(value: unknown): value is JsonRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveClient(): OAuthClient {
  const clientId = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
  const clientSecret = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
  if (
    clientId !== undefined &&
    clientSecret !== undefined &&
    clientId.trim() !== "" &&
    clientSecret.trim() !== ""
  ) {
    return { client_id: clientId, client_secret: clientSecret };
  }
  throw new Error(
    "未配置 Antigravity OAuth 客户端：请成对设置 ANTIGRAVITY_OAUTH_CLIENT_ID 与 ANTIGRAVITY_OAUTH_CLIENT_SECRET（来源与安全说明见 docs/antigravity-account.md）",
  );
}

function remoteErrorFromResponse(status: number, value: unknown): RemoteError {
  const errorCode = isJsonObject(value) && typeof value.error === "string" ? value.error : null;
  if (status === 401 || errorCode === "invalid_grant") {
    return new RemoteError("Antigravity 授权已失效，请重新授权", true, status);
  }
  if (errorCode === "invalid_client") {
    return new RemoteError("Google 拒绝了 OAuth 客户端，请更新 Flowlet 或配置匹配的 OAuth 客户端", false, status);
  }
  if (status === 403) return new RemoteError("此账号无权读取 Antigravity 额度", false, status);
  return new RemoteError(`Antigravity 远端接口返回 HTTP ${status}`, false, status);
}

function stageForUrl(url: string): string {
  const parsed = new URL(url);
  switch (parsed.pathname) {
    case "/token":
      return "Google 令牌交换/续期";
    case "/oauth2/v2/userinfo":
      return "Google 账号身份验证";
    case "/v1internal:loadCodeAssist":
      return "Antigravity 账号信息";
    case "/v1internal:retrieveUserQuotaSummary":
      return "Antigravity 分组额度";
    case "/v1internal:retrieveUserQuota":
      return "Antigravity 模型额度";
    default:
      return "Antigravity 远端接口";
  }
}

interface SendOptions {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  proxy?: AgentProxySettings | null;
}

async function send(url: string, options: SendOptions): Promise<JsonRow> {
  const stage = stageForUrl(url);
  let response;
  try {
    response = await httpJson(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      timeoutMs: REMOTE_TIMEOUT_MS,
      proxy: options.proxy ?? null,
    });
  } catch {
    throw new RemoteError(`${stage}请求失败，请检查网络或上游代理设置后重试`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw remoteErrorFromResponse(response.status, response.value);
  }
  if (!isJsonObject(response.value) || response.value.error !== undefined) {
    throw new RemoteError("Antigravity 远端接口返回了无效数据");
  }
  return response.value;
}

function userAgent(): string {
  const platform =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `antigravity/hub/2.9.1 ${platform}/${arch}`;
}

async function cloudPost(
  url: string,
  token: string,
  body: JsonRow,
  proxy?: AgentProxySettings | null,
): Promise<JsonRow> {
  return send(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": userAgent(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    proxy,
  });
}

function metadata(): JsonRow {
  return { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
}

function projectId(value: unknown): string | null {
  return (
    string(value) ??
    string(get(value, "id")) ??
    string(get(value, "projectId"))
  );
}

function get(value: unknown, key: string): unknown {
  return isJsonObject(value) ? value[key] : undefined;
}

function planName(value: JsonRow): string | null {
  return (
    string(get(get(value, "paidTier"), "name")) ??
    string(get(get(value, "paidTier"), "id")) ??
    string(get(get(value, "planInfo"), "planType")) ??
    string(get(get(value, "currentTier"), "name")) ??
    string(get(get(value, "currentTier"), "id"))
  );
}

function hasMeasuredQuota(quotas: ReadonlyArray<AntigravityQuota>): boolean {
  return quotas.some((quota) => !quota.disabled && quota.remaining_fraction !== null);
}

function verifiedBuckets(value: unknown): AntigravityQuota[] {
  const buckets = get(value, "buckets");
  if (!Array.isArray(buckets)) return [];
  const quotas: AntigravityQuota[] = [];
  for (const bucket of buckets) {
    const id = string(get(bucket, "modelId"));
    if (id === null) continue;
    quotas.push({
      id,
      label: id,
      remaining_fraction: fraction(get(bucket, "remainingFraction")),
      reset_at: resetAt(get(bucket, "resetTime")),
      description: null,
      disabled: false,
    });
  }
  return quotas;
}

async function refreshToken(
  endpoints: Endpoints,
  credentials: Credentials,
  proxy?: AgentProxySettings | null,
): Promise<Credentials> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh_token,
    client_id: credentials.client.client_id,
    client_secret: credentials.client.client_secret,
  });
  const value = await send(endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    proxy,
  });
  const refreshed = applyTokens({ ...credentials }, value);
  // 任何续期都先验证归属，再落盘。
  const email = await userEmail(endpoints, refreshed.access_token, proxy);
  if (email !== credentials.email) {
    throw new RemoteError("授权账号身份不一致，请重新授权", true);
  }
  return refreshed;
}

function applyTokens(credentials: Credentials, value: JsonRow): Credentials {
  const accessToken = string(value.access_token);
  if (accessToken === null) throw new RemoteError("Google 未返回访问令牌");
  const refresh = string(value.refresh_token);
  const expiresIn = value.expires_in;
  if (typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn <= 0) {
    throw new RemoteError("Google 未返回有效的令牌有效期");
  }
  return {
    ...credentials,
    access_token: accessToken,
    refresh_token: refresh ?? credentials.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
  };
}

async function userEmail(
  endpoints: Endpoints,
  token: string,
  proxy?: AgentProxySettings | null,
): Promise<string> {
  const user = await send(endpoints.userinfo, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    proxy,
  });
  if (user.verified_email !== true) throw new RemoteError("Google 账号邮箱尚未验证");
  const email = string(user.email);
  if (email === null) throw new RemoteError("Google 未返回账号身份");
  return email.toLowerCase();
}

async function fetchQuota(
  endpoints: Endpoints,
  credentials: Credentials,
  proxy?: AgentProxySettings | null,
): Promise<{ plan: string | null; quotas: AntigravityQuota[]; source: string; project: string; }> {
  const assist = await cloudPost(
    `${endpoints.cloud}/v1internal:loadCodeAssist`,
    credentials.access_token,
    { metadata: metadata() },
    proxy,
  );
  const ineligible = assist.ineligibleTiers;
  const tosUnsupported =
    Array.isArray(ineligible) &&
    ineligible.some((tier) => get(tier, "reasonCode") === "GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT");
  const currentTier = assist.currentTier;
  const cloudProject = projectId(assist.cloudaicompanionProject);
  if (
    tosUnsupported &&
    (currentTier === undefined || currentTier === null) &&
    credentials.project === null &&
    cloudProject === null
  ) {
    throw new RemoteError("此 OAuth 授权不能读取该账号额度，请重新授权", true);
  }
  credentials.project = cloudProject ?? credentials.project;
  // 额度观测不创建/变更 Google Cloud 账号；需要首次初始化的用户引导去官方客户端。
  const project = credentials.project;
  if (project === null) {
    throw new RemoteError("账号尚未完成 Antigravity 初始化，请先在官方客户端登录一次");
  }
  const body = { project };
  let quotas: AntigravityQuota[] = [];
  try {
    quotas = summaryQuotas(await cloudPost(endpoints.summary, credentials.access_token, body, proxy));
  } catch (error) {
    if (error instanceof RemoteError && error.reauthorize) throw error;
    quotas = [];
  }
  const plan = planName(assist);
  if (hasMeasuredQuota(quotas)) return { plan, quotas, source: "summary", project };
  const buckets = await cloudPost(
    `${endpoints.cloud}/v1internal:retrieveUserQuota`,
    credentials.access_token,
    body,
    proxy,
  );
  quotas = verifiedBuckets(buckets);
  if (!hasMeasuredQuota(quotas)) {
    throw new RemoteError("远端未返回可测量额度，当前只能确认模型可用性");
  }
  // 只有确认存在可测量额度后，才获取模型展示名。
  try {
    const models = await cloudPost(
      `${endpoints.cloud}/v1internal:fetchAvailableModels`,
      credentials.access_token,
      body,
      proxy,
    );
    for (const quota of quotas) {
      const model = get(get(get(models, "models"), quota.id), "displayName") ??
        get(get(get(models, "models"), quota.id), "label");
      const name = string(model);
      if (name !== null) quota.label = name;
    }
  } catch {
    // 展示名获取失败不影响额度结果。
  }
  return { plan, quotas, source: "models", project };
}

export function accountPath(root: string, accountId: string): string {
  return path.join(root, `${createHash("sha256").update(accountId.toLowerCase()).digest("hex")}.json`);
}

function writeAccount(root: string, account: StoredAccount): void {
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch {
    throw new Error("无法创建 Antigravity 授权目录");
  }
  const target = accountPath(root, account.credentials.email);
  const temporary = path.join(root, `.pending-${randomUUID()}.json`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(account), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, target);
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // 清理失败不覆盖主错误。
    }
    throw new Error("无法更新 Antigravity 授权文件");
  }
}

function readAccount(file: string): StoredAccount {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error("无法读取 Antigravity 授权文件");
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Antigravity 授权文件格式无效");
  }
  return parseStoredAccount(value);
}

/** 严格校验托管授权文件结构；任何字段缺失都按「格式无效」拒绝（不静默补默认值）。 */
function parseStoredAccount(value: unknown): StoredAccount {
  if (!isJsonObject(value)) throw new Error("Antigravity 授权文件格式无效");
  const credentials = value.credentials;
  const snapshot = value.snapshot;
  if (!isJsonObject(credentials) || !isJsonObject(snapshot)) {
    throw new Error("Antigravity 授权文件格式无效");
  }
  const client = credentials.client;
  if (
    !isJsonObject(client) ||
    typeof client.client_id !== "string" ||
    typeof client.client_secret !== "string" ||
    typeof credentials.access_token !== "string" ||
    typeof credentials.refresh_token !== "string" ||
    typeof credentials.expires_at !== "number" ||
    typeof credentials.email !== "string"
  ) {
    throw new Error("Antigravity 授权文件格式无效");
  }
  const accountId = snapshot.account_id;
  const quotas = snapshot.quotas;
  if (typeof accountId !== "string" || !Array.isArray(quotas)) {
    throw new Error("Antigravity 授权文件格式无效");
  }
  return {
    credentials: {
      client: { client_id: client.client_id, client_secret: client.client_secret },
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token,
      expires_at: credentials.expires_at,
      email: credentials.email,
      project: typeof credentials.project === "string" ? credentials.project : null,
    },
    snapshot: snapshot as AntigravityAccountReport,
  };
}

function newSnapshot(email: string): AntigravityAccountReport {
  return {
    account_id: email,
    source: "oauth",
    stale: false,
    reauthorization_required: false,
    email,
    plan: null,
    quotas: [],
    quota_source: null,
    updated_at: new Date().toISOString(),
    error: null,
  };
}

async function refreshAccount(
  root: string,
  initial: StoredAccount,
  endpoints: Endpoints,
  proxy?: AgentProxySettings | null,
): Promise<AntigravityAccountReport> {
  let account = initial;
  const work = (async (): Promise<AntigravityAccountReport> => {
    const now = Math.floor(Date.now() / 1000);
    if (account.credentials.expires_at <= now + 60) {
      account = { ...account, credentials: await refreshToken(endpoints, account.credentials, proxy) };
      writeAccount(root, account);
    }
    let result: { plan: string | null; quotas: AntigravityQuota[]; source: string } | null = null;
    try {
      result = await fetchQuota(endpoints, account.credentials, proxy);
    } catch (error) {
      if (error instanceof RemoteError && error.status === 401) {
        account = { ...account, credentials: await refreshToken(endpoints, account.credentials, proxy) };
        writeAccount(root, account);
        result = await fetchQuota(endpoints, account.credentials, proxy);
      } else {
        throw error;
      }
    }
    const snapshot = newSnapshot(account.credentials.email);
    snapshot.plan = result.plan;
    snapshot.quotas = result.quotas;
    snapshot.quota_source = result.source;
    account = { ...account, snapshot };
    writeAccount(root, account);
    return snapshot;
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RemoteError("Antigravity 远端额度查询超时")), 35_000);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    account = {
      ...account,
      snapshot: {
        ...account.snapshot,
        stale: true,
        error: error instanceof Error ? error.message : String(error),
        reauthorization_required: error instanceof RemoteError && error.reauthorize,
      },
    };
    writeAccount(root, account);
    return account.snapshot;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ─── 串行锁（refresh/rotation、授权提交与删除互斥） ─────────────────────────

let storeQueue: Promise<unknown> = Promise.resolve();
let loginBusy = false;

async function withStoreLock<T>(action: () => Promise<T>): Promise<T> {
  const previous = storeQueue;
  let release: () => void = () => undefined;
  storeQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  action: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await action(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function queryAntigravityOauthAccounts(
  root: string,
  proxy?: AgentProxySettings | null,
): Promise<AntigravityAccountsReport> {
  const endpoints = endpointsOverride ?? DEFAULT_ENDPOINTS;
  return await withStoreLock(async () => {
    if (!fs.existsSync(root)) return { accounts: [] };
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      throw new Error("无法读取 Antigravity 授权目录");
    }
    const accounts: StoredAccount[] = [];
    for (const name of entries) {
      const extension = path.extname(name).replace(/^\./u, "");
      const stem = path.basename(name, path.extname(name));
      if (extension !== "json" || stem.length !== 64 || !/^[0-9a-fA-F]+$/u.test(stem)) continue;
      const file = path.join(root, name);
      const account = readAccount(file);
      if (accountPath(root, account.credentials.email) !== file) {
        throw new Error("Antigravity 授权文件身份不一致");
      }
      accounts.push(account);
    }
    if (accounts.length === 0) return { accounts: [] };
    const refreshed = await mapWithConcurrency(accounts, 4, (account) =>
      refreshAccount(root, account, endpoints, proxy),
    );
    refreshed.sort((left, right) => (left.account_id < right.account_id ? -1 : left.account_id > right.account_id ? 1 : 0));
    return { accounts: refreshed };
  });
}

export async function deleteAntigravityAccount(root: string, accountId: string): Promise<void> {
  await withStoreLock(async () => {
    try {
      fs.rmSync(accountPath(root, accountId), { force: true });
    } catch {
      throw new Error("无法移除 Antigravity 授权");
    }
  });
}

function authorizationUrl(clientId: string, redirect: string, state: string, verifier: string): string {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email",
  );
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "select_account consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface AntigravityAuthorizeOptions {
  root: string;
  openUrl: (url: string) => Promise<void>;
  proxy?: AgentProxySettings | null;
  /** 测试注入点：OAuth client 与端点。 */
  client?: OAuthClient;
  endpoints?: Endpoints;
  waitMs?: number;
}

/**
 * Google OAuth：本机回环回调 + PKCE。成功登录后即使额度接口暂时不可用也会保存授权。
 */
export async function authorizeAntigravityAccount(
  options: AntigravityAuthorizeOptions,
): Promise<AntigravityAccountReport> {
  if (loginBusy) throw new Error("Antigravity 授权正在进行，请完成当前浏览器登录");
  loginBusy = true;
  try {
    const client = options.client ?? resolveClient();
    const endpoints = options.endpoints ?? DEFAULT_ENDPOINTS;
    return await authorizeWith(options, client, endpoints);
  } finally {
    loginBusy = false;
  }
}

/** 可注入 client/endpoints 的授权实现（测试用；生产调用 `authorizeAntigravityAccount`）。 */
export async function authorizeAntigravityAccountWith(
  options: AntigravityAuthorizeOptions,
  client: OAuthClient,
  endpoints: Endpoints,
): Promise<AntigravityAccountReport> {
  return await authorizeWith(options, client, endpoints);
}

async function authorizeWith(
  options: AntigravityAuthorizeOptions,
  client: OAuthClient,
  endpoints: Endpoints,
): Promise<AntigravityAccountReport> {
  const { root, openUrl, proxy } = options;
  const waitMs = options.waitMs ?? LOGIN_WAIT_MS;
  const server: HttpServer = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(new Error("无法启动 Google OAuth 本地回调")));
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
    const nonce = `${randomUUID().replace(/-/gu, "")}${randomUUID().replace(/-/gu, "")}`;
    const verifier = `${randomUUID().replace(/-/gu, "")}${randomUUID().replace(/-/gu, "")}`;
    const url = authorizationUrl(client.client_id, redirect, nonce, verifier);

    let deliver: ((result: { code: string } | { error: string }) => void) | null = null;
    const codePromise = new Promise<{ code: string } | { error: string }>((resolve) => {
      deliver = resolve;
    });
    server.on("request", (request, response) => {
      const requestUrl = new URL(request.url ?? "/", redirect);
      if (requestUrl.pathname !== "/oauth/callback") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      if (requestUrl.searchParams.get("state") !== nonce) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Invalid OAuth state. Return to Flowlet to retry.");
        deliver?.({ error: "Google OAuth 状态校验失败，请重新授权" });
        return;
      }
      const error = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");
      if (error !== null) {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("Authorization response received. You can return to Flowlet.");
        deliver?.({ error: "Google 授权已取消或被拒绝" });
        return;
      }
      if (code === null || code === "") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("Authorization response received. You can return to Flowlet.");
        deliver?.({ error: "Google 未返回授权码" });
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization response received. You can return to Flowlet.");
      deliver?.({ code });
    });

    await openUrl(url);
    let waitTimer: NodeJS.Timeout | undefined;
    const received = await Promise.race([
      codePromise,
      new Promise<{ error: string }>((resolve) => {
        waitTimer = setTimeout(() => resolve({ error: "Google 授权等待超时，请重新授权" }), waitMs);
      }),
    ]);
    if (waitTimer !== undefined) clearTimeout(waitTimer);
    if ("error" in received) throw new Error(received.error);

    const tokens = await send(endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: received.code,
        redirect_uri: redirect,
        client_id: client.client_id,
        client_secret: client.client_secret,
        code_verifier: verifier,
      }).toString(),
      proxy,
    });
    let credentials: Credentials = {
      client,
      access_token: "",
      refresh_token: "",
      expires_at: 0,
      email: "",
      project: null,
    };
    credentials = applyTokens(credentials, tokens);
    if (credentials.refresh_token === "") {
      throw new Error("Google 未授予离线访问权限，请重新授权并允许访问");
    }
    credentials.email = await userEmail(endpoints, credentials.access_token, proxy);

    return await withStoreLock(async () => {
      const target = accountPath(root, credentials.email);
      const snapshot = fs.existsSync(target) ? readAccount(target).snapshot : newSnapshot(credentials.email);
      const account: StoredAccount = { snapshot, credentials };
      // 额度接口暂时不可用也先保存成功登录。
      writeAccount(root, account);
      return await refreshAccount(root, account, endpoints, proxy);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
