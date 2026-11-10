// 浏览器授权登录（`flowlet login`）：本机授权存储 + PKCE + loopback 回调。
//
// 契约：.agents/tmp/cli-auth-spec.md §3。CLI token 只由「已登录管理台的浏览器会话」签发，
// 作用域仅 credentials:read（只允许 export_service_credentials）；本模块负责生成 state/PKCE、
// 起 127.0.0.1 loopback、用授权码换 token，并把 token 存到 auth.json（0600、原子写）。
// 任何日志/输出都不得打印明文 token。
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Agent, request } from "undici";

import { defaultDir, restrictDir, writeAtomic } from "./store.ts";

export const AUTH_FILE_NAME = "auth.json";
export const AUTH_FILE_VERSION = 1;
export const DEFAULT_LOGIN_TIMEOUT_SECONDS = 180;
/** 与服务端校验一致：CLI 机器标识最长 120 字符。 */
export const MAX_AUTH_NAME_LENGTH = 120;

const STATE_BYTES = 32;
const VERIFIER_BYTES = 32;
const EXCHANGE_TIMEOUT_MS = 30_000;
const LOOPBACK_ATTEMPTS = 5;

// ─── auth.json 存储 ────────────────────────────────────────────────────────

export interface AuthServerRecord {
  token: string;
  expiresAt: string;
  name: string;
  savedAt: string;
}

interface AuthFile {
  version: number;
  servers: Record<string, AuthServerRecord>;
}

export function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** RFC 7636 S256：base64url(sha256(verifier))。 */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = randomBase64Url(VERIFIER_BYTES);
  return { verifier, challenge: pkceChallenge(verifier) };
}

/**
 * server key 归一：`scheme://host[:port]`，丢弃路径与尾斜杠。
 * 默认端口（http 80 / https 443）由 `URL#host` 归一掉，与浏览器 origin 语义一致。
 */
export function normalizeServer(rawServer: string): string {
  const trimmed = rawServer.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("--server 必须是 http 或 https 地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--server 必须是 http 或 https 地址");
  }
  if (url.hostname === "") throw new Error("--server 缺少主机名");
  return `${url.protocol}//${url.host}`;
}

function normalizeRecord(value: unknown): AuthServerRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.token !== "string" || row.token === "") return null;
  return {
    token: row.token,
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : "",
    name: typeof row.name === "string" ? row.name : "",
    savedAt: typeof row.savedAt === "string" ? row.savedAt : "",
  };
}

/**
 * 本机服务器授权存储：`<FLOWLET_CRED_DIR>/auth.json`（默认
 * `~/.config/flowlet/credentials/auth.json`），与 credentials.env 同目录。
 *
 * 目录 0700、文件 0600、tmp+rename 原子写；只挑选合法记录，单条损坏不影响其它 server。
 */
export class AuthStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  static fromDefaultDir(env: NodeJS.ProcessEnv = process.env): AuthStore {
    return new AuthStore(defaultDir(env));
  }

  authPath(): string {
    return path.join(this.dir, AUTH_FILE_NAME);
  }

  get(server: string): AuthServerRecord | null {
    return this.readFile().servers[normalizeServer(server)] ?? null;
  }

  set(server: string, record: AuthServerRecord): void {
    const file = this.readFile();
    file.servers[normalizeServer(server)] = {
      token: record.token,
      expiresAt: record.expiresAt,
      name: record.name,
      savedAt: record.savedAt,
    };
    this.writeFile(file);
  }

  /** 删除该 server 的本机记录；返回是否真的删掉了。 */
  remove(server: string): boolean {
    const key = normalizeServer(server);
    const file = this.readFile();
    if (!Object.prototype.hasOwnProperty.call(file.servers, key)) return false;
    delete file.servers[key];
    this.writeFile(file);
    return true;
  }

  private readFile(): AuthFile {
    let text: string;
    try {
      text = readFileSync(this.authPath(), "utf8");
    } catch (error) {
      if (isNotFound(error)) return { version: AUTH_FILE_VERSION, servers: {} };
      throw new Error(`读取本机授权文件失败（${this.authPath()}）：${errorMessage(error)}`);
    }
    if (text.trim() === "") return { version: AUTH_FILE_VERSION, servers: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`解析本机授权文件失败（${this.authPath()}）：${errorMessage(error)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`解析本机授权文件失败（${this.authPath()}）：expected an object`);
    }
    const serversRaw = (parsed as { servers?: unknown }).servers;
    const servers: Record<string, AuthServerRecord> = {};
    if (serversRaw !== undefined) {
      if (serversRaw === null || typeof serversRaw !== "object" || Array.isArray(serversRaw)) {
        throw new Error(`解析本机授权文件失败（${this.authPath()}）：servers 必须是对象`);
      }
      for (const [key, value] of Object.entries(serversRaw as Record<string, unknown>)) {
        const record = normalizeRecord(value);
        if (record !== null) servers[key] = record;
      }
    }
    return { version: AUTH_FILE_VERSION, servers };
  }

  private writeFile(file: AuthFile): void {
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (error) {
      throw new Error(`创建授权目录失败（${this.dir}）：${errorMessage(error)}`);
    }
    restrictDir(this.dir);
    const servers: Record<string, AuthServerRecord> = {};
    for (const key of Object.keys(file.servers).sort()) servers[key] = file.servers[key]!;
    writeAtomic(
      this.authPath(),
      `${JSON.stringify({ version: AUTH_FILE_VERSION, servers }, null, 2)}\n`,
    );
  }
}

// ─── loopback 回调 + 换 token ──────────────────────────────────────────────

interface LoopbackHandle {
  redirectUri: string;
  server: Server;
}

async function listenLoopback(): Promise<LoopbackHandle> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < LOOPBACK_ATTEMPTS; attempt += 1) {
    const server = createServer();
    // close() 期间可能触发 error，避免未处理异常；listen 错误由下面的 once 捕获。
    server.on("error", () => {});
    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          if (typeof address === "object" && address !== null) resolve(address.port);
          else reject(new Error("loopback 未返回监听端口"));
        });
      });
      return { redirectUri: `http://127.0.0.1:${port}/callback`, server };
    } catch (error) {
      lastError = error;
      try {
        server.close();
      } catch {
        /* ignore */
      }
    }
  }
  throw new Error(`无法启动本机回调服务：127.0.0.1 端口不可用（${errorMessage(lastError)}）`);
}

function htmlPage(title: string, message: string): string {
  return [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    "<title>Flowlet CLI 授权</title>",
    "<style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f6f7f9;color:#1f2329;",
    "display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}",
    "main{background:#fff;border-radius:12px;padding:40px 48px;box-shadow:0 8px 30px rgba(0,0,0,.08);max-width:520px}",
    "h1{font-size:20px;margin:0 0 12px}p{font-size:14px;line-height:1.7;margin:0;color:#4e5969}</style>",
    "</head><body><main>",
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(message)}</p>`,
    "</main></body></html>",
  ].join("");
}

function respondHtml(response: ServerResponse, status: number, html: string): Promise<void> {
  return new Promise((resolve) => {
    const body = Buffer.from(html, "utf8");
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(body.length),
      "cache-control": "no-store",
      connection: "close",
    });
    response.end(body, () => resolve());
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface LoginFlowResult {
  token: string;
  expiresAt: string;
}

export interface LoginFlowOptions {
  /** 已归一的服务端 origin（scheme://host[:port]）。 */
  server: string;
  name: string;
  insecure: boolean;
  timeoutMs: number;
  /** loopback 就绪后回调；CLI 在此打印授权 URL（并尝试打开浏览器）。 */
  onAuthorizeUrl: (authorizeUrl: string) => void;
}

/**
 * 完整浏览器授权流程：起 loopback → 打印授权 URL（由 onAuthorizeUrl 完成）→
 * 等浏览器回调 → 校验 state → POST /api/auth/cli/exchange 换取 token。
 *
 * 失败都抛可读 Error（超时/state 不匹配/换 token 失败）；成功返回 token（不落盘，由调用方保存）。
 */
export async function loginWithBrowser(options: LoginFlowOptions): Promise<LoginFlowResult> {
  const { server, name, insecure, timeoutMs } = options;
  const pkce = generatePkce();
  const state = randomBase64Url(STATE_BYTES);
  const loopback = await listenLoopback();

  const authorizeUrl = new URL(`${server}/api/auth/cli/start`);
  authorizeUrl.searchParams.set("redirect_uri", loopback.redirectUri);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("name", name);

  try {
    options.onAuthorizeUrl(authorizeUrl.toString());
    return await waitForCallback({
      server,
      state,
      verifier: pkce.verifier,
      insecure,
      timeoutMs,
      loopback,
    });
  } finally {
    loopback.server.close();
    loopback.server.closeAllConnections();
  }
}

interface CallbackWaitOptions {
  server: string;
  state: string;
  verifier: string;
  insecure: boolean;
  timeoutMs: number;
  loopback: LoopbackHandle;
}

function waitForCallback(options: CallbackWaitOptions): Promise<LoginFlowResult> {
  const { server, state, verifier, insecure, timeoutMs, loopback } = options;
  return new Promise<LoginFlowResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const settle = (outcome: { result?: LoginFlowResult; error?: Error }): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (outcome.error !== undefined) reject(outcome.error);
      else resolve(outcome.result as LoginFlowResult);
    };

    const timeoutSeconds = Math.round(timeoutMs / 1000);
    timer = setTimeout(() => {
      settle({
        error: new Error(
          `授权超时（${timeoutSeconds} 秒）：未收到浏览器授权回调，请重新运行 flowlet login --server=${server}`,
        ),
      });
    }, timeoutMs);
    timer.unref();

    loopback.server.on("request", (request_, response) => {
      void (async () => {
        const requestUrl = new URL(request_.url ?? "/", "http://127.0.0.1");
        if (request_.method !== "GET" || requestUrl.pathname !== "/callback") {
          await respondHtml(response, 404, htmlPage("未找到页面", "这个本机回调地址只接受 /callback。"));
          return;
        }
        const code = requestUrl.searchParams.get("code") ?? "";
        const callbackState = requestUrl.searchParams.get("state") ?? "";
        if (callbackState !== state) {
          await respondHtml(
            response,
            400,
            htmlPage("授权校验失败", "state 不匹配，授权被拒绝。请回到终端重新运行 flowlet login。"),
          );
          settle({
            error: new Error(
              "授权回调校验失败：state 不匹配（可能被伪造或已过期），请重新运行 flowlet login",
            ),
          });
          return;
        }
        if (code === "") {
          await respondHtml(
            response,
            400,
            htmlPage("授权失败", "回调缺少 code 参数。请回到终端重新运行 flowlet login。"),
          );
          settle({ error: new Error("授权回调失败：缺少 code 参数，请重新运行 flowlet login") });
          return;
        }
        try {
          const result = await exchangeCode(server, code, verifier, insecure);
          await respondHtml(response, 200, htmlPage("授权完成", "授权完成，可以关闭此页面。"));
          settle({ result });
        } catch (error) {
          const message = errorMessage(error);
          await respondHtml(
            response,
            502,
            htmlPage("授权失败", `${message} 请回到终端查看错误并重试。`),
          );
          settle({ error: error instanceof Error ? error : new Error(message) });
        }
      })().catch((error: unknown) => {
        settle({ error: error instanceof Error ? error : new Error(errorMessage(error)) });
      });
    });
  });
}

async function exchangeCode(
  server: string,
  code: string,
  codeVerifier: string,
  insecure: boolean,
): Promise<LoginFlowResult> {
  const url = `${server}/api/auth/cli/exchange`;
  let status: number;
  let text: string;
  try {
    const response = await request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ code, codeVerifier }),
      dispatcher: insecure ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined,
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      headersTimeout: EXCHANGE_TIMEOUT_MS,
      bodyTimeout: EXCHANGE_TIMEOUT_MS,
    });
    status = response.statusCode;
    text = await response.body.text();
  } catch (error) {
    throw new Error(
      `请求 ${url} 失败：${requestErrorDetail(error)}（内网自签证书请加 --insecure）`,
    );
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const row =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (status < 200 || status >= 300) {
    const message =
      row !== null && typeof row.message === "string" && row.message !== ""
        ? row.message
        : truncateSingleLine(text, 200);
    throw new Error(`授权换取 token 失败（${status}）：${message}`);
  }
  if (row === null || typeof row.token !== "string" || row.token === "") {
    throw new Error("授权换取 token 失败：服务端未返回 token");
  }
  return {
    token: row.token,
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : "",
  };
}

function truncateSingleLine(text: string, limit: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit)}…`;
}

function requestErrorDetail(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const base = errorMessage(error);
  return cause instanceof Error ? `${base}: ${cause.message}` : base;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && (error as { code?: string }).code === "ENOENT"
  );
}
