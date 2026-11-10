// 远程会话状态解析（纯函数）测试。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCookieHeader,
  EMPTY_REMOTE_SESSION,
  parseRemoteSessionPayload,
} from "../session-state.ts";

test("Cookie 头拼接跳过脏数据", () => {
  assert.equal(
    buildCookieHeader([
      { name: "sid", value: "abc" },
      { name: "other", value: "1" },
      { name: "", value: "ignored" },
      { name: "novalue" },
      { value: "noname" },
    ]),
    "sid=abc; other=1",
  );
  assert.equal(buildCookieHeader([]), "");
});

test("/api/session 解析：OIDC 身份与 CSRF", () => {
  assert.deepEqual(
    parseRemoteSessionPayload({
      authenticated: true,
      mode: "oidc",
      identity: { email: "dev@example.com", username: "dev" },
      csrf_token: "csrf-1",
    }),
    { authenticated: true, mode: "oidc", identity: "dev@example.com", csrf: "csrf-1" },
  );
});

test("身份回退顺序 email -> username -> name，忽略空串", () => {
  assert.equal(parseRemoteSessionPayload({ identity: { username: "u1", name: "n1" } }).identity, "u1");
  assert.equal(parseRemoteSessionPayload({ identity: { email: " ", name: "n2" } }).identity, "n2");
  assert.equal(parseRemoteSessionPayload({ identity: null }).identity, null);
});

test("token 模式与未认证/畸形响应", () => {
  assert.deepEqual(parseRemoteSessionPayload({ authenticated: true, mode: "token" }), {
    authenticated: true,
    mode: "token",
    identity: null,
    csrf: null,
  });
  assert.deepEqual(parseRemoteSessionPayload({ authenticated: false }), {
    authenticated: false,
    mode: "unknown",
    identity: null,
    csrf: null,
  });
  assert.deepEqual(parseRemoteSessionPayload(null), EMPTY_REMOTE_SESSION);
  assert.deepEqual(parseRemoteSessionPayload("oops"), EMPTY_REMOTE_SESSION);
  // 未知 mode 归为 unknown，不猜测
  assert.equal(parseRemoteSessionPayload({ mode: "saml" }).mode, "unknown");
});
