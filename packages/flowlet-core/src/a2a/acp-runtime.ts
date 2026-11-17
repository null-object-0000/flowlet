import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebContext } from "../web/context.ts";
import { CommandError } from "../types.ts";
import { validateAgentCard } from "./protocol.ts";
import type { AcpCommand } from "../storage/a2a.ts";
import { startNativeAcp } from "./acp-native.ts";

export function acpBridgePath(): string {
  return (
    process.env.FLOWLET_ACP_BRIDGE_BIN ||
    fileURLToPath(
      new URL(
        `../../../flowlet-agent-bridge/bin/flowlet-agent-bridge${process.platform === "win32" ? ".exe" : ""}`,
        import.meta.url,
      ),
    )
  );
}
export function acpCapabilities(ctx: WebContext) {
  return {
    acpRegistration: Boolean(
      (ctx.desktop || process.env.FLOWLET_ENABLE_ACP === "1") &&
      existsSync(acpBridgePath()),
    ),
  };
}
export function requireAcpRuntime(ctx: WebContext): void {
  if (!acpCapabilities(ctx).acpRegistration)
    throw new CommandError(
      403,
      "acp_runtime_disabled",
      "宿主未启用 ACP 运行环境；请安装辅助程序，Web/Docker 宿主还需显式启用 FLOWLET_ENABLE_ACP=1",
    );
}
export function acpCommand(value: unknown): AcpCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请填写 ACP 启动配置");
  const i = value as Record<string, unknown>;
  if (
    typeof i.command !== "string" ||
    !i.command.trim() ||
    i.command.length > 4096 ||
    /[\r\n\0]/.test(i.command)
  )
    throw new Error("ACP 可执行程序无效；参数请单独填写");
  if (
    !Array.isArray(i.args) ||
    i.args.length > 128 ||
    i.args.some(
      (v) => typeof v !== "string" || v.length > 8192 || v.includes("\0"),
    )
  )
    throw new Error("ACP 参数必须为字符串数组，最多 128 项");
  if (
    typeof i.cwd !== "string" ||
    !path.isAbsolute(i.cwd) ||
    !statSync(i.cwd).isDirectory()
  )
    throw new Error("ACP 工作目录必须为宿主上存在的绝对目录");
  return { command: i.command, args: i.args as string[], cwd: i.cwd };
}
interface Runtime {
  endpoint: string;
  token: string;
  card: Record<string, unknown>;
  process: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  close(): Promise<void>;
}
async function startRuntime(
  name: string,
  config: AcpCommand,
  timeoutSeconds: number,
): Promise<Runtime> {
  const token = randomBytes(32).toString("hex");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("FLOWLET_")),
  );
  const child = spawn(acpBridgePath(), [], {
    stdio: "pipe",
    windowsHide: true,
    env,
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  child.on("error", () => {});
  // Agent stderr is intentionally not returned to the renderer or captured in call bodies.
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const close = async () => {
    child.stdin.end();
    const force = setTimeout(() => child.kill("SIGTERM"), 7000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 9000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
      clearTimeout(kill);
    }
  };
  try {
    const ready = await new Promise<{
      endpoint: string;
      card: Record<string, unknown>;
    }>((resolve, reject) => {
      let pending = "";
      const timeout = setTimeout(
        () => finish(new Error("ACP 初始化超过 12 秒")),
        12_000,
      );
      const finish = (
        error?: Error,
        result?: { endpoint: string; card: Record<string, unknown> },
      ) => {
        clearTimeout(timeout);
        child.stdout.off("data", data);
        child.off("error", failed);
        child.off("exit", exited);
        if (error) reject(error);
        else resolve(result!);
      };
      const failed = () =>
        finish(new Error("无法启动 ACP 辅助程序，请检查安装和执行权限"));
      const exited = () =>
        finish(
          new Error(
            "ACP 初始化失败，请检查程序、参数、工作目录及 Agent 登录状态",
          ),
        );
      const data = (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        if (Buffer.byteLength(pending) > 512 * 1024)
          return finish(new Error("ACP 初始化响应超过限制"));
        if (!pending.includes("\n")) return;
        try {
          const result = JSON.parse(pending.slice(0, pending.indexOf("\n")));
          const url = new URL(result.endpoint);
          if (
            url.protocol !== "http:" ||
            url.hostname !== "127.0.0.1" ||
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash
          )
            throw new Error();
          validateAgentCard(result.card);
          finish(undefined, result);
        } catch {
          finish(new Error("ACP 辅助程序返回无效的本机端点或 Agent Card"));
        }
      };
      child.once("error", failed);
      child.once("exit", exited);
      child.stdout.on("data", data);
      child.stdin.write(
        JSON.stringify({ name, ...config, token, timeoutSeconds }) + "\n",
      );
    });
    child.stdout.resume();
    return { ...ready, token, process: child, closed, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export class AcpRuntimes {
  private native = new Map<
    string,
    { fingerprint: string; ready: ReturnType<typeof startNativeAcp> }
  >();
  private runtimes = new Map<
    string,
    { fingerprint: string; ready: Promise<Runtime> }
  >();
  private ctx: WebContext;
  constructor(ctx: WebContext) {
    this.ctx = ctx;
  }
  async probe(name: string, config: AcpCommand, timeout: number) {
    requireAcpRuntime(this.ctx);
    const runtime = await startRuntime(name, config, timeout);
    try {
      return { card: runtime.card, endpoint: "ACP stdio" };
    } finally {
      await runtime.close();
    }
  }
  async ensure(agent: {
    id: string;
    name: string;
    acp?: AcpCommand;
    timeoutSeconds: number;
  }) {
    requireAcpRuntime(this.ctx);
    if (!agent.acp) throw new Error("ACP 启动配置缺失");
    const fingerprint = JSON.stringify([
      agent.name,
      agent.acp,
      agent.timeoutSeconds,
    ]);
    let entry = this.runtimes.get(agent.id);
    if (entry && entry.fingerprint !== fingerprint) {
      await this.stop(agent.id);
      entry = undefined;
    }
    if (!entry) {
      if (this.runtimes.size + this.native.size >= 8)
        throw new Error("ACP 运行环境已达到 8 个 Agent 上限");
      entry = {
        fingerprint,
        ready: startRuntime(agent.name, agent.acp, agent.timeoutSeconds),
      };
      this.runtimes.set(agent.id, entry);
      const current = entry;
      void entry.ready
        .then((runtime) =>
          runtime.closed.then(() => {
            if (this.runtimes.get(agent.id) === current)
              this.runtimes.delete(agent.id);
          }),
        )
        .catch(() => {
          if (this.runtimes.get(agent.id) === current)
            this.runtimes.delete(agent.id);
        });
    }
    return entry.ready;
  }
  async stop(id: string) {
    const entry = this.runtimes.get(id);
    this.runtimes.delete(id);
    const native = [...this.native.entries()].filter(
      ([key]) => key === id || key.startsWith(id + "@"),
    );
    for (const [key] of native) this.native.delete(key);
    await Promise.all(
      native.map(async ([, entry]) =>
        (await entry.ready.catch(() => null))?.close(),
      ),
    );
    if (entry) {
      const runtime = await entry.ready.catch(() => null);
      await runtime?.close();
    }
  }
  async close() {
    await Promise.all(
      [
        ...new Set([
          ...this.runtimes.keys(),
          ...[...this.native.keys()].map((key) => key.split("@")[0]),
        ]),
      ].map((id) => this.stop(id)),
    );
  }
  async ensureNative(
    agent: {
      id: string;
      acp?: AcpCommand;
      timeoutSeconds: number;
    },
    contextId?: string,
  ): Promise<Awaited<ReturnType<typeof startNativeAcp>>> {
    requireAcpRuntime(this.ctx);
    if (!agent.acp) throw new Error("ACP 启动配置缺失");
    // Agents without authentication retain one shared runtime; do not duplicate their state files.
    if (contextId) {
      const shared = await this.ensureNative(agent);
      if (!shared.requiresClientContext) return shared;
    }
    const runtimeKey = contextId ? `${agent.id}@${contextId}` : agent.id;
    const fingerprint = JSON.stringify([agent.acp, agent.timeoutSeconds]);
    let entry = this.native.get(runtimeKey);
    if (entry && entry.fingerprint !== fingerprint) {
      await this.stop(agent.id);
      entry = undefined;
    }
    if (!entry) {
      if (this.runtimes.size + this.native.size >= 8)
        throw new Error("ACP 运行环境已达到 8 个上限");
      entry = {
        fingerprint,
        ready: startNativeAcp(agent.acp, agent.timeoutSeconds, contextId),
      };
      this.native.set(runtimeKey, entry);
      const current = entry;
      const remove = () => {
        if (this.native.get(runtimeKey) === current)
          this.native.delete(runtimeKey);
      };
      void entry.ready
        .then((runtime) => runtime.closed.then(remove))
        .catch(remove);
    }
    return entry.ready;
  }
}
