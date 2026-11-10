// Beszel 客户端测试。Owner: node-web.
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/beszel.test.ts
// 覆盖：地址归一（尾斜杠/剥 /api /_ /_/、保留子路径、非法 scheme/query 拒绝）、
// resolveApiPath（/api 前缀、query 保留、绝对 URL 拒绝）、auth 交换 token（PocketBase
// `Authorization: <token>` 不带 Bearer）、info 版本、systems 投影与分页参数、
// describeError 文案（auth 400 / 401 / 403 / 404 / 429 / 其它）、token 缓存与透传请求、
// insecure。只访问 127.0.0.1 本地 mock，不访问真实 Beszel。
import assert from "node:assert/strict";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { after, describe, it } from "node:test";

import {
  BeszelClient,
  BeszelError,
  describeError,
  normalizeBaseUrl,
  parseAuth,
  parseSystems,
  parseVersion,
  resolveApiPath,
} from "../beszel.ts";

const EMAIL = "ops@example.com";
const PASSWORD = "beszel-test-fixture-password-7a6b";
const TOKEN = "pb-fixture-token-1a2b3c";
const VERSION = "0.21.1";

// ─── 本地 Beszel/PocketBase mock ────────────────────────────────────────────

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  accept: string | undefined;
  userAgent: string | undefined;
  contentType: string | undefined;
  body: string;
}

interface BeszelMockOptions {
  /** token 校验值；info/systems 会用客户端拿到的 token 比对。 */
  token?: string;
  /** 子路径部署：所有端点都在该前缀下（默认根路径）。 */
  subpath?: string;
  /** auth 端点状态；默认按邮箱/密码正确与否返回 200/400。 */
  authStatus?: number;
  authMessage?: string;
  /** info 的 v；null 表示响应体不含 v。 */
  version?: string | null;
  /** info 端点状态；默认 200。 */
  infoStatus?: number;
  /** systems 原始响应体；设置后覆盖默认 page。 */
  systemsBody?: unknown;
  systemsStatus?: number;
}

class MockBeszel {
  #server: Server | null = null;
  baseUrl = "";
  options: BeszelMockOptions = {};
  requests: RecordedRequest[] = [];
  authCount = 0;

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
    const body = Buffer.concat(chunks).toString("utf8");
    this.requests.push({
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      authorization:
        typeof request.headers.authorization === "string"
          ? request.headers.authorization
          : undefined,
      accept: typeof request.headers.accept === "string" ? request.headers.accept : undefined,
      userAgent:
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"]
          : undefined,
      contentType:
        typeof request.headers["content-type"] === "string"
          ? request.headers["content-type"]
          : undefined,
      body,
    });
    const send = (status: number, value: unknown): void => {
      const payload = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(payload.length),
      });
      response.end(payload);
    };
    const expectedToken = this.options.token ?? TOKEN;
    const authorized = request.headers.authorization === expectedToken;
    const subpath = this.options.subpath ?? "";
    const path = subpath !== "" && url.pathname.startsWith(subpath)
      ? url.pathname.slice(subpath.length)
      : url.pathname;

    if (path === "/api/collections/users/auth-with-password") {
      this.authCount += 1;
      if (this.options.authStatus !== undefined && this.options.authStatus !== 200) {
        return send(this.options.authStatus, {
          code: this.options.authStatus,
          message: this.options.authMessage ?? "boom",
        });
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const row = (parsed ?? {}) as Record<string, unknown>;
      if (row.identity !== EMAIL || row.password !== PASSWORD) {
        // PocketBase 对错误凭据返回 400（不是 401）。
        return send(400, { code: 400, message: "Failed to authenticate." });
      }
      return send(200, {
        token: expectedToken,
        record: { id: "user-1", email: EMAIL, name: "Ops", role: "admin" },
      });
    }
    if (path === "/api/beszel/info") {
      if (!authorized) return send(401, { code: 401, message: "Unauthorized" });
      if (this.options.infoStatus !== undefined && this.options.infoStatus !== 200) {
        return send(this.options.infoStatus, { code: this.options.infoStatus, message: "info-boom" });
      }
      return send(
        200,
        this.options.version === null ? { publicKey: "x" } : { v: this.options.version ?? VERSION },
      );
    }
    if (path === "/api/collections/systems/records") {
      if (!authorized) return send(401, { code: 401, message: "Unauthorized" });
      if (this.options.systemsStatus !== undefined && this.options.systemsStatus !== 200) {
        return send(this.options.systemsStatus, {
          code: this.options.systemsStatus,
          message: "systems-boom",
        });
      }
      if (this.options.systemsBody !== undefined) return send(200, this.options.systemsBody);
      const perPage = Number(url.searchParams.get("perPage") ?? "0");
      return send(200, {
        page: 1,
        perPage,
        totalItems: 3,
        totalPages: 1,
        items: [
          { id: "sys-1", name: "prod-1", host: "10.0.0.1", status: "up", port: "45876" },
          // port 缺失 → 投影为空串。
          { id: "sys-2", name: "prod-2", host: "10.0.0.2", status: "down" },
        ],
      });
    }
    // 透传测试端：回显 method/path/body。
    if (path.startsWith("/api/collections/echo")) {
      if (!authorized) return send(401, { code: 401, message: "Unauthorized" });
      return send(200, {
        method: request.method,
        path,
        body: body === "" ? null : JSON.parse(body),
      });
    }
    send(404, { code: 404, message: "404 Not Found" });
  }
}

const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

async function startMock(options: BeszelMockOptions = {}): Promise<MockBeszel> {
  const mock = new MockBeszel();
  mock.options = options;
  await mock.start();
  return mock;
}

// ─── URL / 解析 / 文案 ────────────────────────────────────────────────────

describe("Beszel 客户端基础", () => {
  it("normalizeBaseUrl：剥尾斜杠 / /api / /_ / /_/，保留子路径，拒绝非法输入", () => {
    assert.equal(normalizeBaseUrl("http://10.1.1.1:8090"), "http://10.1.1.1:8090");
    assert.equal(normalizeBaseUrl("  http://10.1.1.1:8090///  "), "http://10.1.1.1:8090");
    // 用户可能粘贴 Hub API 前缀或 PocketBase 管理面板地址。
    assert.equal(normalizeBaseUrl("http://10.1.1.1:8090/api"), "http://10.1.1.1:8090");
    assert.equal(normalizeBaseUrl("http://10.1.1.1:8090/api/"), "http://10.1.1.1:8090");
    assert.equal(normalizeBaseUrl("http://10.1.1.1:8090/_/"), "http://10.1.1.1:8090");
    assert.equal(normalizeBaseUrl("http://10.1.1.1:8090/_"), "http://10.1.1.1:8090");
    // 反复剥：/api → /_，直到根地址。
    assert.equal(normalizeBaseUrl("http://host:8090/_/api/"), "http://host:8090");
    assert.equal(normalizeBaseUrl("https://beszel.example.com/api/api"), "https://beszel.example.com");
    // 子路径部署必须保留。
    assert.equal(normalizeBaseUrl("https://host/monitor/"), "https://host/monitor");
    assert.equal(normalizeBaseUrl("https://host/monitor/_/"), "https://host/monitor");
    // 与 /api 形近但不是后缀的路径不剥。
    assert.equal(normalizeBaseUrl("https://host/apix"), "https://host/apix");
    assert.equal(normalizeBaseUrl("https://Beszel.Example.com:443/"), "https://beszel.example.com");
    assert.throws(() => normalizeBaseUrl(""), /Beszel 地址不能为空/);
    assert.throws(() => normalizeBaseUrl("   "), /Beszel 地址不能为空/);
    assert.throws(() => normalizeBaseUrl("ftp://host"), /Beszel 地址必须是 http 或 https/);
    assert.throws(
      () => normalizeBaseUrl("beszel.example.com"),
      /Beszel 地址无法解析：relative URL without a base/,
    );
    assert.throws(() => normalizeBaseUrl("http://"), /Beszel 地址无法解析：empty host/);
    assert.throws(
      () => normalizeBaseUrl("https://host:8090/?a=1"),
      /Beszel 地址不能带查询参数或锚点/,
    );
    assert.throws(
      () => normalizeBaseUrl("https://host:8090/#top"),
      /Beszel 地址不能带查询参数或锚点/,
    );
  });

  it("resolveApiPath：/api 前缀只剥一层、query 保留、绝对 URL 拒绝", () => {
    assert.equal(
      resolveApiPath("http://host:8090", "/collections/systems/records"),
      "http://host:8090/api/collections/systems/records",
    );
    assert.equal(
      resolveApiPath("http://host:8090", "/api/collections/systems/records"),
      "http://host:8090/api/collections/systems/records",
    );
    assert.equal(
      resolveApiPath("http://host:8090", "collections/systems/records?perPage=1&sort=name"),
      "http://host:8090/api/collections/systems/records?perPage=1&sort=name",
    );
    assert.equal(
      resolveApiPath("https://host/monitor", "/beszel/info"),
      "https://host/monitor/api/beszel/info",
    );
    assert.throws(
      () => resolveApiPath("http://host", "https://evil.example.com/x"),
      /API 路径必须是相对路径（如 \/collections\/systems\/records），不接受绝对 URL/,
    );
    assert.throws(() => resolveApiPath("http://host", "  "), /API 路径不能为空/);
  });

  it("BeszelError：带/不带 status 的 Display 对齐 Rust", () => {
    assert.equal(new BeszelError(400, "Failed").toString(), "Beszel API 400: Failed");
    assert.equal(
      new BeszelError(null, "Beszel 地址不能为空").toString(),
      "Beszel API: Beszel 地址不能为空",
    );
    assert.equal(new BeszelError(401, "x").status, 401);
    assert.equal(new BeszelError(null, "x").status, null);
    assert.ok(new BeszelError(400, "x") instanceof Error);
  });

  it("describeError：auth 400 与其它 400 提示不同，401/403/404/429 各有 hint", () => {
    assert.equal(
      describeError(400, { message: "Failed to authenticate." }, { auth: true }),
      "Failed to authenticate.（邮箱或密码错误，请确认是 Beszel 用户账号（不是 PocketBase 超级管理员））",
    );
    // 非 auth 端点的 400 走通用网络/配置提示。
    assert.equal(
      describeError(400, null),
      "请检查邮箱、密码、实例地址与网络连通性",
    );
    assert.equal(
      describeError(401, { message: "Unauthorized" }),
      "Unauthorized（token 无效或已过期，请重新用邮箱+密码登录）",
    );
    assert.equal(
      describeError(403, null),
      "密码登录可能被禁用（DISABLE_PASSWORD_AUTH），或账号没有读取权限",
    );
    assert.equal(
      describeError(404, {}),
      "接口不存在：请确认填写的是 Beszel Hub 根地址（默认端口 8090）",
    );
    assert.equal(describeError(429, null), "触发 Beszel 限流，稍后重试");
    assert.equal(describeError(500, null), "请检查邮箱、密码、实例地址与网络连通性");
    // error 兜底字段。
    assert.equal(
      describeError(500, { error: "boom" }),
      "boom（请检查邮箱、密码、实例地址与网络连通性）",
    );
    // 非 JSON 响应（反向代理错误页）按原文作为 detail。
    assert.equal(
      describeError(502, "<html>bad gateway</html>"),
      "<html>bad gateway</html>（请检查邮箱、密码、实例地址与网络连通性）",
    );
  });

  it("parseAuth / parseVersion / parseSystems：缺失字段容错", () => {
    assert.deepEqual(
      parseAuth({
        token: TOKEN,
        record: { email: EMAIL, name: "Ops", role: "admin" },
      }),
      { token: TOKEN, email: EMAIL, name: "Ops", role: "admin" },
    );
    assert.deepEqual(parseAuth({ token: TOKEN }), {
      token: TOKEN,
      email: null,
      name: null,
      role: null,
    });
    assert.throws(
      () => parseAuth({ record: {} }),
      (error: Error) => {
        assert.ok(error instanceof BeszelError);
        assert.equal(error.status, null);
        assert.equal(error.message, "解析认证响应失败：缺少 token");
        return true;
      },
    );
    assert.throws(() => parseAuth(null), /解析认证响应失败：缺少 token/);

    assert.equal(parseVersion({ v: " 0.21.1 " }), "0.21.1");
    assert.equal(parseVersion({}), null);
    assert.equal(parseVersion(null), null);
    assert.equal(parseVersion("0.21.1"), null);

    const page = parseSystems({
      page: 1,
      perPage: 200,
      totalItems: 2,
      totalPages: 1,
      items: [
        { id: "a", name: "prod", host: "10.0.0.1", status: "up", port: "45876" },
        { id: "b" },
        "not-a-row",
      ],
    });
    assert.equal(page.totalItems, 2);
    assert.deepEqual(page.items, [
      { id: "a", name: "prod", host: "10.0.0.1", status: "up", port: "45876" },
      { id: "b", name: "", host: "", status: "", port: "" },
    ]);
    assert.throws(
      () => parseSystems({ items: {} }),
      /解析系统列表失败：expected a sequence/,
    );
    assert.throws(
      () => parseSystems({}),
      /解析系统列表失败：expected a sequence/,
    );
  });

  it("构造期校验：密码优先、邮箱必填、地址归一与 trim", () => {
    assert.throws(
      () => new BeszelClient("http://host:8090", "", ""),
      /Beszel 密码不能为空/,
    );
    assert.throws(
      () => new BeszelClient("http://host:8090", "  ", PASSWORD),
      /Beszel 邮箱不能为空/,
    );
    assert.throws(
      () => new BeszelClient("http://host:8090", EMAIL, "   "),
      /Beszel 密码不能为空/,
    );
    assert.throws(
      () => new BeszelClient("ftp://host", EMAIL, PASSWORD),
      /Beszel 地址必须是 http 或 https/,
    );
    const client = new BeszelClient("  http://host:8090/api/  ", `  ${EMAIL}  `, `  ${PASSWORD}  `);
    assert.equal(client.base(), "http://host:8090");
    assert.equal(client.email(), EMAIL);
    assert.equal(client.token(), null);
  });
});

// ─── 请求行为 ─────────────────────────────────────────────────────────────

describe("BeszelClient 请求行为", () => {
  it("auth：POST identity/password 换 token，响应投影为 auth 结构", async () => {
    const mock = await startMock();
    const client = new BeszelClient(mock.baseUrl, EMAIL, PASSWORD);
    assert.deepEqual(await client.auth(), {
      token: TOKEN,
      email: EMAIL,
      name: "Ops",
      role: "admin",
    });
    const request = mock.requests.at(-1)!;
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/api/collections/users/auth-with-password");
    assert.equal(request.authorization, undefined);
    assert.equal(request.accept, "application/json");
    assert.equal(request.userAgent, "flowlet/0.2.0");
    assert.equal(request.contentType, "application/json");
    assert.deepEqual(JSON.parse(request.body), { identity: EMAIL, password: PASSWORD });
    // token 缓存在实例内。
    assert.equal(client.token(), TOKEN);
  });

  it("auth 失败：PocketBase 400 → BeszelError 400，文案带邮箱/密码提示", async () => {
    const mock = await startMock();
    const client = new BeszelClient(mock.baseUrl, "other@example.com", "wrong-password");
    await assert.rejects(
      () => client.auth(),
      (error: Error) => {
        assert.ok(error instanceof BeszelError);
        assert.equal(error.status, 400);
        assert.equal(
          error.toString(),
          "Beszel API 400: Failed to authenticate.（邮箱或密码错误，请确认是 Beszel 用户账号（不是 PocketBase 超级管理员））",
        );
        return true;
      },
    );
    assert.equal(client.token(), null);
  });

  it("version：认证后 Authorization 为 PocketBase 原生 token（不带 Bearer）", async () => {
    const mock = await startMock();
    const client = new BeszelClient(mock.baseUrl, EMAIL, PASSWORD);
    assert.equal(await client.info(), VERSION);
    assert.equal(mock.authCount, 1);
    const infoRequest = mock.requests.at(-1)!;
    assert.equal(infoRequest.path, "/api/beszel/info");
    assert.equal(infoRequest.authorization, TOKEN);
    assert.ok(!String(infoRequest.authorization).startsWith("Bearer "));
    // 已认证的客户端不会重复 auth。
    await client.systems(1);
    assert.equal(mock.authCount, 1);
  });

  it("version：响应缺少 v 时返回 null（版本不是校验必要条件）", async () => {
    const mock = await startMock({ version: null });
    const client = new BeszelClient(mock.baseUrl, EMAIL, PASSWORD);
    assert.equal(await client.info(), null);
  });

  it("systems：分页/排序/fields 参数与 items 投影", async () => {
    const mock = await startMock();
    const client = new BeszelClient(mock.baseUrl, EMAIL, PASSWORD);
    const page = await client.systems();
    assert.equal(page.totalItems, 3);
    assert.equal(page.page, 1);
    assert.equal(page.perPage, 200);
    assert.deepEqual(page.items, [
      { id: "sys-1", name: "prod-1", host: "10.0.0.1", status: "up", port: "45876" },
      { id: "sys-2", name: "prod-2", host: "10.0.0.2", status: "down", port: "" },
    ]);
    const request = mock.requests.at(-1)!;
    const url = new URL(request.path, "http://localhost");
    assert.equal(url.pathname, "/api/collections/systems/records");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("perPage"), "200");
    assert.equal(url.searchParams.get("sort"), "name");
    assert.equal(url.searchParams.get("fields"), "id,name,host,status,port");
    assert.equal(request.authorization, TOKEN);

    // 校验只看 totalItems，用 perPage=1。
    await client.systems(1);
    assert.equal(
      new URL(mock.requests.at(-1)!.path, "http://localhost").searchParams.get("perPage"),
      "1",
    );
  });

  it("systems：items 非数组抛描述性错误，401 走 token 提示", async () => {
    const bad = await startMock({ systemsBody: { totalItems: 0, items: null } });
    const client = new BeszelClient(bad.baseUrl, EMAIL, PASSWORD);
    await assert.rejects(
      () => client.systems(),
      (error: Error) => {
        assert.ok(error instanceof BeszelError);
        assert.equal(error.status, null);
        assert.equal(error.message, "解析系统列表失败：expected a sequence");
        return true;
      },
    );

    const denied = await startMock({ systemsStatus: 401 });
    const deniedClient = new BeszelClient(denied.baseUrl, EMAIL, PASSWORD);
    await assert.rejects(
      () => deniedClient.systems(),
      (error: Error) => {
        assert.ok(error instanceof BeszelError);
        assert.equal(error.status, 401);
        assert.match(error.toString(), /^Beszel API 401: systems-boom（token 无效或已过期/);
        return true;
      },
    );
  });

  it("request：先认证再透传，token 复用且子路径部署路径正确", async () => {
    const mock = await startMock({ subpath: "/monitor" });
    const client = new BeszelClient(`${mock.baseUrl}/monitor`, EMAIL, PASSWORD);
    const echoed = await client.request("POST", "/collections/echo?x=1", { hello: "world" });
    assert.deepEqual(echoed, {
      method: "POST",
      path: "/api/collections/echo",
      body: { hello: "world" },
    });
    assert.equal(mock.authCount, 1);
    assert.equal(mock.requests[0]!.path, "/monitor/api/collections/users/auth-with-password");
    const passthrough = mock.requests.at(-1)!;
    assert.equal(passthrough.path, "/monitor/api/collections/echo?x=1");
    assert.equal(passthrough.authorization, TOKEN);

    // 第二次透传仍复用同一个 token。
    await client.request("GET", "/api/collections/echo");
    assert.equal(mock.authCount, 1);

    await assert.rejects(
      () => client.request("GET", "https://evil.example.com/x"),
      (error: Error) => {
        assert.ok(error instanceof BeszelError);
        assert.equal(error.status, null);
        assert.match(error.toString(), /^Beszel API: API 路径必须是相对路径/);
        return true;
      },
    );
  });

  it("网络错误：包成 BeszelError 并带 --insecure 提示", async () => {
    const client = new BeszelClient("http://127.0.0.1:1", EMAIL, PASSWORD);
    await assert.rejects(
      () => client.auth(),
      (error: Error) => {
        assert.ok(error instanceof BeszelError);
        assert.equal(error.status, null);
        assert.match(error.toString(), /^Beszel API: 请求 http:\/\/127\.0\.0\.1:1\/api\/collections\/users\/auth-with-password 失败：/);
        assert.match(error.message, /内网自签证书请加 --insecure/);
        return true;
      },
    );
  });

  it("insecure 客户端仍可访问 http mock（TLS 策略只影响 https）", async () => {
    const mock = await startMock();
    const client = new BeszelClient(mock.baseUrl, EMAIL, PASSWORD, { insecure: true });
    assert.equal((await client.auth()).token, TOKEN);
    assert.equal(client.withInsecure(false).base(), mock.baseUrl);
  });
});