// Beszel 客户端单测（地址归一 / 路径构造 / 认证 / 系统解析 / 错误提示）+ mock 服务器集成。
// 运行：node --test packages/flowlet-cred/src/__tests__/
//
// HTTP mock 必须跑在子进程里（与 cli.test.ts 相同原因：本进程内不能可靠地同时提供 mock）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BeszelClient,
  BeszelError,
  describeError,
  normalizeBaseUrl,
  parseSystems,
  resolveApiPath,
} from "../beszel.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.resolve(HERE, "mock-server.ts");

const BESZEL_EMAIL = "fixture@example.com";
const BESZEL_PASSWORD = "beszel-test-fixture-password-8k3m";

const processes: Array<import("node:child_process").ChildProcess> = [];
after(() => {
  for (const child of processes) child.kill("SIGKILL");
});

function startMock(options: Record<string, unknown>): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK_SERVER, JSON.stringify({ mode: "beszel", ...options })], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.push(child);
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const match = /PORT (\d+)\n/.exec(buffer);
      if (match === null) return;
      child.stdout.off("data", onData);
      const port = Number(match[1]);
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => child.kill("SIGKILL"),
      });
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    setTimeout(() => reject(new Error("mock server 启动超时")), 10_000).unref();
  });
}

describe("beszel normalizeBaseUrl", () => {
  it("去末尾斜杠、剥 /api 与 PocketBase 管理面板 /_/，保留其它子路径", () => {
    assert.equal(normalizeBaseUrl("http://beszel.example.com:8090"), "http://beszel.example.com:8090");
    assert.equal(normalizeBaseUrl("  http://host:8090/  "), "http://host:8090");
    assert.equal(normalizeBaseUrl("http://host:8090///"), "http://host:8090");
    assert.equal(normalizeBaseUrl("http://host:8090/api"), "http://host:8090");
    assert.equal(normalizeBaseUrl("http://host:8090/api/"), "http://host:8090");
    assert.equal(normalizeBaseUrl("http://host:8090/_/"), "http://host:8090");
    assert.equal(normalizeBaseUrl("http://host:8090/_"), "http://host:8090");
    assert.equal(normalizeBaseUrl("http://host:8090/api/api"), "http://host:8090");
    assert.equal(normalizeBaseUrl("https://ops.example.com/beszel/"), "https://ops.example.com/beszel");
  });

  it("拒绝空地址/非法 scheme/query/fragment", () => {
    assert.throws(() => normalizeBaseUrl("   "), /Beszel 地址不能为空/);
    assert.throws(() => normalizeBaseUrl("ftp://host:8090"), /Beszel 地址必须是 http 或 https/);
    // 不带 scheme 的 `host:port` 会被 URL 解析成 scheme，最终落到 scheme 校验（与 Rust 一致）。
    assert.throws(() => normalizeBaseUrl("beszel.example.com:8090"), /Beszel 地址必须是 http 或 https/);
    assert.throws(() => normalizeBaseUrl("http://"), /Beszel 地址无法解析/);
    assert.throws(() => normalizeBaseUrl("http://host:8090/?a=1"), /Beszel 地址不能带查询参数或锚点/);
    assert.throws(() => normalizeBaseUrl("http://host:8090/#top"), /Beszel 地址不能带查询参数或锚点/);
  });
});

describe("beszel resolveApiPath", () => {
  const base = "http://host:8090";

  it("统一拼到 {base}/api，PATH 可带 /api 前缀与 query", () => {
    assert.equal(
      resolveApiPath(base, "/collections/systems/records"),
      "http://host:8090/api/collections/systems/records",
    );
    assert.equal(
      resolveApiPath(base, "collections/systems/records?perPage=1"),
      "http://host:8090/api/collections/systems/records?perPage=1",
    );
    assert.equal(
      resolveApiPath(base, "/api/collections/systems/records"),
      "http://host:8090/api/collections/systems/records",
    );
    assert.equal(resolveApiPath(base, "api/beszel/info"), "http://host:8090/api/beszel/info");
  });

  it("拒绝空路径与绝对 URL（避免 token 被发到别处）", () => {
    assert.throws(() => resolveApiPath(base, "  "), /API 路径不能为空/);
    assert.throws(
      () => resolveApiPath(base, "https://evil.example.com/collections/systems/records"),
      /API 路径必须是相对路径（如 \/collections\/systems\/records），不接受绝对 URL/,
    );
    assert.throws(() => resolveApiPath(base, "http://evil.example.com/x"), /不接受绝对 URL/);
  });
});

describe("beszel parseSystems", () => {
  it("投影 items 为 id/name/host/status/port（缺失/数字字段处理）", () => {
    const parsed = parseSystems({
      page: 1,
      perPage: 2,
      totalItems: 7,
      totalPages: 1,
      items: [
        { id: "s1", name: "web", host: "10.0.0.1", status: "up", port: 45876, updated: "x" },
        { id: "s2", name: "db" },
      ],
    });
    assert.deepEqual(parsed, {
      page: 1,
      perPage: 2,
      totalItems: 7,
      totalPages: 1,
      items: [
        { id: "s1", name: "web", host: "10.0.0.1", status: "up", port: "45876" },
        { id: "s2", name: "db", host: "", status: "", port: "" },
      ],
    });
  });

  it("totalItems 缺失回退 items.length；非数组报契约文案", () => {
    const parsed = parseSystems({ items: [{ id: "s1" }] });
    assert.equal(parsed.totalItems, 1);
    assert.throws(() => parseSystems({ items: null }), /解析系统列表失败：expected a sequence/);
    assert.throws(() => parseSystems({ items: {} }), /解析系统列表失败：expected a sequence/);
    assert.throws(() => parseSystems([]), /解析系统列表失败：expected a sequence/);
  });
});

describe("beszel describeError / BeszelError", () => {
  it("按状态码给出可执行提示，JSON 体的 message/error/原文拼在前面", () => {
    assert.equal(
      describeError(400, null, true),
      "邮箱或密码错误，请确认是 Beszel 用户账号（不是 PocketBase 超级管理员）",
    );
    assert.equal(
      describeError(400, { message: "Failed to authenticate." }, true),
      "Failed to authenticate.（邮箱或密码错误，请确认是 Beszel 用户账号（不是 PocketBase 超级管理员））",
    );
    assert.equal(
      describeError(401, null),
      "token 无效或已过期，请重新用邮箱+密码登录",
    );
    assert.match(describeError(403, { error: "Forbidden" }), /^Forbidden（密码登录可能被禁用/);
    assert.match(describeError(404, null), /请确认填写的是 Beszel Hub 根地址（默认端口 8090）/);
    assert.match(describeError(429, null), /触发 Beszel 限流/);
    assert.match(describeError(500, null), /请检查邮箱、密码、实例地址与网络连通性/);
    // 非 auth 端点的 400 用通用提示。
    assert.match(describeError(400, null), /请检查邮箱、密码、实例地址与网络连通性/);
    // 纯文本响应作为原文拼在提示前。
    assert.equal(describeError(418, "teapot"), "teapot（请检查邮箱、密码、实例地址与网络连通性）");
  });

  it("toString 与 Rust Display 一致", () => {
    assert.equal(new BeszelError(400, "Bad Request").toString(), "Beszel API 400: Bad Request");
    assert.equal(new BeszelError(null, "boom").toString(), "Beszel API: boom");
  });

  it("构造时立即拒绝空邮箱 / 空密码", () => {
    assert.throws(() => new BeszelClient("http://host:8090", "  ", BESZEL_PASSWORD), /Beszel 邮箱不能为空/);
    assert.throws(() => new BeszelClient("http://host:8090", BESZEL_EMAIL, "  "), /Beszel 密码不能为空/);
  });
});

describe("beszel BeszelClient（mock 服务器）", () => {
  it("auth：邮箱+密码换 token 并解析 record；token 复用不重复认证", async () => {
    const mock = await startMock({});
    const client = new BeszelClient(`${mock.baseUrl}/_/`, BESZEL_EMAIL, BESZEL_PASSWORD);
    assert.equal(client.base(), mock.baseUrl);
    assert.equal(client.apiBase(), `${mock.baseUrl}/api`);
    assert.deepEqual(await client.auth(), {
      token: "beszel-test-fixture-token-5v1n",
      email: BESZEL_EMAIL,
      name: "Fixture Beszel",
      role: "admin",
    });
    // 第二次直接使用缓存。
    assert.deepEqual(await client.auth(), await client.auth());
    mock.close();
  });

  it("auth：密码错误返回 400 与邮箱/密码提示", async () => {
    const mock = await startMock({});
    const client = new BeszelClient(mock.baseUrl, BESZEL_EMAIL, "wrong-password");
    await assert.rejects(client.auth(), (error: unknown) => {
      assert.ok(error instanceof BeszelError);
      assert.equal(error.status, 400);
      assert.equal(
        error.toString(),
        "Beszel API 400: Failed to authenticate.（邮箱或密码错误，请确认是 Beszel 用户账号（不是 PocketBase 超级管理员））",
      );
      return true;
    });
    mock.close();
  });

  it("info：读取 hub 版本；失败时抛出（由调用方按非致命处理）", async () => {
    const mock = await startMock({});
    const client = new BeszelClient(mock.baseUrl, BESZEL_EMAIL, BESZEL_PASSWORD);
    assert.equal(await client.info(), "0.21.1");
    assert.equal(await client.systems(1).then((page) => page.totalItems), 3);
    mock.close();

    const missing = await startMock({ beszelInfoStatus: 404 });
    const c = new BeszelClient(missing.baseUrl, BESZEL_EMAIL, BESZEL_PASSWORD);
    await assert.rejects(c.info(), (error: unknown) => {
      assert.ok(error instanceof BeszelError);
      assert.equal(error.status, 404);
      assert.match(error.toString(), /接口不存在/);
      return true;
    });
    missing.close();
  });

  it("systems：默认 perPage=200 返回投影后的系统列表", async () => {
    const mock = await startMock({});
    const client = new BeszelClient(mock.baseUrl, BESZEL_EMAIL, BESZEL_PASSWORD);
    const page = await client.systems();
    assert.equal(page.page, 1);
    assert.equal(page.perPage, 200);
    assert.equal(page.totalItems, 3);
    assert.deepEqual(page.items, [
      { id: "sys-1", name: "web-01", host: "10.0.0.11", status: "up", port: "45876" },
      { id: "sys-2", name: "db-01", host: "10.0.0.12", status: "up", port: "45877" },
      { id: "sys-3", name: "cache-01", host: "10.0.0.13", status: "down", port: "45878" },
    ]);
    mock.close();
  });

  it("request：GET 透传、POST body 透传、404 映射、绝对 URL 拒绝", async () => {
    const mock = await startMock({});
    const client = new BeszelClient(mock.baseUrl, BESZEL_EMAIL, BESZEL_PASSWORD);
    assert.deepEqual(await client.request("GET", "/beszel/info"), { v: "0.21.1" });
    assert.deepEqual(await client.request("POST", "/echo", { hello: 1 }), {
      method: "POST",
      body: { hello: 1 },
      path: "/api/echo",
    });
    await assert.rejects(
      client.request("GET", "/missing"),
      (error: unknown) =>
        error instanceof BeszelError &&
        error.status === 404 &&
        error.toString().startsWith("Beszel API 404: Not Found（接口不存在："),
    );
    await assert.rejects(
      client.request("GET", "https://evil.example.com/x"),
      (error: unknown) =>
        error instanceof BeszelError &&
        error.status === null &&
        error.toString() ===
          "Beszel API: API 路径必须是相对路径（如 /collections/systems/records），不接受绝对 URL",
    );
    mock.close();
  });

  it("auth：连不上时带 --insecure 提示且 status 为 null", async () => {
    // 127.0.0.1:1 连接被拒绝（Linux 上稳定）。
    const client = new BeszelClient("http://127.0.0.1:1", BESZEL_EMAIL, BESZEL_PASSWORD);
    await assert.rejects(
      client.auth(),
      (error: unknown) =>
        error instanceof BeszelError &&
        error.status === null &&
        /请求 http:\/\/127\.0\.0\.1:1\/api\/collections\/users\/auth-with-password 失败：/.test(
          error.toString(),
        ) &&
        error.toString().includes("内网自签证书请加 --insecure"),
    );
  });
});