// Web Host（管理界面 + 命令 API）。Owner: node-web.
//
// 契约：docs/migration/node-host.md §2；权威 Rust 实现：
// src-tauri/src/core/web/{mod.rs,commands.rs} 与 src-tauri/src/bin/headless.rs。
//
// 路由与鉴权（与 Rust axum router 逐条对齐）：
//   GET|HEAD /api/session          → 401 / {"authenticated":true}（鉴权后 no-store）
//   POST     /api/commands/{cmd}   → 命令 dispatch（鉴权，no-store，body ≤ 4 MiB）
//   GET|HEAD /health               → {"status":"ok"}（不鉴权）
//   GET|HEAD|POST /api/{*path}     → 404 空 body（不鉴权；绝不回退 SPA）
//   其 他    /api/{*path}          → 405（allow: GET,HEAD,POST）
//   GET|HEAD 其余路径              → dist-web 静态文件 / SPA fallback（404 + index.html）
//   其余方法                       → 405（allow: GET,HEAD）
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";

import type {
  DeviceIdentity,
  JsonRow,
  ProxyBindConfig,
  ProxyController,
  RuntimeConfigStore,
} from "../types.ts";
import { CommandError } from "../types.ts";
import type { SqliteStorage } from "../storage/index.ts";
import { checkAdminAuth } from "./auth.ts";
import { dispatch } from "./commands.ts";
import type { WebContext } from "./context.ts";
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
  adminToken: string;
  clientToken: string;
  staticDir: string;
  publicProxyUrl: string;
  deviceIdentity: DeviceIdentity;
}

export interface WebHost {
  /** 命令层共享上下文（调度器复用 queryBalance / 预设语义）。 */
  readonly context: WebContext;
  listen(addr: string): Promise<void>;
  close(): Promise<void>;
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

export function createWebHost(options: WebHostOptions): WebHost {
  const config = readConfigJson(options.configPath);
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
    channelsConfig: readChannelsConfig(config),
    logCapture: resolveLogCaptureConfig(options.storage, config),
    upstreamProxy: resolveUpstreamProxyConfig(options.storage, config),
    customScrapeChannels: null,
  };

  let server: Server | null = null;

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const rawUrl = request.url ?? "/";
    const url = new URL(rawUrl, "http://localhost");
    const pathname = url.pathname;
    const method = request.method ?? "GET";
    const head = method === "HEAD";
    const authorized = (): boolean =>
      checkAdminAuth(
        typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
        options.adminToken,
      );

    // ── /api/session ────────────────────────────────────────────────────────
    if (pathname === "/api/session") {
      const methodAllowed = method === "GET" || method === "HEAD";
      if (!authorized()) return unauthorized(response, methodAllowed ? {} : { allow: "GET,HEAD" });
      if (!methodAllowed) {
        return sendEmpty(response, 405, { allow: "GET,HEAD", "cache-control": "no-store" });
      }
      return sendJson(response, 200, { authenticated: true }, { noStore: true, head });
    }

    // ── /api/commands/{command} ─────────────────────────────────────────────
    if (pathname.startsWith("/api/commands/")) {
      const encoded = pathname.slice("/api/commands/".length);
      const isCommandRoute = encoded !== "" && !encoded.includes("/");
      if (isCommandRoute) {
        const methodAllowed = method === "POST";
        if (!authorized()) return unauthorized(response, methodAllowed ? {} : { allow: "POST" });
        if (!methodAllowed) {
          return sendEmpty(response, 405, { allow: "POST", "cache-control": "no-store" });
        }
        let command = encoded;
        try {
          command = decodeURIComponent(encoded);
        } catch {
          /* 保留原文 */
        }
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
      // 非命令路由（空 command / 多级路径）落到 /api/* 语义。
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
