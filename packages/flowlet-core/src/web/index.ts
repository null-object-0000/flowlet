// Web Host（管理界面 + 命令 API）。Owner: node-web.
//
// 契约：docs/migration/node-host.md §2、docs/admin-sso-design.md §6/§9；权威 Rust 实现：
// src-tauri/src/core/web/{mod.rs,commands.rs,auth.rs} 与 src-tauri/src/bin/headless.rs。
//
// 路由与鉴权（与 Rust axum router 逐条对齐）：
//   公开：GET|HEAD /health、/api/auth/config、/api/auth/login、/api/auth/callback、静态资源
//   受保护（auth 中间件 + 非安全方法 CSRF）：GET|HEAD /api/session、
//     POST /api/auth/logout、POST /api/commands/{cmd}
//   其他 /api/*：404 空 body（绝不回退 SPA）；错误方法 405（allow 与 axum 一致）
//   token 模式：Bearer + HMAC 常量时间比较；OIDC 模式：HttpOnly Cookie 会话 + CSRF。
//   受保护响应统一 Cache-Control: no-store（401/403 由中间件提前返回，不带该头，与 Rust 一致）。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type {
  DeviceIdentity,
  JsonRow,
  ProxyBindConfig,
  ProxyController,
  RuntimeConfigStore,
} from "../types.ts";
import { CommandError } from "../types.ts";
import type { SqliteStorage } from "../storage/index.ts";
import { AdminAuth, type AuthResponse } from "./auth.ts";
import { CLI_ALLOWED_COMMANDS, createCliAuth, type CliAuthStorage } from "./cli-auth.ts";
import { dispatch } from "./commands.ts";
import type { SecretBoxLike, WebContext } from "./context.ts";
import {
  readChannelsConfig,
  readConfigJson,
  resolveLogCaptureConfig,
  resolveUpstreamProxyConfig,
} from "./config-state.ts";
import { serveStatic } from "./static.ts";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface WebHostOptions {
  storage: SqliteStorage;
  proxy: ProxyController;
  runtimeConfig: RuntimeConfigStore;
  bindConfig: ProxyBindConfig;
  catalogDir: string;
  configPath: string;
  /**
   * 已合并内置渠道模板的 `channels_config`（由 index.ts 的 `loadChannelsConfig` 产出）。
   * 缺省时退回读取 configPath 的原始值；生产入口必须传入，否则数据卷里过旧的
   * config.json 会让 `fetch_channel_models` / `query_balance` 找不到渠道。
   */
  channelsConfig?: JsonRow;
  adminToken: string;
  /** index.ts 在打开 DB 之前创建的 AdminAuth（fail-fast）；缺省时自己 fromEnv。 */
  auth?: AdminAuth;
  /** index.ts 传入的三方服务凭据静态加密（数据卷 secret.key）。 */
  secrets: SecretBoxLike;
  clientToken: string;
  staticDir: string;
  publicProxyUrl: string;
  deviceIdentity: DeviceIdentity;
}

export interface WebHost {
  listen(addr: string): Promise<void>;
  close(): Promise<void>;
  /** Host 维护任务（余额/目录/清理）共享的上下文。 */
  context: WebContext;
}

function parseAddr(addr: string): { host: string; port: number } {
  const index = addr.lastIndexOf(":");
  if (index <= 0) throw new Error(`无效的 Web 监听地址：${addr}`);
  const host = addr.slice(0, index);
  const port = Number(addr.slice(index + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`无效的 Web 监听地址：${addr}`);
  }
  return { host, port };
}

function jsonBody(value: unknown): Buffer {
  const text = value === undefined ? "null" : JSON.stringify(value);
  return Buffer.from(text, "utf8");
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  options: { noStore: boolean; head: boolean; extraHeaders?: Record<string, string> },
): void {
  const body = jsonBody(value);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(body.length),
    ...(options.extraHeaders ?? {}),
  };
  if (options.noStore) headers["cache-control"] = "no-store";
  response.writeHead(status, headers);
  response.end(options.head ? undefined : body);
}

function sendText(
  response: ServerResponse,
  status: number,
  text: string,
  options: { noStore: boolean; head: boolean },
): void {
  const body = Buffer.from(text, "utf8");
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(body.length),
  };
  if (options.noStore) headers["cache-control"] = "no-store";
  response.writeHead(status, headers);
  response.end(options.head ? undefined : body);
}

function sendEmpty(
  response: ServerResponse,
  status: number,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-length": "0", ...extraHeaders });
  response.end();
}

/** CLI 授权页：独立 HTML（不依赖 SPA），禁止缓存/嵌框/外链资源。 */
function sendHtml(response: ServerResponse, status: number, html: string, head: boolean): void {
  const body = Buffer.from(html, "utf8");
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
  });
  response.end(head ? undefined : body);
}

/** 读取 body；超过 4 MiB → 413，非法 JSON → 400（文本错误与 axum JsonRejection 对齐）。 */
async function readJsonBody(
  request: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; text: string }> {
  const contentType = request.headers["content-type"];
  const isJson =
    typeof contentType === "string" &&
    /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;.*)?$/i.test(contentType.trim());
  if (!isJson) {
    return { ok: false, status: 415, text: "Expected request with `Content-Type: application/json`" };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      break;
    }
    chunks.push(buffer);
  }
  if (tooLarge) {
    request.resume();
    return {
      ok: false,
      status: 413,
      text: "Failed to buffer the request body: length limit exceeded",
    };
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") {
    return {
      ok: false,
      status: 400,
      text: "Failed to parse the request body as JSON: EOF while parsing a value at line 1 column 0",
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 400, text: `Failed to parse the request body as JSON: ${detail}` };
  }
}

function unauthorized(response: ServerResponse, extraHeaders: Record<string, string> = {}): void {
  sendJson(
    response,
    401,
    { code: "unauthorized", message: "管理凭据无效，请重新登录" },
    { noStore: false, head: false, extraHeaders },
  );
}

function writeAuthResponse(
  response: ServerResponse,
  payload: AuthResponse,
  head: boolean,
  forceNoStore: boolean,
): void {
  const headers: Record<string, string | string[]> = { ...payload.headers };
  if (forceNoStore) headers["cache-control"] = "no-store";
  response.writeHead(payload.status, headers);
  response.end(head || payload.body.length === 0 ? undefined : payload.body);
}

export function createWebHost(options: WebHostOptions): WebHost {
  const config = readConfigJson(options.configPath);
  const auth = options.auth ?? AdminAuth.fromEnv(process.env, options.adminToken);
  const cliAuth = createCliAuth(options.storage as unknown as CliAuthStorage);
  const ctx: WebContext = {
    storage: options.storage,
    proxy: options.proxy,
    runtimeConfig: options.runtimeConfig,
    catalogDir: options.catalogDir,
    configPath: options.configPath,
    adminToken: options.adminToken,
    clientToken: options.clientToken,
    staticDir: options.staticDir,
    publicProxyUrl: options.publicProxyUrl,
    deviceIdentity: options.deviceIdentity,
    config,
    channelsConfig: options.channelsConfig ?? readChannelsConfig(config),
    logCapture: resolveLogCaptureConfig(options.storage, config),
    upstreamProxy: resolveUpstreamProxyConfig(options.storage, config),
    customScrapeChannels: null,
    secrets: options.secrets,
    cliAuth,
  };

  let server: Server | null = null;

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const rawUrl = request.url ?? "/";
    const url = new URL(rawUrl, "http://localhost");
    const pathname = url.pathname;
    const method = request.method ?? "GET";
    const head = method === "HEAD";
    const authInfo = { headers: request.headers, url: rawUrl };

    // ── 公开 OIDC 路由（与 Rust 的 public Router 一致：无鉴权、无 no-store 中间件） ──
    if (
      pathname === "/api/auth/config" ||
      pathname === "/api/auth/login" ||
      pathname === "/api/auth/callback"
    ) {
      if (method !== "GET" && method !== "HEAD") {
        return sendEmpty(response, 405, { allow: "GET,HEAD" });
      }
      const payload =
        pathname === "/api/auth/config"
          ? auth.configHandler()
          : pathname === "/api/auth/login"
            ? await auth.loginHandler(authInfo)
            : await auth.callbackHandler(authInfo);
      return writeAuthResponse(response, payload, head, false);
    }

    // ── CLI 浏览器授权公开路由（`flowlet login`） ──────────────────────────
    // 授权页要能在「未登录」时打开并给出可读提示，因此不套管理鉴权；
    // 真正的授权动作是受保护的 POST /api/commands/create_cli_auth_code。
    if (pathname === "/api/auth/cli/start") {
      if (method !== "GET" && method !== "HEAD") {
        return sendEmpty(response, 405, { allow: "GET,HEAD" });
      }
      const page = cliAuth.startPage(url.searchParams);
      return sendHtml(response, page.status, page.html, head);
    }
    if (pathname === "/api/auth/cli/exchange") {
      if (method !== "POST") {
        request.resume();
        return sendEmpty(response, 405, { allow: "POST" });
      }
      const body = await readJsonBody(request);
      if (!body.ok) {
        return sendText(response, body.status, body.text, { noStore: true, head: false });
      }
      try {
        return sendJson(response, 200, cliAuth.exchange(body.value), { noStore: true, head: false });
      } catch (error) {
        if (error instanceof CommandError) {
          return sendJson(
            response,
            error.status,
            { code: error.code, message: error.message },
            { noStore: true, head: false },
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return sendJson(response, 400, { code: "invalid_request", message }, { noStore: true, head: false });
      }
    }

    // ── 受保护路由：/api/session、/api/auth/logout、/api/commands/{cmd} ──────
    const commandEncoded = pathname.startsWith("/api/commands/")
      ? pathname.slice("/api/commands/".length)
      : null;
    const isCommandRoute = commandEncoded !== null && commandEncoded !== "" && !commandEncoded.includes("/");
    const isSession = pathname === "/api/session";
    const isLogout = pathname === "/api/auth/logout";

    if (isSession || isLogout || isCommandRoute) {
      const allowedMethods = isSession ? "GET,HEAD" : "POST";
      const methodAllowed =
        isSession ? method === "GET" || method === "HEAD" : method === "POST";
      // 命令名先解码，CLI token 作用域判断与 dispatch 用同一份。
      let command = commandEncoded ?? "";
      if (isCommandRoute) {
        try {
          command = decodeURIComponent(commandEncoded as string);
        } catch {
          /* 保留原文 */
        }
      }
      const context = auth.authenticate(request.headers);
      // CLI 凭据兜底：仅命令路由、仅 flwcli_ 前缀；它没有 Cookie，因此不参与 CSRF。
      const cliToken =
        context === null && isCommandRoute ? cliAuth.authenticate(request.headers) : null;
      if (context === null && cliToken === null) {
        request.resume();
        return unauthorized(response, methodAllowed ? {} : { allow: allowedMethods });
      }
      // axum 中间件：非 GET/HEAD/OPTIONS 先校验 CSRF（在方法路由之前），失败返回 403 且无 no-store。
      if (context !== null && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        if (!auth.verifyCsrf(request.headers, context)) {
          request.resume();
          return sendJson(
            response,
            403,
            { code: "csrf_rejected", message: "请求校验失败，请刷新页面后重试" },
            { noStore: false, head: false },
          );
        }
      }
      if (!methodAllowed) {
        request.resume();
        return sendEmpty(response, 405, {
          allow: allowedMethods,
          "cache-control": "no-store",
        });
      }

      if (isSession || isLogout) {
        // 非命令路由不接受 CLI 凭据（上面 cliToken 也只为命令路由计算）。
        if (context === null) {
          request.resume();
          return unauthorized(response);
        }
        if (isSession) {
          return writeAuthResponse(response, auth.sessionHandler(context), head, true);
        }
        request.resume();
        return writeAuthResponse(response, auth.logoutHandler(context), head, true);
      }

      // CLI 凭据只读服务凭据：其它命令一律 403（不能改配置、不能读日志）。
      if (cliToken !== null && !CLI_ALLOWED_COMMANDS.has(command)) {
        request.resume();
        return sendJson(
          response,
          403,
          { code: "forbidden", message: "CLI 凭据仅可用于凭据同步（export_service_credentials）" },
          { noStore: true, head: false },
        );
      }

      // 命令路由：鉴权通过后才读取 body（与 axum extractor 顺序一致）。
      const body = await readJsonBody(request);
      if (!body.ok) {
        return sendText(response, body.status, body.text, { noStore: true, head: false });
      }
      try {
        const result = await dispatch(ctx, command, body.value);
        return sendJson(response, 200, result, { noStore: true, head: false });
      } catch (error) {
        if (error instanceof CommandError) {
          return sendJson(
            response,
            error.status,
            { code: error.code, message: error.message },
            { noStore: true, head: false },
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return sendJson(
          response,
          400,
          { code: "command_failed", message },
          { noStore: true, head: false },
        );
      }
    }

    // ── /health ─────────────────────────────────────────────────────────────
    if (pathname === "/health") {
      if (method !== "GET" && method !== "HEAD") {
        return sendEmpty(response, 405, { allow: "GET,HEAD" });
      }
      return sendJson(response, 200, { status: "ok" }, { noStore: false, head });
    }

    // ── 其他 /api/*：API 错误，绝不回退 SPA ─────────────────────────────────
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      if (method === "GET" || method === "HEAD" || method === "POST") {
        return sendEmpty(response, 404);
      }
      return sendEmpty(response, 405, { allow: "GET,HEAD,POST" });
    }

    // ── 静态资源 / SPA fallback ─────────────────────────────────────────────
    if (method !== "GET" && method !== "HEAD") {
      return sendEmpty(response, 405, { allow: "GET,HEAD" });
    }
    try {
      const range = typeof request.headers.range === "string" ? request.headers.range : undefined;
      const result = await serveStatic(options.staticDir, pathname, range);
      response.writeHead(result.status, result.headers);
      response.end(head ? undefined : result.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendText(response, 500, message, { noStore: false, head });
    }
  };

  return {
    context: ctx,
    listen(addr: string): Promise<void> {
      const { host, port } = parseAddr(addr);
      return new Promise((resolve, reject) => {
        server = createServer((request, response) => {
          void handler(request, response).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (!response.headersSent) {
              sendText(response, 500, message, { noStore: false, head: false });
            } else {
              response.end();
            }
          });
        });
        server.once("error", reject);
        server.listen(port, host, () => {
          console.log(`Flowlet Web Host 已启动：${addr}（静态界面 ${options.staticDir}）`);
          resolve();
        });
      });
    },
    close(): Promise<void> {
      const active = server;
      if (active === null) return Promise.resolve();
      return new Promise((resolve) => {
        active.close(() => resolve());
        active.closeAllConnections?.();
      });
    },
  };
}

/** 供 index.ts 记录启动信息时复用（与 Rust headless tracing 行保持近似）。 */
export function webStartupSummary(publicProxyUrl: string, deviceId: string): JsonRow {
  return { public_proxy_url: publicProxyUrl, device_id: deviceId };
}
