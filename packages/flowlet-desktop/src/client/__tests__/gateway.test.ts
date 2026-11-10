// 客户端网关契约测试：静态界面同源、/api 反代注入凭据、CSRF、错误映射与路径安全。
// 运行：node --test packages/flowlet-desktop/src/client
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createClientGateway, type GatewayAuth } from "../gateway.ts";
import { normalizeBaseUrl, parseDesktopConfig, remoteUrl, serializeDesktopConfig } from "../config.ts";

interface Recorded {
  method: string;
  url: string;
  authorization: string | null;
  cookie: string | null;
  csrf: string | null;
  acceptEncoding: string | null;
  body: string;
}

let remote: Server | null = null;
let remoteBase = "";
let staticDir = "";
const recorded: Recorded[] = [];
let auth: GatewayAuth = { authorization: "Bearer test-token", csrf: "csrf-1" };
let remoteStatus = 200;

before(async () => {
  staticDir = mkdtempSync(join(tmpdir(), "flowlet-client-static-"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Flowlet</title><div id=root></div>");
  mkdirSync(join(staticDir, "assets"));
  writeFileSync(join(staticDir, "assets", "app.js"), "console.log('flowlet');");

  remote = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      recorded.push({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        authorization: (request.headers.authorization as string | undefined) ?? null,
        cookie: (request.headers.cookie as string | undefined) ?? null,
        csrf: (request.headers["x-csrf-token"] as string | undefined) ?? null,
        acceptEncoding: (request.headers["accept-encoding"] as string | undefined) ?? null,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok"}');
        return;
      }
      if (request.url === "/api/session") {
        response.writeHead(remoteStatus, { "content-type": "application/json" });
        response.end(JSON.stringify({ authenticated: true, mode: "token", csrf_token: "csrf-1" }));
        return;
      }
      if (request.url === "/api/echo") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ authorization: request.headers.authorization ?? null }));
        return;
      }
      if (request.url === "/api/redirect") {
        response.writeHead(302, { location: "https://example.com/login" });
        response.end();
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"code":"not_found"}');
    });
  });
  await new Promise<void>((resolveListen) => remote?.listen(0, "127.0.0.1", () => resolveListen()));
  const address = remote.address();
  if (address === null || typeof address === "string") throw new Error("remote listen failed");
  remoteBase = `http://127.0.0.1:${address.port}`;
});

after(() => {
  remote?.close();
  rmSync(staticDir, { recursive: true, force: true });
});

async function startGateway(overrides: Partial<{ resolveAuth: () => Promise<GatewayAuth>; base: string }> = {}) {
  const gateway = createClientGateway({
    staticDir,
    remoteBase: new URL(overrides.base ?? remoteBase),
    resolveAuth: overrides.resolveAuth ?? (async () => auth),
  });
  const address = await gateway.listen("127.0.0.1", 0);
  return { gateway, base: `http://${address.host}:${address.port}` };
}

test("静态界面与 SPA fallback 走本地网关", async () => {
  const { gateway, base } = await startGateway();
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /<div id=root>/);
    const asset = await fetch(`${base}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    // 未知前端路由回落到 index.html（HashRouter 场景）。
    const fallback = await fetch(`${base}/models`);
    assert.equal(fallback.status, 200);
    assert.match(await fallback.text(), /id=root/);
  } finally {
    await gateway.close();
  }
});

test("/api 反代注入 Bearer 与 CSRF，且不转发渲染进程自带的 Authorization", async () => {
  recorded.length = 0;
  const { gateway, base } = await startGateway();
  try {
    const session = await fetch(`${base}/api/session`, {
      headers: { Authorization: "Bearer renderer-forged", Cookie: "evil=1" },
    });
    assert.equal(session.status, 200);
    assert.equal((recorded[0]?.authorization ?? null), "Bearer test-token");
    assert.equal(recorded[0]?.cookie ?? null, null);

    const post = await fetch(`${base}/api/commands/ipc_ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"hello":"world"}',
    });
    assert.equal(post.status, 404);
    assert.equal(recorded[1]?.csrf, "csrf-1");
    assert.equal(recorded[1]?.body, '{"hello":"world"}');
  } finally {
    await gateway.close();
  }
});

test("OIDC 会话模式注入 Cookie 与 CSRF，且强制 identity 编码", async () => {
  recorded.length = 0;
  const { gateway, base } = await startGateway({
    resolveAuth: async () => ({ cookie: "flowlet_session=abc; other=1", csrf: "csrf-oidc" }),
  });
  try {
    const post = await fetch(`${base}/api/commands/ipc_ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(post.status, 404);
    assert.equal(recorded[0]?.cookie, "flowlet_session=abc; other=1");
    assert.equal(recorded[0]?.csrf, "csrf-oidc");
    assert.equal(recorded[0]?.acceptEncoding, "identity");
    assert.equal(recorded[0]?.authorization, null);
  } finally {
    await gateway.close();
  }
});

test("远程 401 原样透传，前端据此提示重新登录", async () => {
  remoteStatus = 401;
  const { gateway, base } = await startGateway();
  try {
    const response = await fetch(`${base}/api/session`);
    assert.equal(response.status, 401);
  } finally {
    remoteStatus = 200;
    await gateway.close();
  }
});

test("远程不可达映射为 502 + remote_unreachable", async () => {
  const { gateway, base } = await startGateway({ base: "http://127.0.0.1:1" });
  try {
    const response = await fetch(`${base}/api/session`);
    assert.equal(response.status, 502);
    const body = (await response.json()) as { code?: string; message?: string };
    assert.equal(body.code, "remote_unreachable");
    assert.match(body.message ?? "", /无法连接远程主机/);
    // 静态资源不依赖远程：远程挂了也能打开本地界面并展示错误。
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally {
    await gateway.close();
  }
});

test("静态路径穿越被拒绝", async () => {
  const { gateway, base } = await startGateway();
  try {
    const response = await fetch(`${base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    assert.ok(response.status === 403 || response.status === 400, `unexpected ${response.status}`);
  } finally {
    await gateway.close();
  }
});

test("远程健康检查透传", async () => {
  const { gateway, base } = await startGateway();
  try {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    await gateway.close();
  }
});

test("配置归一与序列化", () => {
  assert.equal(normalizeBaseUrl("https://Flowlet.Example.com/"), "https://flowlet.example.com");
  assert.equal(normalizeBaseUrl("http://10.0.0.5:8080"), "http://10.0.0.5:8080");
  assert.throws(() => normalizeBaseUrl("ftp://x"), /只支持 http/);
  assert.throws(() => normalizeBaseUrl("https://x.example.com/api"), /不能带路径/);
  assert.throws(() => normalizeBaseUrl("https://user:pass@x.example.com"), /不能包含用户名或密码/);
  assert.equal(remoteUrl("https://x.example.com", "/api/session"), "https://x.example.com/api/session");

  const parsed = parseDesktopConfig({
    mode: "client",
    client: { baseUrl: "https://flowlet.example.com/", auth: { kind: "session" } },
  });
  assert.equal(parsed.mode, "client");
  assert.equal(parsed.client?.baseUrl, "https://flowlet.example.com");
  assert.deepEqual(parsed.client?.auth, { kind: "session" });

  // 损坏地址回落到主机模式，避免应用起不来。
  assert.equal(parseDesktopConfig({ mode: "client", client: { baseUrl: "bad" } }).mode, "host");
  assert.equal(parseDesktopConfig(null).mode, "host");

  const text = serializeDesktopConfig(
    { version: 1, mode: "client", client: { baseUrl: "https://a.example.com", auth: { kind: "token" } } },
    "enc-value",
  );
  const restored = JSON.parse(text) as { client?: { tokenEnc?: string } };
  assert.equal(restored.client?.tokenEnc, "enc-value");
});
