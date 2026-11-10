// Jenkins 客户端测试。Owner: node-web.
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/jenkins.test.ts
// 覆盖：URL 归一（尾斜杠/保留子路径/不剥 /api /me /api/json/非法 scheme/query 拒绝）、
// resolveApiPath、Basic 头、identity 解析（fullName→id 回退、X-Jenkins 版本）、
// describeError 文案（401/403/404/429/其它、JSON detail、HTML 错误页丢弃）、
// insecure / 透传请求。只访问 127.0.0.1 本地 mock，不访问真实 Jenkins。
import assert from "node:assert/strict";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { after, describe, it } from "node:test";

import {
  authorizationHeader,
  describeError,
  JenkinsClient,
  JenkinsError,
  normalizeBaseUrl,
  parseUsername,
  parseVersion,
  resolveApiPath,
} from "../jenkins.ts";

const USERNAME = "alice";
const VALID_TOKEN = "jenkins-test-fixture-token-1a2b";

function expectedAuthorization(username = USERNAME, token = VALID_TOKEN): string {
  return `Basic ${Buffer.from(`${username}:${token}`, "utf8").toString("base64")}`;
}

// ─── 本地 Jenkins mock（`/me/api/json` 身份端点语义） ──────────────────────

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  accept: string | undefined;
  userAgent: string | undefined;
  body: string;
}

interface JenkinsMockOptions {
  fullName?: unknown;
  id?: unknown;
  /** X-Jenkins 版本；null 表示不返回该头。 */
  version?: string | null;
  /** 身份端点的非 200 状态；默认 200。 */
  identityStatus?: number;
  /** 身份端点的原始响应体；设置后覆盖默认 JSON。 */
  rawBody?: string;
  /** 身份端点的 content-type；HTML 场景用于验证错误页不会被塞进 message。 */
  contentType?: string;
}

class MockJenkins {
  #server: Server | null = null;
  baseUrl = "";
  // 上下文路径部署：所有端点都在 /ci/... 下。
  subpath = "/ci";
  options: JenkinsMockOptions = {};
  requests: RecordedRequest[] = [];

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
      authorization:
        typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
      accept: typeof request.headers.accept === "string" ? request.headers.accept : undefined,
      userAgent:
        typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    const send = (
      status: number,
      value: unknown,
      headers: Record<string, string> = {},
    ): void => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, {
        "content-type": this.options.contentType ?? "application/json",
        "content-length": String(body.length),
        ...headers,
      });
      response.end(body);
    };
    const sendRaw = (status: number, text: string): void => {
      const body = Buffer.from(text, "utf8");
      response.writeHead(status, {
        "content-type": this.options.contentType ?? "text/html; charset=utf-8",
        "content-length": String(body.length),
      });
      response.end(body);
    };

    const suffix = url.pathname.startsWith(this.subpath)
      ? url.pathname.slice(this.subpath.length)
      : url.pathname;
    if (suffix === "/me/api/json") {
      // Jenkins 对 Basic 认证失败返回 401；反向代理可能返回登录页 HTML。
      if (request.headers.authorization !== expectedAuthorization()) {
        if (this.options.rawBody !== undefined) {
          return sendRaw(this.options.identityStatus ?? 401, this.options.rawBody);
        }
        return send(401, { message: "Unauthorized" });
      }
      if (this.options.identityStatus !== undefined && this.options.identityStatus !== 200) {
        if (this.options.rawBody !== undefined) {
          return sendRaw(this.options.identityStatus, this.options.rawBody);
        }
        return send(this.options.identityStatus, { message: "boom" });
      }
      const headers: Record<string, string> =
        this.options.version === null ? {} : { "x-jenkins": this.options.version ?? "2.452.1" };
      if (this.options.rawBody !== undefined) {
        const body = Buffer.from(this.options.rawBody, "utf8");
        response.writeHead(200, {
          "content-type": this.options.contentType ?? "application/json",
          "content-length": String(body.length),
          ...headers,
        });
        response.end(body);
        return;
      }
      return send(
        200,
        {
          id: this.options.id === undefined ? "alice" : this.options.id,
          fullName: this.options.fullName === undefined ? "Alice Wang" : this.options.fullName,
        },
        headers,
      );
    }
    // 透传测试端：回显 method/body。
    if (suffix === "/job/app/api/json") {
      if (request.headers.authorization !== expectedAuthorization()) {
        return send(403, { message: "Forbidden" });
      }
      const text = this.requests.at(-1)?.body ?? "";
      return send(200, {
        method: request.method,
        path: suffix,
        body: text === "" ? null : JSON.parse(text),
      });
    }
    send(404, { message: "404 Not Found" });
  }
}

const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

async function startMock(options: JenkinsMockOptions = {}): Promise<MockJenkins> {
  const mock = new MockJenkins();
  mock.options = options;
  await mock.start();
  return mock;
}

// ─── URL / 解析 / 文案 ────────────────────────────────────────────────────

describe("Jenkins 客户端基础", () => {
  it("normalizeBaseUrl：去尾斜杠/保留子路径/不剥 /api /me /api/json/拒绝非法输入", () => {
    assert.equal(normalizeBaseUrl("https://jenkins.example.com"), "https://jenkins.example.com");
    assert.equal(normalizeBaseUrl("https://jenkins.example.com/"), "https://jenkins.example.com");
    assert.equal(normalizeBaseUrl("  https://jenkins.example.com///  "), "https://jenkins.example.com");
    // Jenkins 上下文路径（子路径部署）必须保留。
    assert.equal(normalizeBaseUrl("https://host/ci/"), "https://host/ci");
    assert.equal(normalizeBaseUrl("http://10.0.0.5:8080"), "http://10.0.0.5:8080");
    // 不自动剥 /api、/me、/api/json：Jenkins 没有统一 /api 前缀。
    assert.equal(normalizeBaseUrl("https://host/ci/me/api/json"), "https://host/ci/me/api/json");
    assert.equal(normalizeBaseUrl("https://host/api/json"), "https://host/api/json");
    assert.equal(normalizeBaseUrl("https://Jenkins.Example.com:443/"), "https://jenkins.example.com");
    assert.throws(() => normalizeBaseUrl(""), /Jenkins 地址不能为空/);
    assert.throws(() => normalizeBaseUrl("   "), /Jenkins 地址不能为空/);
    assert.throws(() => normalizeBaseUrl("ftp://host"), /Jenkins 地址必须是 http 或 https/);
    assert.throws(
      () => normalizeBaseUrl("jenkins.example.com"),
      /Jenkins 地址无法解析：relative URL without a base/,
    );
    assert.throws(() => normalizeBaseUrl("http://"), /Jenkins 地址无法解析：empty host/);
    assert.throws(() => normalizeBaseUrl("https://host/?a=1"), /Jenkins 地址不能带查询参数或锚点/);
    assert.throws(() => normalizeBaseUrl("https://host/#top"), /Jenkins 地址不能带查询参数或锚点/);
  });

  it("resolveApiPath：相对路径/子路径/拒绝绝对 URL", () => {
    assert.equal(resolveApiPath("https://host", "/me/api/json"), "https://host/me/api/json");
    assert.equal(resolveApiPath("https://host/ci", "me/api/json"), "https://host/ci/me/api/json");
    assert.equal(
      resolveApiPath("https://host/ci", "/job/app/api/json"),
      "https://host/ci/job/app/api/json",
    );
    assert.throws(
      () => resolveApiPath("https://host", "https://evil.example.com/x"),
      /API 路径必须是相对路径（如 \/me\/api\/json），不接受绝对 URL/,
    );
    assert.throws(() => resolveApiPath("https://host", "http://evil.example.com/x"), /不接受绝对 URL/);
    assert.throws(() => resolveApiPath("https://host", "  "), /API 路径不能为空/);
  });

  it("authorizationHeader：Basic base64(user:token)，token 特殊字符不丢", () => {
    assert.equal(authorizationHeader("alice", VALID_TOKEN), expectedAuthorization());
    const decode = (header: string): string =>
      Buffer.from(header.replace(/^Basic /, ""), "base64").toString("utf8");
    assert.equal(decode(authorizationHeader("alice", VALID_TOKEN)), `alice:${VALID_TOKEN}`);
    // Basic 认证里冒号是分隔符：用户名中的冒号在保存前已被拒绝，这里确认 token 侧的冒号保留。
    assert.equal(decode(authorizationHeader("alice", "a:b/c?d")), "alice:a:b/c?d");
  });

  it("parseUsername：fullName 优先，空白/非字符串回退 id，缺失为 null", () => {
    assert.equal(parseUsername({ id: "alice", fullName: "Alice Wang" }), "Alice Wang");
    // fullName 是空串/空白/非字符串时回退到 id。
    assert.equal(parseUsername({ id: "alice", fullName: "  " }), "alice");
    assert.equal(parseUsername({ id: "alice", fullName: null }), "alice");
    assert.equal(parseUsername({ id: "alice", fullName: 42 }), "alice");
    assert.equal(parseUsername({ id: "alice" }), "alice");
    assert.equal(parseUsername({ id: 42, fullName: "" }), null);
    assert.equal(parseUsername({}), null);
    assert.equal(parseUsername(null), null);
    assert.equal(parseUsername("not-json"), null);
    assert.equal(parseUsername([{ id: "alice" }]), null);
  });

  it("parseVersion：X-Jenkins trim 后非空，缺失/空白为 null", () => {
    assert.equal(parseVersion(" 2.452.1 "), "2.452.1");
    assert.equal(parseVersion(""), null);
    assert.equal(parseVersion("   "), null);
    assert.equal(parseVersion(null), null);
    assert.equal(parseVersion(undefined), null);
  });

  it("describeError：401/403/404/429/其它 hint 与 JSON detail 拼接，HTML 丢弃", () => {
    assert.equal(
      describeError(401, { message: "Unauthorized" }),
      "Unauthorized（用户名或 API Token 无效，请到 Jenkins 用户设置页确认 API Token）",
    );
    assert.match(describeError(403, null), /权限不足：该 Jenkins 用户可能缺少 Overall\/Read 权限/);
    assert.equal(
      describeError(404, {}),
      "接口不存在：请确认填写的是 Jenkins 根地址（如 https://jenkins.example.com），不要带 /me 或 /api/json",
    );
    assert.equal(describeError(429, null), "触发 Jenkins 限流，稍后重试");
    assert.equal(describeError(500, null), "请检查用户名、token、实例地址与网络连通性");
    assert.equal(
      describeError(500, { error: "boom" }),
      "boom（请检查用户名、token、实例地址与网络连通性）",
    );
    // Rust 语义：message 键存在即采用（即使 null 渲染成 "null"），不回退 error。
    assert.equal(
      describeError(500, { message: null, error: "boom" }),
      "null（请检查用户名、token、实例地址与网络连通性）",
    );
    // HTML 错误页（或任何非 JSON 对象 body）整体丢弃，只留可执行提示。
    const html = describeError(401, "<html><body>login required</body></html>");
    assert.equal(html, "用户名或 API Token 无效，请到 Jenkins 用户设置页确认 API Token");
  });

  it("JenkinsError：带/不带 status 的 Display 对齐 Rust", () => {
    assert.equal(new JenkinsError(401, "Unauthorized").toString(), "Jenkins API 401: Unauthorized");
    assert.equal(
      new JenkinsError(null, "Jenkins 地址不能为空").toString(),
      "Jenkins API: Jenkins 地址不能为空",
    );
    assert.equal(new JenkinsError(401, "x").status, 401);
    assert.equal(new JenkinsError(null, "x").status, null);
  });

  it("构造期校验：空 token/空用户名/地址归一与 trim", () => {
    assert.throws(
      () => new JenkinsClient("https://host", "alice", "  "),
      /Jenkins token 不能为空/,
    );
    // token 优先于用户名校验（与 Rust 分支顺序一致）。
    assert.throws(
      () => new JenkinsClient("https://host", "  ", "  "),
      /Jenkins token 不能为空/,
    );
    assert.throws(
      () => new JenkinsClient("https://host", "  ", VALID_TOKEN),
      /Jenkins 用户名不能为空/,
    );
    assert.throws(
      () => new JenkinsClient("ftp://host", "alice", VALID_TOKEN),
      /Jenkins 地址必须是 http 或 https/,
    );
    const client = new JenkinsClient("  https://jenkins.example.com/ci/  ", "  alice  ", `  ${VALID_TOKEN}  `);
    assert.equal(client.base(), "https://jenkins.example.com/ci");
    assert.equal(client.username(), "alice");
  });
});

// ─── 请求行为 ─────────────────────────────────────────────────────────────

describe("JenkinsClient 请求行为", () => {
  it("identity：Basic 头 + Accept/User-Agent，fullName 与 X-Jenkins 解析", async () => {
    const mock = await startMock();
    const client = new JenkinsClient(`${mock.baseUrl}${mock.subpath}`, USERNAME, VALID_TOKEN);
    assert.deepEqual(await client.identity(), {
      username: "Alice Wang",
      version: "2.452.1",
    });
    const request = mock.requests.at(-1)!;
    assert.equal(request.method, "GET");
    assert.equal(request.path, "/ci/me/api/json");
    assert.equal(request.authorization, expectedAuthorization());
    assert.equal(request.accept, "application/json");
    assert.equal(request.userAgent, "flowlet/0.2.0");
  });

  it("identity：fullName 空白回退 id，X-Jenkins 缺失时 version 为 null", async () => {
    const mock = await startMock({ fullName: "   ", id: "bob", version: null });
    const client = new JenkinsClient(`${mock.baseUrl}${mock.subpath}`, USERNAME, VALID_TOKEN);
    assert.deepEqual(await client.identity(), { username: "bob", version: null });
  });

  it("token 无效：401 抛 JenkinsError，Display 对齐 Rust", async () => {
    const mock = await startMock();
    const client = new JenkinsClient(mock.baseUrl, USERNAME, "wrong-token");
    await assert.rejects(
      () => client.identity(),
      (error: Error) => {
        assert.ok(error instanceof JenkinsError);
        assert.equal(error.status, 401);
        assert.equal(
          error.toString(),
          "Jenkins API 401: Unauthorized（用户名或 API Token 无效，请到 Jenkins 用户设置页确认 API Token）",
        );
        return true;
      },
    );
  });

  it("反向代理返回 HTML 登录页时错误提示不含 HTML 原文", async () => {
    const html = `<!doctype html><html><body><form>login required</form></body></html>`;
    const mock = await startMock({ identityStatus: 401, rawBody: html, contentType: "text/html; charset=utf-8" });
    const client = new JenkinsClient(mock.baseUrl, USERNAME, "wrong-token");
    await assert.rejects(
      () => client.identity(),
      (error: Error) => {
        assert.ok(error instanceof JenkinsError);
        assert.equal(error.status, 401);
        assert.equal(
          error.message,
          "用户名或 API Token 无效，请到 Jenkins 用户设置页确认 API Token",
        );
        assert.ok(!error.message.includes("<html>"));
        return true;
      },
    );
  });

  it("403/404/429 使用对应 hint；JSON message 拼在提示前", async () => {
    const cases: Array<[number, RegExp]> = [
      [403, /权限不足：该 Jenkins 用户可能缺少 Overall\/Read 权限/],
      [404, /接口不存在：请确认填写的是 Jenkins 根地址/],
      [429, /触发 Jenkins 限流，稍后重试/],
    ];
    for (const [status, pattern] of cases) {
      const mock = await startMock({ identityStatus: status, rawBody: JSON.stringify({ message: `err-${status}` }) });
      const client = new JenkinsClient(mock.baseUrl, USERNAME, VALID_TOKEN);
      await assert.rejects(
        () => client.identity(),
        (error: Error) => {
          assert.ok(error instanceof JenkinsError);
          assert.equal(error.status, status);
          assert.match(error.message, pattern);
          assert.match(error.message, new RegExp(`^err-${status}（`));
          return true;
        },
      );
    }
  });

  it("request：透传 method/path/body（子路径拼接）", async () => {
    const mock = await startMock();
    const client = new JenkinsClient(`${mock.baseUrl}${mock.subpath}`, USERNAME, VALID_TOKEN);
    const echoed = await client.request("POST", "/job/app/api/json", { parameter: [{ name: "BRANCH", value: "main" }] });
    assert.deepEqual(echoed, {
      method: "POST",
      path: "/job/app/api/json",
      body: { parameter: [{ name: "BRANCH", value: "main" }] },
    });
    assert.equal(mock.requests.at(-1)!.body, JSON.stringify({ parameter: [{ name: "BRANCH", value: "main" }] }));
    await assert.rejects(
      () => client.request("GET", "https://evil.example.com/x"),
      (error: Error) => {
        assert.ok(error instanceof JenkinsError);
        assert.equal(error.status, null);
        assert.match(error.toString(), /^Jenkins API: API 路径必须是相对路径/);
        return true;
      },
    );
  });

  it("insecure 客户端仍可访问 http mock（TLS 策略只影响 https）", async () => {
    const mock = await startMock();
    const client = new JenkinsClient(mock.baseUrl, USERNAME, VALID_TOKEN, { insecure: true });
    assert.equal((await client.identity()).username, "Alice Wang");
    assert.equal(client.withInsecure(false).base(), mock.baseUrl);
  });
});
