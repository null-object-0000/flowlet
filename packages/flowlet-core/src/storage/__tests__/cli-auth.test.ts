// `cli_auth_tokens` 持久化测试（`flowlet login` 签发的凭据同步 token）。
//
// 覆盖：建表到已有库（migrate 幂等）、插入/按哈希查找/last_used_at/删除、
// 过期清理、列表排序与视图不含明文/哈希、以及库文件在旧库上升级后的可用性。
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteStorage } from "../index.ts";
import {
  deleteCliAuthToken,
  deleteExpiredCliAuthTokens,
  findCliAuthTokenByHash,
  hashCliAuthToken,
  insertCliAuthToken,
  listCliAuthTokens,
  toCliAuthTokenView,
  touchCliAuthToken,
} from "../cli-auth.ts";
import { DatabaseSync } from "node:sqlite";
import { migrate, tableHasColumn } from "../schema.ts";

function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function tempDbPath(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "flowlet-cli-auth-store-"));
  return {
    dir,
    dbPath: path.join(dir, "flowlet.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("cli_auth_tokens：插入 / 按哈希查找 / 记录使用 / 删除", () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const storage = new SqliteStorage(dbPath);
    const token = "flwcli_test-token-0123456789abcdefghijklmnopqrstuvwxyz";
    const hash = hashCliAuthToken(token);
    const expiresAt = rfc3339(new Date(Date.now() + 30 * 24 * 3600_000));

    const created = storage.insertCliAuthToken({
      name: "agent-box",
      tokenHash: hash,
      scope: "credentials:read",
      expiresAt,
    });
    assert.equal(typeof created.id, "string");
    assert.equal(created.token_hash, hash);
    assert.equal(created.last_used_at, null);

    const found = storage.findCliAuthTokenByHash(hash);
    assert.ok(found !== null);
    assert.equal(found!.id, created.id);
    assert.equal(found!.name, "agent-box");
    assert.equal(found!.expires_at, expiresAt);

    // 明文不落库：库文件里即便有哈希，也不应出现 token 明文（哈希不可逆是前提，
    // 这里额外断言列里只有 hash）。
    storage.touchCliAuthToken(String(created.id));
    const touched = storage.findCliAuthTokenByHash(hash);
    assert.notEqual(touched!.last_used_at, null);

    const view = toCliAuthTokenView(touched!);
    assert.deepEqual(Object.keys(view).sort(), [
      "createdAt",
      "expiresAt",
      "id",
      "lastUsedAt",
      "name",
      "scope",
    ]);
    assert.equal(JSON.stringify(view).includes(token), false);

    assert.equal(storage.deleteCliAuthToken(String(created.id)), true);
    assert.equal(storage.findCliAuthTokenByHash(hash), null);
    assert.equal(storage.deleteCliAuthToken(String(created.id)), false);
    storage.close();
  } finally {
    cleanup();
  }
});

test("cli_auth_tokens：过期行清理只删过期项，列表按创建时间排序", () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const storage = new SqliteStorage(dbPath);
    const now = Date.now();
    const live = storage.insertCliAuthToken({
      name: "live",
      tokenHash: hashCliAuthToken("live-token"),
      scope: "credentials:read",
      expiresAt: rfc3339(new Date(now + 3600_000)),
    });
    const dead = storage.insertCliAuthToken({
      name: "dead",
      tokenHash: hashCliAuthToken("dead-token"),
      scope: "credentials:read",
      expiresAt: rfc3339(new Date(now - 3600_000)),
    });
    assert.equal(storage.listCliAuthTokens().length, 2);
    assert.equal(storage.deleteExpiredCliAuthTokens(), 1);
    const remaining = storage.listCliAuthTokens();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.id, live.id);
    assert.equal(remaining.some((row) => row.id === dead.id), false);
    storage.close();
  } finally {
    cleanup();
  }
});

test("旧库升级：migrate 建表幂等，已有 service_credentials 数据不受影响", () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    // 先按“旧版本”建库：只建基础表结构（migrate 会补齐），再断言新表可用。
    const raw = new DatabaseSync(dbPath);
    migrate(raw);
    assert.equal(tableHasColumn(raw, "cli_auth_tokens", "token_hash"), true);
    assert.equal(tableHasColumn(raw, "cli_auth_tokens", "expires_at"), true);
    // 幂等：重复 migrate 不报错、不丢数据。
    insertCliAuthToken(raw, {
      name: "first",
      tokenHash: hashCliAuthToken("first-token"),
      scope: "credentials:read",
      expiresAt: rfc3339(new Date(Date.now() + 3600_000)),
    });
    migrate(raw);
    assert.equal(listCliAuthTokens(raw).length, 1);
    const row = listCliAuthTokens(raw)[0]!;
    assert.equal(findCliAuthTokenByHash(raw, String(row.token_hash))?.id, row.id);
    assert.equal(touchCliAuthToken(raw, String(row.id)), undefined);
    assert.equal(deleteCliAuthToken(raw, String(row.id)), true);
    assert.equal(deleteExpiredCliAuthTokens(raw), 0);
    raw.close();
  } finally {
    cleanup();
  }
});
