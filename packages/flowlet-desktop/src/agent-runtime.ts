// 托管 Agent Web 运行时（当前仅 DeepSeek Harness / DSH）。
//
// Rust 权威实现：`src-tauri/src/core/agent_runtime.rs` +
// `agent_environment/adapters/deepseek_harness.rs`：
// - DSH 安装方式为 npx 时启动 `npx @deepseek-ai/dsh web --no-open`，
//   否则 `dsh web --no-open`；
// - 就绪判定是 TCP 连接 127.0.0.1:3080（20s 超时）；
// - 外部已运行的 DSH 不会被接管。
//
// Windows Job Object（崩溃回收整棵进程树）是 Electron 版已知缺口：这里用
// `detached` 进程组 + 退出时组杀作为降级；被强杀仍可能留下孤儿。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { platform } from "node:os";
import type { DesktopLogger } from "./logger.ts";

const DSH_HEALTH_HOST = "127.0.0.1";
const DSH_HEALTH_PORT = 3080;
const DSH_WEB_URL = "http://127.0.0.1:3080";
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 8_000;
const OUTPUT_LIMIT = 24 * 1024;

export interface AgentRuntimeStatus {
  readonly running: boolean;
  readonly pid?: number;
  readonly url?: string;
  readonly external?: boolean;
  readonly managed?: boolean;
}

interface ManagedRuntime {
  child: ChildProcess;
  output: string;
  readonly command: string;
}

export class AgentRuntimeManager {
  private readonly logger: DesktopLogger;
  private readonly runtimes = new Map<string, ManagedRuntime>();

  constructor(logger: DesktopLogger) {
    this.logger = logger;
  }

  private isDsh(agentType: string): boolean {
    return agentType === "dsh" || agentType === "deepseek-harness" || agentType === "deepseek_harness";
  }

  async start(agentType: string, cwd?: string): Promise<AgentRuntimeStatus> {
    if (!this.isDsh(agentType)) {
      throw new Error(`暂不支持托管 ${agentType} 的本地运行时`);
    }
    const existing = this.runtimes.get(agentType);
    if (existing !== undefined && existing.child.exitCode === null) {
      return { running: true, pid: existing.child.pid, url: DSH_WEB_URL, managed: true };
    }
    if (await isReachable()) {
      throw new Error(
        "DSH Web 已由 Flowlet 之外的进程启动；为避免终止未知进程，Flowlet 不会接管。请先在原启动位置停止后重试。",
      );
    }
    const launch = this.resolveLaunch();
    const child = spawn(launch.command, launch.args, {
      cwd,
      windowsHide: true,
      // Unix 建独立进程组，退出时一次杀整组；Windows 依赖 taskkill /T。
      detached: platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const managed: ManagedRuntime = { child, output: "", command: launch.display };
    const capture = (chunk: Buffer): void => {
      managed.output = `${managed.output}${chunk.toString("utf8")}`.slice(-OUTPUT_LIMIT);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    this.runtimes.set(agentType, managed);
    this.logger.info("已启动托管 Agent 运行时", { agentType, pid: child.pid, command: launch.display });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await isReachable()) {
        return { running: true, pid: child.pid, url: DSH_WEB_URL, managed: true };
      }
      if (child.exitCode !== null) {
        this.runtimes.delete(agentType);
        const detail = managed.output.trim();
        throw new Error(
          `\`${launch.display}\` 启动后立即退出（code ${String(child.exitCode)}）${
            detail === "" ? "" : `：${detail.slice(-1000)}`
          }`,
        );
      }
      await delay(200);
    }
    this.runtimes.delete(agentType);
    await this.terminate(managed);
    throw new Error(`\`${launch.display}\` 已启动，但 127.0.0.1:${DSH_HEALTH_PORT} 在 20 秒内未就绪`);
  }

  async stop(agentType: string): Promise<null> {
    if (!this.isDsh(agentType)) {
      throw new Error(`暂不支持托管 ${agentType} 的本地运行时`);
    }
    const managed = this.runtimes.get(agentType);
    if (managed === undefined) {
      if (await isReachable()) {
        throw new Error(
          "DSH Web 不是由当前 Flowlet 启动；为避免终止未知进程，请在原启动位置停止。",
        );
      }
      return null;
    }
    this.runtimes.delete(agentType);
    await this.terminate(managed);
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await isReachable())) return null;
      await delay(100);
    }
    throw new Error("DSH Web 停止超时（端口 3080 仍可连接）");
  }

  async status(): Promise<AgentRuntimeStatus> {
    const managed = this.runtimes.get("dsh");
    const managedRunning = managed !== undefined && managed.child.exitCode === null;
    const reachable = await isReachable();
    if (managedRunning) {
      return { running: reachable, pid: managed.child.pid, url: DSH_WEB_URL, external: false, managed: true };
    }
    if (reachable) return { running: true, url: DSH_WEB_URL, external: true, managed: false };
    return { running: false, external: false, managed: false };
  }

  async stopAll(): Promise<void> {
    const ids = [...this.runtimes.keys()];
    for (const id of ids) {
      try {
        await this.stop(id);
      } catch (error) {
        this.logger.warn("停止托管 Agent 运行时失败", {
          agentType: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private resolveLaunch(): { command: string; args: string[]; display: string } {
    // 与 Rust 一致：PATH 中有 dsh 就用 dsh，否则用 npx 跑官方包。
    const override = process.env.FLOWLET_DSH_COMMAND;
    if (override !== undefined && override !== "") {
      return { command: override, args: ["web", "--no-open"], display: `${override} web --no-open` };
    }
    if (commandExists("dsh")) {
      return { command: "dsh", args: ["web", "--no-open"], display: "dsh web --no-open" };
    }
    const npx = platform() === "win32" ? "npx.cmd" : "npx";
    return {
      command: npx,
      args: ["@deepseek-ai/dsh", "web", "--no-open"],
      display: "npx @deepseek-ai/dsh web --no-open",
    };
  }

  private async terminate(managed: ManagedRuntime): Promise<void> {
    const { child } = managed;
    if (child.exitCode !== null) return;
    const pid = child.pid;
    if (pid === undefined) return;
    if (platform() === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
      });
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        /* 已退出 */
      }
    }
    const deadline = Date.now() + 3000;
    while (child.exitCode === null && Date.now() < deadline) await delay(100);
    if (child.exitCode === null) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
      }
    }
  }
}

function commandExists(command: string): boolean {
  const path = process.env.PATH;
  if (path === undefined) return false;
  const exts = platform() === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of path.split(platform() === "win32" ? ";" : ":")) {
    if (dir === "") continue;
    for (const ext of exts) {
      try {
        if (existsSync(`${dir}/${command}${ext}`)) return true;
      } catch {
        /* 忽略不可读目录 */
      }
    }
  }
  return false;
}

function isReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: DSH_HEALTH_HOST, port: DSH_HEALTH_PORT });
    const done = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}