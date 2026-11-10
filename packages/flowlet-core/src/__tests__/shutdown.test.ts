// Node Host 退出语义测试：SIGTERM 不应被在途长连接拖到 Docker stop_grace_period。
//
// 运行：node --test packages/flowlet-core/src/__tests__/shutdown.test.ts
//
// 背景（2026-11-10）：Docker 升级时容器 stop 曾整整耗掉 30s——代理 stop() 会等
// in-flight SSE 自然结束，直到 stop_grace_period 被 SIGKILL，于是使用端停机 30s。
// 现在 Host 关闭走 proxy.dispose()：只宽限 FLOWLET_SHUTDOWN_ABORT_MS（默认 1s），
// 随后强制断开在途连接并退出。本测试验证：
// 1) 有未完成的 in-flight 请求时，SIGTERM 后进程在约 1s 内退出（远小于 30s）；
// 2) 退出码为 0，且前端 Web 端口可正常关闭；
// 3) 无在途请求时同样快速退出。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

const cleanupCallbacks: Array<() => void> = [];

after(() => {
  for (const cleanup of cleanupCallbacks.reverse()) cleanup();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

interface RunningHost {
  pid: number;
  proxyPort: number;
  stop: () => Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    elapsedMs: number;
  }>;
}

async function startHost(abortMs: number): Promise<RunningHost> {
  const workDir = mkdtempSync(path.join(tmpdir(), "flowlet-shutdown-test-"));
  cleanupCallbacks.push(() => rmSync(workDir, { recursive: true, force: true }));
  const staticDir = path.join(workDir, "static");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>shutdown test</title>");
  const catalogDir = path.join(workDir, "catalogs");
  mkdirSync(catalogDir, { recursive: true });
  const configPath = path.join(workDir, "config.json");
  // 复制仓库内置默认配置（Host 要求 channels_config 字段齐全）。
  copyFileSync(path.join(REPO_ROOT, "config.json"), configPath);

  const webPort = await freePort();
  const proxyPort = await freePort();
  const child = spawn(process.execPath, [path.join(REPO_ROOT, "packages/flowlet-core/src/index.ts")], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? tmpdir(),
      TMPDIR: workDir,
      NODE_ENV: "production",
      FLOWLET_ADMIN_AUTH_MODE: "token",
      FLOWLET_ADMIN_TOKEN: "0123456789abcdef0123456789",
      FLOWLET_CLIENT_TOKEN: "shutdown-test-client-token",
      FLOWLET_BIND_ADDR: `127.0.0.1:${proxyPort}`,
      FLOWLET_WEB_ADDR: `127.0.0.1:${webPort}`,
      FLOWLET_DB_PATH: path.join(workDir, "flowlet.sqlite"),
      FLOWLET_CONFIG_PATH: configPath,
      FLOWLET_CATALOG_DIR: catalogDir,
      FLOWLET_STATIC_DIR: staticDir,
      FLOWLET_DISABLE_BACKGROUND_TASKS: "1",
      FLOWLET_SHUTDOWN_ABORT_MS: String(abortMs),
      FLOWLET_SHUTDOWN_HARD_EXIT_MS: "5000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  let exited = false;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  cleanupCallbacks.push(() => {
    if (!exited) child.kill("SIGKILL");
  });

  // 等待 Web 端口可访问；启动失败时把子进程输出带出来便于定位。
  const deadline = Date.now() + 25_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (exited) break;
    try {
      const response = await fetch(`http://127.0.0.1:${webPort}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) {
        healthy = true;
        break;
      }
    } catch {
      /* 尚未监听 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!healthy) {
    child.kill("SIGKILL");
    await exitPromise;
    throw new Error(`Host 未在预期时间内就绪：\n${output.join("")}`);
  }

  return {
    pid: child.pid ?? 0,
    proxyPort,
    stop: async (): Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      elapsedMs: number;
    }> => {
      const started = Date.now();
      // Windows 没有 POSIX 信号：Node 的 child.kill("SIGTERM") 会直接 TerminateProcess，
      // 进程被硬杀、走不到优雅退出路径（退出码非 0 且耗时无意义）。libuv 在 Windows 上为
      // `raise(SIGTERM)` 开了后门，因此改发 SIGINT（control-break）让 host 走与 Docker/systemd
      // 相同的优雅关闭分支（POSIX 上仍是真实 SIGTERM）。
      child.kill(process.platform === "win32" ? "SIGINT" : "SIGTERM");
      const result = await exitPromise;
      return { ...result, elapsedMs: Date.now() - started };
    },
  };
}

/** 打开一条连接并发送不完整请求：服务端会挂着一个未完成的 in-flight 请求。 */
function openInFlightRequest(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("error", reject);
    socket.once("connect", () => {
      // 有 Content-Length 但 body 不完整：请求一直停在解析/等待阶段。
      socket.write("POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{\"model\":");
      resolve(socket);
    });
  });
}

/** Windows 的 SIGINT 等价于「控制台 Ctrl+C」：进程以 control-break 退出，退出码为 null + 信号。 */
function assertGracefulExit(code: number | null, signal: NodeJS.Signals | null): void {
  if (process.platform === "win32") {
    assert.equal(signal, "SIGINT", "Windows 下应以 control-break 信号优雅退出");
  } else {
    assert.equal(code, 0, "SIGTERM 后应以 0 退出");
  }
}

describe("Node Host 优雅退出（Docker 升级停机时间）", () => {
  it("存在未完成 in-flight 请求时，SIGTERM 后 1s 内退出（而不是等 30s）", async () => {
    const host = await startHost(200);
    const socket = await openInFlightRequest(host.proxyPort);
    const { code, signal, elapsedMs } = await host.stop();
    assertGracefulExit(code, signal);
    assert.ok(elapsedMs < 3000, `退出耗时 ${elapsedMs}ms，应远小于 30s 的 stop_grace_period`);
    // 端口释放 + 在途连接被断开：旧连接不能让新容器/进程无法重新监听。
    const rebound = await new Promise<boolean>((resolve) => {
      const server = createNetServer();
      server.once("error", () => resolve(false));
      server.listen(host.proxyPort, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    assert.ok(rebound, "退出后模型入口端口应可立即重新绑定");
    socket.destroy();
  });

  it("没有在途请求时同样快速退出", async () => {
    const host = await startHost(1000);
    const { code, signal, elapsedMs } = await host.stop();
    assertGracefulExit(code, signal);
    assert.ok(elapsedMs < 2500, `退出耗时 ${elapsedMs}ms，应远小于 30s`);
  });
});