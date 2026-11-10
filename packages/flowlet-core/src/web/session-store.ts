// 管理端 OIDC 会话持久化（文件存储）。
//
// 背景：Web Host 的 OIDC 会话原本只存在进程内存里，容器重启（每次 Docker 升级都会
// 重建容器）会让所有管理台登录态失效，使用端被迫重新登录。会话改写到 `/data` 下的
// 文件后，重启/升级不再掉登录；会话本身仍是服务端状态（cookie 只保存随机串，
// 落盘的是它的 sha256），不改变鉴权模型与超时语义。
//
// 约束：
// - 只用于 OIDC cookie 会话；token 模式（Bearer）不产生会话，不落盘。
// - 文件权限 0600；写入用「临时文件 + rename」保证原子性。
// - 文件只在会话创建/销毁/周期性刷新 lastSeen 时重写，管理台并发极低。
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const FILE_SCHEMA_VERSION = 1;

/** 可持久化的会话身份（与 auth.ts 的 Identity 结构一致）。 */
export interface PersistedIdentity {
  sub: string;
  email: string | null;
  username: string | null;
  name: string | null;
  groups: string[];
  provider: string;
}

/** 落盘的一条会话：key 是 cookie 的 sha256（不保存原始 cookie）。 */
export interface PersistedAdminSession {
  key: string;
  identity: PersistedIdentity;
  csrfToken: string;
  createdMs: number;
  lastSeenMs: number;
  absoluteExpireMs: number;
}

export interface AdminSessionStore {
  load(key: string): PersistedAdminSession | null;
  save(session: PersistedAdminSession): void;
  remove(key: string): void;
  /** 删除已过期/闲置超时的会话；由调用方提供判定，保证与内存态同一口径。 */
  prune(isExpired: (session: PersistedAdminSession) => boolean): void;
}

interface FileShape {
  schemaVersion: number;
  sessions: PersistedAdminSession[];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isString(item));
}

function parseIdentity(raw: unknown): PersistedIdentity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!isString(value.sub) || !isString(value.provider)) return null;
  const optional = (input: unknown): string | null => (isString(input) ? input : null);
  if (!isStringArray(value.groups)) return null;
  return {
    sub: value.sub,
    email: optional(value.email),
    username: optional(value.username),
    name: optional(value.name),
    groups: [...value.groups],
    provider: value.provider,
  };
}

function parseSession(raw: unknown): PersistedAdminSession | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const identity = parseIdentity(value.identity);
  if (identity === null) return null;
  if (!isString(value.key) || !isString(value.csrfToken)) return null;
  for (const field of ["createdMs", "lastSeenMs", "absoluteExpireMs"] as const) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field] as number)) return null;
  }
  return {
    key: value.key,
    identity,
    csrfToken: value.csrfToken,
    createdMs: value.createdMs as number,
    lastSeenMs: value.lastSeenMs as number,
    absoluteExpireMs: value.absoluteExpireMs as number,
  };
}

/**
 * 文件会话存储。构造时同步读取（体量很小）；读写失败一律降级为空/跳过，
 * 不因为持久化问题阻断登录（最坏情况退化成原来的「重启掉登录」）。
 */
export class FileAdminSessionStore implements AdminSessionStore {
  readonly #file: string;
  readonly #sessions = new Map<string, PersistedAdminSession>();

  constructor(file: string) {
    this.#file = file;
    this.#load();
  }

  #load(): void {
    if (!existsSync(this.#file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#file, "utf8"));
    } catch (error) {
      console.error(
        `[session-store] 会话文件无法解析，按空会话处理：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (typeof raw !== "object" || raw === null) return;
    const shape = raw as Partial<FileShape>;
    if (shape.schemaVersion !== FILE_SCHEMA_VERSION || !Array.isArray(shape.sessions)) return;
    for (const item of shape.sessions) {
      const session = parseSession(item);
      if (session !== null) this.#sessions.set(session.key, session);
    }
  }

  #flush(): void {
    const shape: FileShape = { schemaVersion: FILE_SCHEMA_VERSION, sessions: [...this.#sessions.values()] };
    const payload = JSON.stringify(shape);
    const tmp = join(dirname(this.#file), `.${process.pid}-${Date.now()}.admin-sessions.tmp`);
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      writeFileSync(tmp, payload, { mode: 0o600 });
      renameSync(tmp, this.#file);
      // rename 保留临时文件权限，但显式再收紧一次，避免 umask/挂载差异。
      chmodSync(this.#file, 0o600);
    } catch (error) {
      console.error(
        `[session-store] 会话写入失败，下次重启将丢弃本轮会话：${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 忽略清理失败 */
      }
    }
  }

  load(key: string): PersistedAdminSession | null {
    const session = this.#sessions.get(key);
    return session === undefined ? null : { ...session, identity: { ...session.identity, groups: [...session.identity.groups] } };
  }

  save(session: PersistedAdminSession): void {
    this.#sessions.set(session.key, {
      ...session,
      identity: { ...session.identity, groups: [...session.identity.groups] },
    });
    this.#flush();
  }

  remove(key: string): void {
    if (!this.#sessions.delete(key)) return;
    this.#flush();
  }

  prune(isExpired: (session: PersistedAdminSession) => boolean): void {
    let changed = false;
    for (const [key, session] of this.#sessions) {
      if (isExpired(session)) {
        this.#sessions.delete(key);
        changed = true;
      }
    }
    if (changed) this.#flush();
  }
}

/** 打不开/无需持久化时返回 null，调用方退回纯内存会话。 */
export function openAdminSessionStore(file: string): AdminSessionStore | null {
  try {
    return new FileAdminSessionStore(file);
  } catch (error) {
    console.error(
      `[session-store] 会话持久化不可用（${file}）：${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}