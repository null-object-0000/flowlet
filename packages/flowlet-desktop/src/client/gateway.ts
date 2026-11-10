// 桌面「客户端模式」本地网关（纯 Node，不 import electron，便于单测）。
//
// 渲染进程仍然从 `http://127.0.0.1:<port>/` 加载现有前端（dist-desktop），
// 因此所有请求保持同源；`/api/*` 与 `/health` 由网关反向代理到远程 Web Host：
//
//   renderer ──同源──> Client Gateway ──Bearer / Cookie──> 远程 Host
//
// 为什么不直接让渲染进程请求远程地址：
// - Web Host 的管理 API 只对同源浏览器开放（无 CORS），跨源会被浏览器拦截；
// - 凭据（token / OIDC 会话 Cookie + CSRF）留在主进程，不进入渲染进程 storage；
// - 远程地址只允许 http(s)、不能带路径，避免 SSRF 探针。
//
// 安全边界：
// - 只代理 `/api/*` 与 `/health`，不代理任意路径；
// - 不转发渲染进程带来的 Authorization / Cookie / Host / Origin；
// - 静态资源做路径穿越校验；
// - 请求体上限 16 MiB（管理命令为 JSON；模型转发走远程主机自己的代理端口，不经这里）。
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { remoteUrl } from "./config.ts";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface GatewayAuth {
  /** `Authorization` 头原值；token 模式为 `Bearer <token>`。 */
  authorization?: string;
  /** `Cookie` 头原值；OIDC 会话模式由主进程会话存储提供。 */
  cookie?: string;
  /** OIDC 模式下非安全方法要带的 CSRF token（`X-CSRF-Token`）。 */
  csrf?: string;
}

export interface ClientGatewayOptions {
  /** dist-desktop 目录。 */
  readonly staticDir: string;
  /** 远程主机根地址（http/https，无路径）。 */
  remoteBase: URL;
  /** 每个请求实时解析凭据（token 会话/ Cookie 可能会刷新）。 */
  readonly resolveAuth: () => Promise<GatewayAuth>;
  readonly logger?: { warn(message: string, detail?: unknown): void };
}

export interface ClientGateway {
  listen(host: string, port: number): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  /** 远程地址变更（用户重连）后调用；不需要重启网关。 */
  setRemoteBase(url: URL): void;
  readonly remoteBase: URL;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** 转发给远程的请求头白名单（其余一律丢弃，避免把本地上下文泄露给远端）。 */
const FORWARD_REQUEST_HEADERS = new Set(["accept", "accept-language", "content-type", "x-requested-with"]);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function createClientGateway(options: ClientGatewayOptions): ClientGateway {
  const staticRoot = resolve(options.staticDir);
  let remoteBase = options.remoteBase;
  let server: Server | null = null;

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const rawUrl = request.url ?? "/";
    const url = new URL(rawUrl, "http://127.0.0.1");
    if (url.pathname === "/health" || url.pathname.startsWith("/api/")) {
      await proxy(request, response, url);
      return;
    }
    serveStatic(request, response, url);
  };

  async function proxy(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = (request.method ?? "GET").toUpperCase();
    const target = remoteUrl(remoteBase.toString(), `${url.pathname}${url.search}`);
    let body: Uint8Array | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const read = await readBody(request);
      if (read === null) {
        sendJson(response, 413, { code: "body_too_large", message: "请求体超过 16 MiB" });
        return;
      }
      body = read;
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      const key = name.toLowerCase();
      if (!FORWARD_REQUEST_HEADERS.has(key) || value === undefined) continue;
      if (Array.isArray(value)) headers.set(key, value.join(", "));
      else headers.set(key, value);
    }

    let auth: GatewayAuth;
    try {
      auth = await options.resolveAuth();
    } catch (error) {
      sendJson(response, 401, {
        code: "remote_auth_unavailable",
        message: `远程主机凭据不可用：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    // 让远程直接返回未压缩响应：网关按流转发，不做解压，避免 content-encoding 丢失后
    // 客户端拿到压缩字节。管理 API 响应很小，identity 的传输成本可忽略。
    headers.set("accept-encoding", "identity");
    if (auth.authorization !== undefined) headers.set("authorization", auth.authorization);
    if (auth.cookie !== undefined && auth.cookie !== "") headers.set("cookie", auth.cookie);
    if (auth.csrf !== undefined && auth.csrf !== "" && method !== "GET" && method !== "HEAD") {
      headers.set("x-csrf-token", auth.csrf);
    }

    const isStream = url.pathname.startsWith("/api/ai/");
    const controller = new AbortController();
    const timer = isStream ? null : setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const upstream = await fetch(target, {
        method,
        headers,
        body: body as RequestInit["body"],
        redirect: "manual",
        signal: controller.signal,
      });
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers.entries()) {
        const key = name.toLowerCase();
        if (HOP_BY_HOP.has(key)) continue;
        if (key === "content-encoding" || key === "content-length") continue;
        response.setHeader(name, value);
      }
      response.setHeader("cache-control", upstream.headers.get("cache-control") ?? "no-store");
      if (upstream.body === null) {
        response.end();
        return;
      }
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!response.write(Buffer.from(value))) {
          await new Promise<void>((resolveDrain) => response.once("drain", resolveDrain));
        }
      }
      response.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.warn("代理远程请求失败", { target, method, message });
      if (!response.headersSent) {
        sendJson(response, 502, {
          code: "remote_unreachable",
          message: `无法连接远程主机（${remoteBase.host}）：${message}`,
        });
      } else {
        response.end();
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  function serveStatic(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const method = (request.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      sendJson(response, 405, { code: "method_not_allowed", message: "静态资源只支持 GET/HEAD" });
      return;
    }
    const decoded = safeDecode(url.pathname);
    if (decoded === null) {
      sendJson(response, 400, { code: "bad_request", message: "请求路径无效" });
      return;
    }
    const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    const candidate = resolve(staticRoot, normalize(relative));
    if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}${sep}`)) {
      sendJson(response, 403, { code: "forbidden", message: "禁止访问该路径" });
      return;
    }
    const file = pickFile(candidate);
    if (file === null) {
      if (decoded.startsWith("/assets/")) {
        sendJson(response, 404, { code: "not_found", message: "资源不存在" });
        return;
      }
      // SPA fallback：HashRouter 只需要 index.html。
      const index = join(staticRoot, "index.html");
      if (!existsSync(index)) {
        sendJson(response, 503, {
          code: "ui_missing",
          message: "客户端界面缺失：请先执行 npm run build:desktop",
        });
        return;
      }
      sendFile(index, response, method === "HEAD");
      return;
    }
    sendFile(file, response, method === "HEAD");
  }

  function sendFile(file: string, response: ServerResponse, headOnly: boolean): void {
    const stats = statSync(file);
    response.statusCode = 200;
    response.setHeader("content-type", MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
    response.setHeader("content-length", String(stats.size));
    response.setHeader("cache-control", file.endsWith("index.html") ? "no-store" : "public, max-age=3600");
    if (headOnly) {
      response.end();
      return;
    }
    createReadStream(file)
      .on("error", () => response.destroy())
      .pipe(response);
  }

  return {
    get remoteBase() {
      return remoteBase;
    },
    setRemoteBase(url: URL): void {
      remoteBase = url;
    },
    listen(host: string, port: number): Promise<{ host: string; port: number }> {
      return new Promise((resolveListen, rejectListen) => {
        server = createServer((request, response) => {
          void handler(request, response).catch((error: unknown) => {
            options.logger?.warn("客户端网关请求失败", {
              error: error instanceof Error ? error.message : String(error),
            });
            if (!response.headersSent) {
              sendJson(response, 500, { code: "gateway_failed", message: "本地网关处理失败" });
            } else {
              response.end();
            }
          });
        });
        server.once("error", rejectListen);
        server.listen(port, host, () => {
          const address = server?.address();
          if (address === null || address === undefined || typeof address === "string") {
            resolveListen({ host, port });
            return;
          }
          resolveListen({ host: address.address, port: address.port });
        });
      });
    },
    close(): Promise<void> {
      const active = server;
      server = null;
      if (active === null) return Promise.resolve();
      return new Promise((resolveClose) => {
        active.close(() => resolveClose());
        active.closeAllConnections?.();
      });
    },
  };
}

function pickFile(candidate: string): string | null {
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  const index = join(candidate, "index.html");
  if (existsSync(index) && statSync(index).isFile()) return index;
  return null;
}

function safeDecode(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

async function readBody(request: IncomingMessage): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      return null;
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", String(Buffer.byteLength(text)));
  response.end(text);
}
