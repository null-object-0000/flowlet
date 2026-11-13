import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { restrictDir, writeAtomic } from "./store.ts";
import { object, type A2aObject } from "./a2a.ts";

export interface A2aSession {
  schemaVersion: 1;
  endpoint: string;
  prefix: string;
  contextId?: string;
  taskId?: string;
  updatedAt: string;
}
export class SessionFile {
  readonly file: string;
  private endpoint: string;
  private prefix: string;
  constructor(
    dir: string,
    endpoint: string,
    prefix: string,
    name?: string,
    file?: string,
  ) {
    if (name !== undefined && (name.length > 100 || !name.trim()))
      throw new Error("会话名称需为1–100个字符");
    this.endpoint = endpoint;
    this.prefix = prefix;
    this.file = file
      ? path.resolve(file)
      : path.join(
          dir,
          "a2a-sessions",
          createHash("sha256")
            .update(JSON.stringify([endpoint, prefix, name]))
            .digest("hex") + ".json",
        );
  }
  read(): A2aSession | null {
    if (!existsSync(this.file)) return null;
    const state = object(JSON.parse(readFileSync(this.file, "utf8")));
    if (
      state.schemaVersion !== 1 ||
      state.endpoint !== this.endpoint ||
      state.prefix !== this.prefix
    )
      throw new Error("会话记录属于其他 A2A 目标；请使用新的会话或 --new");
    if (
      (state.contextId !== undefined && typeof state.contextId !== "string") ||
      (state.taskId !== undefined && typeof state.taskId !== "string")
    )
      throw new Error("会话记录格式无效");
    return state as unknown as A2aSession;
  }
  lock(): () => void {
    const parent = path.dirname(this.file);
    const existed = existsSync(parent);
    mkdirSync(parent, { recursive: true });
    if (!existed) restrictDir(parent);
    const lock = this.file + ".lock";
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          `同一会话正被其他命令使用：${lock}；进程异常退出后，请确认进程已结束再移除锁文件`,
        );
      throw error;
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    } catch (error) {
      closeSync(fd);
      rmSync(lock, { force: true });
      throw error;
    }
    return () => {
      closeSync(fd);
      rmSync(lock, { force: true });
    };
  }
  save(previous: A2aSession | null, value: A2aObject): A2aSession | null {
    const item = object(
      value.task ??
        value.message ??
        value.statusUpdate ??
        value.artifactUpdate ??
        value,
    );
    const contextId =
      typeof item.contextId === "string" ? item.contextId : previous?.contextId;
    const taskId =
      typeof item.id === "string" && item.status
        ? item.id
        : typeof item.taskId === "string"
          ? item.taskId
          : value.message
            ? undefined
            : previous?.taskId;
    if (!contextId && !taskId) return previous;
    const record: A2aSession = {
      schemaVersion: 1,
      endpoint: this.endpoint,
      prefix: this.prefix,
      contextId,
      taskId,
      updatedAt: new Date().toISOString(),
    };
    writeAtomic(this.file, JSON.stringify(record, null, 2) + "\n");
    return record;
  }
  clear() {
    rmSync(this.file, { force: true });
  }
}
