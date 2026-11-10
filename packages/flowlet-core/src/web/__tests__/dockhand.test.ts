// Dockhand 客户端测试。Owner: node-web.
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/dockhand.test.ts
// 覆盖：URL 归一（尾斜杠/`/api` 后缀/子路径/非法 scheme/query 拒绝）、api_base、
// resolveApiPath（相对路径、`/api` 前缀剥离、query 保留、绝对 URL 拒绝）、
// parseEnvironments 容错、describeError 文案、Bearer 头/超时外行为（health/system/stacks/request）。
// 只访问 127.0.0.1 本地 mock，不访问真实 Dockhand 面板。
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, describe, it } from "node:test";

import {
  apiBase,
  describeError,
  DockhandClient,
  DockhandError,
  normalizeBaseUrl,
  parseEnvironments,
  resolveApiPath,
} from "../dockhand.ts";

const VALID_TOKEN = "dockhand-test-fixture-token-9x8y";

// ─── 本地 Dockhand mock（1.0.57 的端点语义） ───────────────────────────────

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  accept: string | undefined;
  userAgent: string | undefined;
  body: string;
}

class MockDockhand {
  #server: Server | null = null;
  baseUrl = "";
  // 子路径部署：所有端点都在 /dockhand/api/... 下。
  subpath = "/dockhand";
  requests: RecordedRequest[] = [];
  environments: unknown = [
    {
      id: 2,
      name: "[CentOS] 10.0.0.60",
      host: "10.0.0.60",
      port: 2375,
      protocol: "http",
    },
  ];

  async start(): Promise<void> {
    this.#server = createHttpServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", () => {
        const address = this.#server!.address();
        const port = typeof address === "object" && address ? address.port : 0;
        this.baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          this.#server?.close(() => resolve());
        }),
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    this.requests.push({
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
      accept: typeof request.headers.accept === "string" ? request.headers.accept : undefined,
      userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    const send = (status: number, value: unknown): void => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(body.length),
      });
      response.end(body);
    };
    const sendRaw = (status: number, text: string): void => {
      const body = Buffer.from(text, "utf8");
      response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(body.length),
      });
      response.end(body);
    };

    const suffix = url.pathname.startsWith(this.subpath)
      ? url.pathname.slice(this.subpath.length)
      : url.pathname;
    if (suffix === "/api/environments") {
      // 认证失败返回 401 JSON（实测行为）。
      if (request.headers.authorization !== `Bearer ${VALID_TOKEN}`) {
        return send(401, { message: "Unauthorized" });
      }
      return send(200, this.environments);
    }
    // /health 匿名可访问：不能用来校验 token。
    if (suffix === "/api/health") return send(200, { status: "ok", timestamp: "2026-11-10T00:00:00Z" });
    if (request.headers.authorization !== `Bearer ${VALID_TOKEN}`) {
      return send(401, { message: "Unauthorized" });
    }
    if (suffix === "/api/system") {
      assert.equal(url.searchParams.get("env"), "2");
      return send(200, { docker: { version: "27.0.3", serverVersion: "27.0.3" }, host: { name: "centos" } });
    }
    if (suffix === "/api/stacks") {
      assert.equal(url.searchParams.get("env"), "2");
      return send(200, [{ name: "flowlet", containers: ["flowlet", "flowlet-egress"] }]);
    }
    if (suffix === "/api/echo") {
      const text = this.requests.at(-1)?.body ?? "";
      return send(200, { method: request.method, body: text === "" ? null : JSON.parse(text) });
    }
    if (suffix === "/api/empty") {
      response.writeHead(204, { "content-length": "0" });
      response.end();
      return;
    }
    if (suffix === "/api/text") return sendRaw(200, "plain text body");
    if (suffix === "/api/boom") return send(500, { error: "docker daemon unavailable" });
    return send(404, { message: "404 Not Found" });
  }
}

const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

async function startMock(): Promise<MockDockhand> {
  const mock = new MockDockhand();
  await mock.start();
  return mock;
}

// ─── URL / 解析 / 文案 ────────────────────────────────────────────────────

describe("Dockhand 客户端基础", () => {
  it("normalizeBaseUrl：尾斜杠/剥 /api/保留子路径/拒绝非法输入", () => {
    assert.equal(normalizeBaseUrl("http://dockhand.example.com:3000"), "http://dockhand.example.com:3000");
    assert.equal(normalizeBaseUrl("  http://dockhand.example.com:3000/  "), "http://dockhand.example.com:3000");
    assert.equal(normalizeBaseUrl("http://host:3000/api"), "http://host:3000");
    assert.equal(normalizeBaseUrl("http://host:3000/api/"), "http://host:3000");
    assert.equal(normalizeBaseUrl("http://host:3000/dockhand/"), "http://host:3000/dockhand");
    assert.equal(normalizeBaseUrl("http://host:3000/dockhand/api"), "http://host:3000/dockhand");
    assert.equal(normalizeBaseUrl("https://Dockhand.Example.com:443/"), "https://dockhand.example.com");
    assert.throws(() => normalizeBaseUrl(""), /Dockhand 地址不能为空/);
    assert.throws(() => normalizeBaseUrl("   "), /Dockhand 地址不能为空/);
    assert.throws(() => normalizeBaseUrl("ftp://host:3000"), /Dockhand 地址必须是 http 或 https/);
    assert.throws(() => normalizeBaseUrl("dockhand.example.com"), /Dockhand 地址无法解析：relative URL without a base/);
    assert.throws(() => normalizeBaseUrl("http://host:3000/?a=1"), /Dockhand 地址不能带查询参数或锚点/);
    assert.throws(() => normalizeBaseUrl("http://host:3000/#x"), /Dockhand 地址不能带查询参数或锚点/);
    assert.throws(() => normalizeBaseUrl("http://"), /Dockhand 地址无法解析：empty host/);
  });

  it("apiBase：统一追加 /api", () => {
    assert.equal(apiBase("http://host:3000"), "http://host:3000/api");
    assert.equal(apiBase("http://host:3000/dockhand"), "http://host:3000/dockhand/api");
  });

  it("resolveApiPath：相对路径/子路径/剥 /api 前缀/保留 query/拒绝绝对 URL", () => {
    assert.equal(
      resolveApiPath("http://host:3000", "/environments"),
      "http://host:3000/api/environments",
    );
    assert.equal(
      resolveApiPath("http://host:3000", "environments"),
      "http://host:3000/api/environments",
    );
    assert.equal(
      resolveApiPath("http://host:3000", "/api/environments"),
      "http://host:3000/api/environments",
    );
    assert.equal(
      resolveApiPath("http://host:3000/dockhand", "/stacks?env=2"),
      "http://host:3000/dockhand/api/stacks?env=2",
    );
    assert.throws(
      () => resolveApiPath("http://host:3000", "https://evil.example.com/x"),
      /API 路径必须是相对路径（如 \/environments），不接受绝对 URL/,
    );
    assert.throws(() => resolveApiPath("http://host:3000", ""), /API 路径不能为空/);
  });

  it("parseEnvironments：正常行/可选字段缺失/id 缺失跳过/非数组报错", () => {
    assert.deepEqual(
      parseEnvironments([
        { id: 2, name: "[CentOS] 10.0.0.60", host: "10.0.0.60", port: 2375, protocol: "http" },
      ]),
      [
        {
          id: 2,
          name: "[CentOS] 10.0.0.60",
          host: "10.0.0.60",
          port: 2375,
          protocol: "http",
        },
      ],
    );
    assert.deepEqual(parseEnvironments([{ id: 3 }, "junk", null, []]), [
      { id: 3, name: "", host: null, port: null, protocol: null },
    ]);
    assert.deepEqual(parseEnvironments([]), []);
    assert.throws(
      () => parseEnvironments({ id: 2 }),
      (error: Error) => {
        assert.ok(error instanceof DockhandError);
        assert.equal(error.toString(), "Dockhand API: 解析环境列表失败：expected a sequence");
        return true;
      },
    );
  });

  it("describeError：401/403/404/429/其它 hint 与 detail 拼接", () => {
    assert.equal(
      describeError(401, { message: "Unauthorized" }),
      "Unauthorized（token 无效或已过期，请到 Dockhand 生成新的 API Token）",
    );
    assert.match(describeError(403, null), /权限不足：该 API Token 可能缺少管理员权限，或账号未启用/);
    assert.match(describeError(404, null), /接口不存在：请确认填写的是 Dockhand 面板根地址/);
    assert.match(describeError(429, null), /触发 Dockhand 限流，稍后重试/);
    assert.match(describeError(500, null), /请检查 token、实例地址与网络连通性/);
    assert.equal(
      describeError(500, { error: "docker daemon unavailable" }),
      "docker daemon unavailable（请检查 token、实例地址与网络连通性）",
    );
    assert.equal(describeError(500, "plain text"), "plain text（请检查 token、实例地址与网络连通性）");
  });

  it("空 token 拒绝；URL 归一在构造期完成", () => {
    assert.throws(() => new DockhandClient("http://host:3000", "  "), /Dockhand token 不能为空/);
    const client = new DockhandClient("http://host:3000/api/", VALID_TOKEN);
    assert.equal(client.base(), "http://host:3000");
    assert.equal(client.apiBase(), "http://host:3000/api");
  });
});

// ─── 请求行为 ─────────────────────────────────────────────────────────────

describe("DockhandClient 请求行为", () => {
  it("environments：Bearer 头 + Accept/User-Agent，解析环境列表", async () => {
    const mock = await startMock();
    const client = new DockhandClient(`${mock.baseUrl}${mock.subpath}`, VALID_TOKEN);
    const environments = await client.environments();
    assert.deepEqual(environments, [
      {
        id: 2,
        name: "[CentOS] 10.0.0.60",
        host: "10.0.0.60",
        port: 2375,
        protocol: "http",
      },
    ]);
    const request = mock.requests.at(-1)!;
    assert.equal(request.path, "/dockhand/api/environments");
    assert.equal(request.authorization, `Bearer ${VALID_TOKEN}`);
    assert.equal(request.accept, "application/json");
    assert.equal(request.userAgent, "flowlet/0.2.0");
  });

  it("token 无效：401 抛 DockhandError，Display 对齐 Rust", async () => {
    const mock = await startMock();
    const client = new DockhandClient(mock.baseUrl, "wrong-token");
    await assert.rejects(
      () => client.environments(),
      (error: Error) => {
        assert.ok(error instanceof DockhandError);
        assert.equal(error.status, 401);
        assert.equal(
          error.toString(),
          "Dockhand API 401: Unauthorized（token 无效或已过期，请到 Dockhand 生成新的 API Token）",
        );
        return true;
      },
    );
  });

  it("health 不需要 token；system/stacks 带 ?env=<id>", async () => {
    const mock = await startMock();
    const client = new DockhandClient(mock.baseUrl, "wrong-token");
    assert.deepEqual(await client.health(), { status: "ok", timestamp: "2026-11-10T00:00:00Z" });

    const authorized = new DockhandClient(mock.baseUrl, VALID_TOKEN);
    const system = await authorized.system(2);
    assert.equal(
      (system as { docker: { version: string } }).docker.version,
      "27.0.3",
    );
    assert.equal(mock.requests.at(-1)!.path, "/api/system?env=2");
    const stacks = await authorized.stacks(2);
    assert.deepEqual(stacks, [{ name: "flowlet", containers: ["flowlet", "flowlet-egress"] }]);
    assert.equal(mock.requests.at(-1)!.path, "/api/stacks?env=2");
  });

  it("request：透传 method/path/body；空 body 返回 null；非 JSON 原文返回", async () => {
    const mock = await startMock();
    const client = new DockhandClient(mock.baseUrl, VALID_TOKEN);
    const echoed = await client.request("POST", "/echo", { stack: "flowlet" });
    assert.deepEqual(echoed, { method: "POST", body: { stack: "flowlet" } });
    assert.equal(mock.requests.at(-1)!.body, JSON.stringify({ stack: "flowlet" }));

    assert.equal(await client.request("GET", "/empty"), null);
    assert.equal(await client.request("GET", "/text"), "plain text body");
  });

  it("insecure 客户端仍可访问 http mock（TLS 策略只影响 https）", async () => {
    const mock = await startMock();
    const client = new DockhandClient(mock.baseUrl, VALID_TOKEN, { insecure: true });
    assert.equal((await client.environments()).length, 1);
  });

  it("非 2xx 使用 describeError 生成的正文与 status", async () => {
    const mock = await startMock();
    const client = new DockhandClient(mock.baseUrl, VALID_TOKEN);
    await assert.rejects(
      () => client.request("GET", "/boom"),
      (error: Error) => {
        assert.ok(error instanceof DockhandError);
        assert.equal(error.status, 500);
        assert.equal(
          error.message,
          "docker daemon unavailable（请检查 token、实例地址与网络连通性）",
        );
        return true;
      },
    );
  });
});