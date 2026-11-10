// Model entry proxy controller: node:http listener, client-token auth, routing.
//
// 契约：docs/migration/node-host.md §3 + proxy-core.md。行为对齐
// `src-tauri/src/core/proxy.rs` 的 ProxyController/handler 层；转发细节在 forward.ts。
//
// 生命周期语义（与 Rust 对齐）：
// - start() 幂等：已在运行时不再重复绑定；监听地址取 bindConfig()。
// - stop() 幂等：未运行时直接返回；已运行时等待 in-flight 结束（不强制杀 SSE）。
// - bind config 变更不热重绑端口：下一次 start() 生效（前端负责重启）。
// - 调用密钥（default_client_token）在每次请求时实时读取，保存后下一次请求即生效。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ModelCatalog } from "../catalog/index.ts";
import type { SqliteStorage } from "../storage/index.ts";
import type { JsonRow, ProxyBindConfig, ProxyStatus } from "../types.ts";
import { ModelIdentityIndex } from "./catalog.ts";
import { handleModelRequest, type ProxyRuntimeConfigSource } from "./forward.ts";
import { addCorsHeaders, getHeader, identifyClient } from "./http.ts";
import type { HeaderMapLike } from "./http.ts";
import { RateLimiter } from "./util.ts";
import { UpstreamTransport } from "./upstream.ts";

export interface ProxyControllerOptions {
  storage: SqliteStorage;
  catalog: ModelCatalog;
  runtimeConfig: ProxyRuntimeConfigSource;
  clientToken: string;
  bindConfig: ProxyBindConfig;
  /** config.json 路径：用于每请求 UA 规则与 log_capture 兜底。 */
  configPath?: string;
  upstreamTimeoutSeconds?: number;
  /**
   * 进程退出（dispose）时允许在途请求继续跑的宽限毫秒数，超时后强制断开。
   * 只影响 Host 关闭；运行期 stop/start（管理台启停代理）仍等待在途自然结束。
   */
  shutdownAbortMs?: number;
}

export interface ProxyController {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 进程退出：宽限 shutdownAbortMs 后强制断开在途连接，并关闭上游连接池。 */
  dispose(): Promise<void>;
  status(): ProxyStatus;
  bindConfig(): ProxyBindConfig;
  setBindConfig(config: ProxyBindConfig): void;
}

/** 进程退出时在途请求的默认宽限：够短请求收尾，又不把容器停机拖成秒级。 */
const DEFAULT_SHUTDOWN_ABORT_MS = 250;

class ProxyControllerImpl implements ProxyController {
  #options: ProxyControllerOptions;
  #identity: ModelIdentityIndex;
  #transport = new UpstreamTransport();
  #rateLimiter = new RateLimiter(600);
  #roundRobin = new Map<string, number>();
  #credentialOverrides = new Map<string, { status: string; lastError: string | null }>();
  #bind: ProxyBindConfig;
  #server: Server | null = null;
  #startedAt: string | null = null;
  #addr = "";

  constructor(options: ProxyControllerOptions) {
    this.#options = options;
    this.#identity = new ModelIdentityIndex(options.catalog);
    this.#bind = { ...options.bindConfig };
    // Rust 的 ProxyRuntime.bind_addr 在 start 前也有默认值；这里取初始 bind config。
    this.#addr = `${this.#bind.host}:${this.#bind.port}`;
  }

  async start(): Promise<void> {
    if (this.#server !== null) return; // 幂等
    const { host, port } = this.#bind;
    const server = createServer((req, res) => {
      void this.#handle(req, res);
    });
    // 模型请求体可能很大，且 SSE 长流不应被默认 5min 请求超时中断。
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.keepAliveTimeout = 65_000;
    server.on("clientError", (_error, socket) => {
      // 断连/解析错误只记录，不退出进程。
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown): void => {
        server.off("listening", onListening);
        reject(
          new Error(
            `启动代理失败: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      };
      const onListening = (): void => {
        server.off("error", onError);
        server.on("error", (error) => {
          console.error("[proxy] 代理服务异常:", error);
        });
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });

    this.#server = server;
    this.#startedAt = new Date().toISOString();
    this.#addr = `${host}:${port}`;
  }

  async stop(): Promise<void> {
    // 运行期语义（与 Rust 一致）：等待 in-flight（含长 SSE）自然结束；空闲 keep-alive 直接断开。
    await this.#closeServer(null);
  }

  async dispose(): Promise<void> {
    // 进程退出语义：只给 shutdownAbortMs 宽限，之后强制断开在途连接，
    // 避免容器 stop 被长流拖到 stop_grace_period（Docker 升级的总停机时间就是它）。
    const abortMs = this.#options.shutdownAbortMs ?? DEFAULT_SHUTDOWN_ABORT_MS;
    await this.#closeServer(Math.max(0, abortMs));
    // 上游连接池关闭会等待 busy 连接变空闲：进程马上就要 exit，不能让它拖住停机。
    // 给 250ms 尽量体面地关，超时由 process.exit 收尾。
    await Promise.race([
      this.#transport.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 150);
        timer.unref?.();
      }),
    ]);
  }

  #closeServer(abortMs: number | null): Promise<void> {
    const server = this.#server;
    if (server === null) return Promise.resolve(); // 幂等
    this.#server = null;
    this.#startedAt = null;
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      server.close(() => finish());
      // 空闲 keep-alive 连接可直接断开；abortMs === null 时 in-flight 等待自然结束。
      server.closeIdleConnections?.();
      if (abortMs === null) return;
      if (abortMs <= 0) {
        server.closeAllConnections?.();
        return;
      }
      // 不 unref：这 1s 内即使连接已空闲也要保证定时器一定触发，避免把停机拖到硬超时。
      setTimeout(() => server.closeAllConnections?.(), abortMs);
    });
  }

  status(): ProxyStatus {
    return {
      running: this.#server !== null,
      bind_addr: this.#addr,
      started_at: this.#startedAt,
    };
  }

  bindConfig(): ProxyBindConfig {
    return { ...this.#bind };
  }

  setBindConfig(config: ProxyBindConfig): void {
    // 端口/主机变更不热重绑（与 Rust 一致，重启代理生效）；token 下一次请求即生效。
    this.#bind = { ...config };
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url && req.url !== "" ? req.url : "/";
    const path = rawUrl.split("?")[0] ?? "/";
    const method = (req.method ?? "GET").toUpperCase();
    const headers = req.headers as HeaderMapLike;

    // /health 永远不需要鉴权（Host 契约）。
    if (path === "/health") {
      if (method === "OPTIONS") {
        const requested = getHeader(headers, "access-control-request-headers");
        const cors: Record<string, string> = {};
        addCorsHeaders(cors, requested);
        res.writeHead(204, cors);
        res.end();
        return;
      }
      const cors: Record<string, string> = {};
      addCorsHeaders(cors);
      res.writeHead(200, cors);
      res.end("ok");
      return;
    }

    // Host 模式：除 /health 外所有模型入口都要求合法 client token。
    const token = this.#bind.default_client_token;
    const authorized = token !== "" && identifyClient(headers, token) !== null;
    if (!authorized) {
      const body = Buffer.from(
        JSON.stringify({
          error: {
            message: "Invalid client API key",
            type: "authentication_error",
            code: "invalid_api_key",
          },
        }),
        "utf8",
      );
      res.writeHead(401, {
        "content-type": "application/json",
        "content-length": String(body.length),
      });
      res.end(body);
      return;
    }

    const initialProtocol =
      path.startsWith("/anthropic/v1/")
        ? ("anthropic" as const)
        : path.startsWith("/v1/") ||
            path.startsWith("/openai/v1/") ||
            path === "/responses" ||
            path.startsWith("/responses/")
          ? ("openai" as const)
          : null;
    if (initialProtocol === null) {
      res.writeHead(404);
      res.end();
      return;
    }

    await handleModelRequest(
      {
        storage: this.#options.storage,
        identity: this.#identity,
        runtimeConfig: this.#options.runtimeConfig,
        transport: this.#transport,
        bindConfig: () => this.#bind,
        configPath: this.#options.configPath,
        upstreamTimeoutSeconds: this.#options.upstreamTimeoutSeconds,
        rateLimiter: this.#rateLimiter,
        rateLimitEnabled: true,
        roundRobin: this.#roundRobin,
        credentialOverrides: this.#credentialOverrides,
      },
      req,
      res,
      initialProtocol,
    );
  }
}

export function createProxyController(options: ProxyControllerOptions): ProxyController {
  return new ProxyControllerImpl(options);
}

export type { JsonRow };