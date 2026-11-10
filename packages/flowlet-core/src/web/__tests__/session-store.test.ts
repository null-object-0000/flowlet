// 管理端会话文件存储单元测试（Docker 重启不掉登录的持久化层）。
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/session-store.test.ts
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { FileAdminSessionStore, type PersistedAdminSession } from "../session-store.ts";

const cleanup: Array<() => void> = [];

after(() => {
  for (const fn of cleanup.reverse()) fn();
});

function tempStoreFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "flowlet-session-store-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "admin-sessions.json");
}

function session(key: string, overrides: Partial<PersistedAdminSession> = {}): PersistedAdminSession {
  const now = Date.now();
  return {
    key,
    identity: {
      sub: "user-1",
      email: "alice@corp.example",
      username: "alice",
      name: "Alice",
      groups: ["flowlet-admins"],
      provider: "GitLab",
    },
    csrfToken: "csrf-token-" + key,
    createdMs: now,
    lastSeenMs: now,
    absoluteExpireMs: now + 60_000,
    ...overrides,
  };
}

describe("FileAdminSessionStore", () => {
  it("写入后可读回，文件权限为 0600 且不含原始会话值", () => {
    const file = tempStoreFile();
    const store = new FileAdminSessionStore(file);
    store.save(session("sha256-key"));
    const raw = readFileSync(file, "utf8");
    assert.ok(raw.includes("sha256-key"));
    assert.ok((statSync(file).mode & 0o777) === 0o600, "会话文件必须 0600");
    const reloaded = new FileAdminSessionStore(file).load("sha256-key");
    assert.ok(reloaded);
    assert.equal(reloaded?.csrfToken, "csrf-token-sha256-key");
    assert.deepEqual(reloaded?.identity.groups, ["flowlet-admins"]);
    store.remove("sha256-key");
    assert.equal(new FileAdminSessionStore(file).load("sha256-key"), null);
  });

  it("prune 只删除调用方判定过期的会话", () => {
    const file = tempStoreFile();
    const store = new FileAdminSessionStore(file);
    store.save(session("fresh"));
    store.save(session("idle", { lastSeenMs: Date.now() - 3_600_000 }));
    const now = Date.now();
    store.prune((item) => now - item.lastSeenMs > 1_800_000);
    const reloaded = new FileAdminSessionStore(file);
    assert.ok(reloaded.load("fresh"));
    assert.equal(reloaded.load("idle"), null);
  });

  it("文件损坏/版本不符时退化为空会话，不影响启动", () => {
    const file = tempStoreFile();
    writeFileSync(file, "{not-json");
    assert.equal(new FileAdminSessionStore(file).load("any"), null);
    writeFileSync(file, JSON.stringify({ schemaVersion: 99, sessions: [session("x")] }));
    assert.equal(new FileAdminSessionStore(file).load("x"), null);
    chmodSync(file, 0o600);
  });
});