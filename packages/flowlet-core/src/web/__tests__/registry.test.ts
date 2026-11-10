// OCI 镜像仓库（Registry V2）客户端测试。Owner: node-web.
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/registry.test.ts
// 覆盖：地址归一（补 scheme/尾斜杠//v2 清洗/路径与 query 拒绝/缺少主机名）、host 提取、
// 用户名规则（必填/长度/冒号空白控制字符/robot account 字符）、Basic 直接 200、
// 401 Bearer 质询 → token 换发 → Bearer 重试 200（版本头优先级）、token 401/403、
// token 200 无 token、403/404/429/其它状态映射、网络错误、不做 Harbor 专属探测。
// 只访问 127.0.0.1 本地 mock，不访问真实镜像仓库。
import assert from "node:assert/strict";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { after, describe, it } from "node:test";

import {
  basicAuthorization,
  checkRegistry,
  normalizeRegistryUrl,
  normalizeRegistryUsername,
  parseRegistryChallenge,
  registryHost,
  RegistryError,
} from "../registry.ts";

const USERNAME = "robot$project+name";
const PASSWORD = "registry-fixture-password-9a8b";
const TOKEN = "registry-fixture-bearer-token-7c6d";
const SERVICE = "registry.example.com";
const SCOPE = "repository:library/nginx:pull";

// ─── Mock Registry V2（`/v2/` + token 端点） ─────────────────────────────

interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  accept: string | undefined;
  userAgent: string | undefined;
}

class MockRegistry {
  #server: Server | null = null;
  baseUrl = "";
  /** 直接覆盖 `/v2/` 的响应状态（用于 403/404/429/500 映射测试）。 */
  apiStatus: number | null = null;
  apiHeaders: Record<string, string> = {};
  /** open：任何 /v2/ 请求都成功；bearer：未带有效 Bearer 时返回 401 质询。 */
  authorizeMode: "open" | "bearer" = "open";
  /** `/v2/` 成功响应（或 Bearer 重试成功）里的版本头；null 表示不返回该头。 */
  version: string | null = "registry/2.0";
  /** Bearer 重试成功时的版本头；null 表示沿用 `version`。 */
  retryVersion: string | null = null;
  /** Bearer 重试状态（默认 200）。 */
  retryStatus = 200;
  /** 自定义 `WWW-Authenticate`；null 表示使用默认 Bearer 质询。 */
  challengeHeader: string | null = null;
  includeService = true;
  includeScope = true;
  tokenStatus = 200;
  tokenHeaders: Record<string, string> = {};
  tokenBody: unknown = { token: TOKEN };
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

  /** 默认 Bearer 质询：realm 指向本 mock 的 /token，service/scope 按开关拼接。 */
  bearerChallenge(): string {
    const parts = [`Bearer realm="${this.baseUrl}/token"`];
    if (this.includeService) parts.push(`service="${SERVICE}"`);
    if (this.includeScope) parts.push(`scope="${SCOPE}"`);
    return parts.join(",");
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    this.requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      authorization:
        typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
      accept: typeof request.headers.accept === "string" ? request.headers.accept : undefined,
      userAgent:
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"]
          : undefined,
    });
    const send = (
      status: number,
      body: string,
      headers: Record<string, string> = {},
    ): void => {
      const payload = Buffer.from(body, "utf8");
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(payload.length),
        ...headers,
      });
      response.end(payload);
    };
    const versionHeaders = (value: string | null): Record<string, string> =>
      value === null ? {} : { "docker-distribution-api-version": value };

    if (url.pathname === "/v2/") {
      if (this.apiStatus !== null) return send(this.apiStatus, "{}", this.apiHeaders);
      if (this.authorizeMode === "open") {
        return send(200, "{}", versionHeaders(this.version));
      }
      if (request.headers.authorization === `Bearer ${TOKEN}`) {
        if (this.retryStatus < 200 || this.retryStatus >= 300) {
          return send(this.retryStatus, "{}");
        }
        return send(200, "{}", versionHeaders(this.retryVersion ?? this.version));
      }
      return send(401, "", {
        "www-authenticate": this.challengeHeader ?? this.bearerChallenge(),
      });
    }
    if (url.pathname === "/token") {
      return send(this.tokenStatus, JSON.stringify(this.tokenBody), this.tokenHeaders);
    }
    send(404, "{}");
  }
}

const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

async function startMock(): Promise<MockRegistry> {
  const mock = new MockRegistry();
  await mock.start();
  return mock;
}

// ─── 地址归一 ─────────────────────────────────────────────────────────────

describe("registry 地址归一", () => {
  it("normalizeRegistryUrl：补 https/去尾斜杠/清洗 /v2/保留端口", () => {
    assert.equal(normalizeRegistryUrl("https://hub.example.com"), "https://hub.example.com");
    assert.equal(normalizeRegistryUrl("hub.example.com"), "https://hub.example.com");
    assert.equal(normalizeRegistryUrl("  hub.example.com/  "), "https://hub.example.com");
    assert.equal(normalizeRegistryUrl("https://hub.example.com///"), "https://hub.example.com");
    // 从文档粘贴的 /v2、/v2/ 要清洗掉，而不是当成路径。
    assert.equal(normalizeRegistryUrl("https://hub.example.com/v2"), "https://hub.example.com");
    assert.equal(normalizeRegistryUrl("https://hub.example.com/v2/"), "https://hub.example.com");
    assert.equal(normalizeRegistryUrl("https://hub.example.com/v2//"), "https://hub.example.com");
    // 端口保留（未显式写默认端口），默认端口由 URL 归一自然去掉。
    assert.equal(normalizeRegistryUrl("http://10.1.1.1:5000"), "http://10.1.1.1:5000");
    assert.equal(normalizeRegistryUrl("10.1.1.1:5000"), "https://10.1.1.1:5000");
    assert.equal(normalizeRegistryUrl("https://Hub.Example.com:443/"), "https://hub.example.com");
    // 没有 scheme 但带路径依然按路径报错（不能静默吞掉）。
    assert.throws(
      () => normalizeRegistryUrl("hub.example.com/repo"),
      /镜像仓库地址只能是主机（可带端口），不能包含路径/,
    );
  });

  it("normalizeRegistryUrl：各错误文案逐字对齐契约 §2", () => {
    assert.throws(() => normalizeRegistryUrl(""), /^Error: 镜像仓库地址不能为空$/);
    assert.throws(() => normalizeRegistryUrl("   "), /镜像仓库地址不能为空/);
    assert.throws(
      () => normalizeRegistryUrl("ftp://hub.example.com"),
      /镜像仓库地址必须是 http 或 https/,
    );
    assert.throws(
      () => normalizeRegistryUrl("https://hub.example.com/?a=1"),
      /镜像仓库地址不能带查询参数或锚点/,
    );
    assert.throws(
      () => normalizeRegistryUrl("https://hub.example.com/#top"),
      /镜像仓库地址不能带查询参数或锚点/,
    );
    assert.throws(
      () => normalizeRegistryUrl("https://hub.example.com/repo"),
      /镜像仓库地址只能是主机（可带端口），不能包含路径/,
    );
    assert.throws(
      () => normalizeRegistryUrl("https://hub.example.com/v2/extra"),
      /镜像仓库地址只能是主机（可带端口），不能包含路径/,
    );
    // Harbor 的 /api/v2.0 也只是路径，绝不猜测或探测。
    assert.throws(
      () => normalizeRegistryUrl("https://hub.example.com/api/v2.0"),
      /镜像仓库地址只能是主机（可带端口），不能包含路径/,
    );
    // 空主机：与 Rust `Url::parse` 的 empty host 对齐成契约 §2 的「缺少主机名」。
    assert.throws(() => normalizeRegistryUrl("https://"), /镜像仓库地址缺少主机名/);
    assert.throws(() => normalizeRegistryUrl("http://"), /镜像仓库地址缺少主机名/);
    assert.throws(
      () => normalizeRegistryUrl("https://hub.example.com:bad-port"),
      /镜像仓库地址无法解析：invalid URL/,
    );
  });

  it("registryHost：去 scheme/去路径，保留 host[:port]", () => {
    assert.equal(registryHost("https://hub.example.com"), "hub.example.com");
    assert.equal(registryHost("http://10.1.1.1:5000"), "10.1.1.1:5000");
    assert.equal(registryHost("hub.example.com:5000"), "hub.example.com:5000");
    assert.equal(registryHost("https://hub.example.com/v2/"), "hub.example.com");
    assert.equal(registryHost("  https://hub.example.com  "), "hub.example.com");
    assert.equal(registryHost(""), "");
    // 脏数据不抛错（envKeys 不该因旧行失败）。
    assert.equal(registryHost("https://"), "");
    assert.equal(registryHost("::bad"), "::bad");
  });

  it("RegistryError：Display 直接输出契约文案（与 Rust/CLI 逐字一致）", () => {
    assert.equal(new RegistryError(401, "x").toString(), "x");
    assert.equal(new RegistryError(null, "y").toString(), "y");
    assert.equal(new RegistryError(403, "z").status, 403);
    assert.equal(new RegistryError(null, "y").status, null);
  });
});

// ─── 用户名规则（契约 §3） ────────────────────────────────────────────────

describe("registry 用户名规则", () => {
  it("必填：trim 后为空且无原值 → 契约文案；编辑时回退原值", () => {
    assert.throws(
      () => normalizeRegistryUsername("", null),
      /^Error: 镜像仓库需要填写用户名（docker login 需要用户名 \+ 密码\/token）$/,
    );
    assert.throws(
      () => normalizeRegistryUsername("   ", ""),
      /镜像仓库需要填写用户名（docker login 需要用户名 \+ 密码\/token）/,
    );
    // 编辑时传空表示保留原值（与 Jenkins 一致）。
    assert.equal(normalizeRegistryUsername("", "robot$old+name"), "robot$old+name");
    assert.equal(normalizeRegistryUsername(undefined, "  robot$old  "), "robot$old");
  });

  it("长度 ≤ 255 个 Unicode 字符（不是字节）", () => {
    assert.equal(normalizeRegistryUsername("a".repeat(255), null), "a".repeat(255));
    assert.throws(() => normalizeRegistryUsername("a".repeat(256), null), /用户名不能超过 255 个字符/);
    assert.equal(normalizeRegistryUsername("用".repeat(255), null), "用".repeat(255));
    assert.throws(() => normalizeRegistryUsername("用".repeat(256), null), /用户名不能超过 255 个字符/);
  });

  it("不能含冒号/空白/控制字符；明确允许 $ + _ -", () => {
    for (const bad of ["al:ice", "al ice", "al\tice", "al\u0001ice", "al\u007fice"]) {
      assert.throws(
        () => normalizeRegistryUsername(bad, null),
        /用户名不能包含冒号、空格或控制字符/,
      );
    }
    // Harbor robot account 形如 `robot$project+name`，必须放行。
    for (const good of ["robot$project+name", "a_b-c.d", "robot$flowlet+pull"]) {
      assert.equal(normalizeRegistryUsername(`  ${good}  `, null), good);
    }
  });
});

// ─── WWW-Authenticate 解析 ────────────────────────────────────────────────

describe("WWW-Authenticate 解析", () => {
  it("Bearer：realm/service/scope 支持引号与转义；Basic/缺失 → 非 Bearer", () => {
    assert.deepEqual(
      parseRegistryChallenge(
        `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="${SCOPE}"`,
      ),
      { scheme: "bearer", realm: "https://auth.docker.io/token", service: "registry.docker.io", scope: SCOPE },
    );
    // 参数顺序无关、引号可省、大小写不敏感。
    assert.deepEqual(
      parseRegistryChallenge(`bearer scope=${SCOPE}, realm="https://auth/token"`),
      { scheme: "bearer", realm: "https://auth/token", service: null, scope: SCOPE },
    );
    // 转义引号。
    assert.equal(
      parseRegistryChallenge('Bearer realm="https://auth/token", error="a\\"b"').realm,
      "https://auth/token",
    );
    assert.deepEqual(parseRegistryChallenge('Basic realm="registry"'), {
      scheme: "basic",
      realm: null,
      service: null,
      scope: null,
    });
    assert.deepEqual(parseRegistryChallenge(null), { scheme: "", realm: null, service: null, scope: null });
    assert.deepEqual(parseRegistryChallenge("   "), { scheme: "", realm: null, service: null, scope: null });
    // Bearer 但缺 realm：交给 checkRegistry 报「质询无法解析」。
    assert.equal(parseRegistryChallenge('Bearer service="x"').realm, null);
  });
});

// ─── 校验算法（契约 §4） ──────────────────────────────────────────────────

describe("checkRegistry 校验算法", () => {
  it("Basic 直接 200：返回入参用户名与 docker-distribution-api-version", async () => {
    const mock = await startMock();
    const result = await checkRegistry(mock.baseUrl, USERNAME, PASSWORD, false);
    assert.deepEqual(result, {
      ok: true,
      username: USERNAME,
      version: "registry/2.0",
      detail: null,
      error: null,
    });
    const request = mock.requests[0]!;
    assert.equal(request.method, "GET");
    assert.equal(request.path, "/v2/");
    assert.equal(request.authorization, basicAuthorization(USERNAME, PASSWORD));
    assert.equal(request.accept, "application/json");
    assert.equal(request.userAgent, "flowlet/0.2.0");
  });

  it("版本头缺失 → version 为 null；不伪造版本", async () => {
    const mock = await startMock();
    mock.version = null;
    const result = await checkRegistry(mock.baseUrl, USERNAME, PASSWORD, false);
    assert.equal(result.ok, true);
    assert.equal(result.version, null);
  });

  it("入参用户名 trim 后用于 Basic 认证与返回值", async () => {
    const mock = await startMock();
    const result = await checkRegistry(mock.baseUrl, "  robot$edge  ", PASSWORD, false);
    assert.equal(result.username, "robot$edge");
    assert.equal(mock.requests[0]!.authorization, basicAuthorization("robot$edge", PASSWORD));
  });

  it("401 Bearer 质询 → Basic 换 token → Bearer 重试 200（版本头重试优先）", async () => {
    const mock = await startMock();
    mock.authorizeMode = "bearer";
    mock.version = "registry/2.0";
    mock.retryVersion = "registry/2.1";
    mock.tokenHeaders = { "docker-distribution-api-version": "registry/2.0" };
    const result = await checkRegistry(mock.baseUrl, USERNAME, PASSWORD, false);
    assert.deepEqual(result, {
      ok: true,
      username: USERNAME,
      version: "registry/2.1",
      detail: null,
      error: null,
    });
    // 请求顺序：/v2/（Basic）→ /token（Basic + service/scope）→ /v2/（Bearer）。
    assert.deepEqual(
      mock.requests.map((item) => item.path),
      ["/v2/", "/token", "/v2/"],
    );
    const tokenRequest = mock.requests[1]!;
    assert.equal(tokenRequest.authorization, basicAuthorization(USERNAME, PASSWORD));
    assert.equal(tokenRequest.query.get("service"), SERVICE);
    assert.equal(tokenRequest.query.get("scope"), SCOPE);
    const retried = mock.requests[2]!;
    assert.equal(retried.authorization, `Bearer ${TOKEN}`);
    // 绝不调用 Harbor 专属接口或探测具体仓库。
    assert.ok(mock.requests.every((item) => item.path === "/v2/" || item.path === "/token"));
  });

  it("版本头：重试缺失时回退 token 响应头，两者都缺失为 null", async () => {
    const fallback = await startMock();
    fallback.authorizeMode = "bearer";
    fallback.version = null;
    fallback.retryVersion = null;
    fallback.tokenHeaders = { "docker-distribution-api-version": "registry/2.0" };
    assert.equal(
      (await checkRegistry(fallback.baseUrl, USERNAME, PASSWORD, false)).version,
      "registry/2.0",
    );

    const none = await startMock();
    none.authorizeMode = "bearer";
    none.version = null;
    none.retryVersion = null;
    const result = await checkRegistry(none.baseUrl, USERNAME, PASSWORD, false);
    assert.equal(result.ok, true);
    assert.equal(result.version, null);
  });

  it("token 响应兼容 access_token；为空的 token 视为无效", async () => {
    const accessToken = await startMock();
    accessToken.authorizeMode = "bearer";
    accessToken.tokenBody = { access_token: TOKEN, token: "" };
    const ok = await checkRegistry(accessToken.baseUrl, USERNAME, PASSWORD, false);
    assert.equal(ok.ok, true);

    const emptyToken = await startMock();
    emptyToken.authorizeMode = "bearer";
    emptyToken.tokenBody = { token: "  ", access_token: null };
    const failed = await checkRegistry(emptyToken.baseUrl, USERNAME, PASSWORD, false);
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "用户名或 token 无效（registry 认证失败）");
  });

  it("token 端点 401/403/200 无 token/其它状态 → 契约文案", async () => {
    for (const status of [401, 403]) {
      const mock = await startMock();
      mock.authorizeMode = "bearer";
      mock.tokenStatus = status;
      const result = await checkRegistry(mock.baseUrl, USERNAME, PASSWORD, false);
      assert.equal(result.ok, false);
      assert.equal(result.error, "用户名或 token 无效（registry 认证失败）");
      // 没有 token 就不该重试 /v2/。
      assert.equal(mock.requests.filter((item) => item.path === "/v2/").length, 1);
    }

    const noToken = await startMock();
    noToken.authorizeMode = "bearer";
    noToken.tokenBody = {};
    const missing = await checkRegistry(noToken.baseUrl, USERNAME, PASSWORD, false);
    assert.equal(missing.error, "用户名或 token 无效（registry 认证失败）");

    const broken = await startMock();
    broken.authorizeMode = "bearer";
    broken.tokenStatus = 500;
    broken.tokenBody = { error: "boom" };
    const err = await checkRegistry(broken.baseUrl, USERNAME, PASSWORD, false);
    assert.equal(err.error, "镜像仓库返回 HTTP 500");
  });

  it("Bearer 重试仍非 2xx → 认证失败", async () => {
    const mock = await startMock();
    mock.authorizeMode = "bearer";
    mock.retryStatus = 403;
    const result = await checkRegistry(mock.baseUrl, USERNAME, PASSWORD, false);
    assert.equal(result.ok, false);
    assert.equal(result.error, "用户名或 token 无效（registry 认证失败）");
  });

  it("401 Basic 质询 / 无质询头 → 认证失败；Bearer 缺 realm 或 realm 非法 → 质询无法解析", async () => {
    for (const challenge of ['Basic realm="registry"', ""]) {
      const mock = await startMock();
      mock.authorizeMode = "bearer";
      mock.challengeHeader = challenge;
      const result = await checkRegistry(mock.baseUrl, USERNAME, PASSWORD, false);
      assert.equal(result.ok, false);
      assert.equal(result.error, "用户名或 token 无效（registry 认证失败）");
      // 没有 Bearer 质询就不该请求 token 端点。
      assert.equal(mock.requests.filter((item) => item.path === "/token").length, 0);
    }

    const noRealm = await startMock();
    noRealm.authorizeMode = "bearer";
    noRealm.challengeHeader = `Bearer service="${SERVICE}"`;
    const missingRealm = await checkRegistry(noRealm.baseUrl, USERNAME, PASSWORD, false);
    assert.equal(missingRealm.ok, false);
    assert.equal(missingRealm.error, "镜像仓库返回的认证质询无法解析");

    const relativeRealm = await startMock();
    relativeRealm.authorizeMode = "bearer";
    relativeRealm.challengeHeader = 'Bearer realm="/token"';
    const badRealm = await checkRegistry(relativeRealm.baseUrl, USERNAME, PASSWORD, false);
    assert.equal(badRealm.error, "镜像仓库返回的认证质询无法解析");
  });

  it("质询没有 service/scope 时 token URL 只带 realm", async () => {
    const mock = await startMock();
    mock.authorizeMode = "bearer";
    mock.includeService = false;
    mock.includeScope = false;
    const result = await checkRegistry(mock.baseUrl, USERNAME, PASSWORD, false);
    assert.equal(result.ok, true);
    const tokenRequest = mock.requests.find((item) => item.path === "/token")!;
    assert.deepEqual([...tokenRequest.query.keys()], []);
  });

  it("状态码映射：403/404/429/其它非 2xx 使用契约文案", async () => {
    const cases: Array<[number, string]> = [
      [403, "认证被拒绝（403）：用户名或 token 无效，或该账号无权访问"],
      [
        404,
        "接口不存在：请确认填写的是镜像仓库根地址（如 https://hub.example.com），不要带路径",
      ],
      [429, "镜像仓库触发限流，稍后重试"],
      [500, "镜像仓库返回 HTTP 500"],
      [418, "镜像仓库返回 HTTP 418"],
    ];
    for (const [status, expected] of cases) {
      const mock = await startMock();
      mock.apiStatus = status;
      const result = await checkRegistry(mock.baseUrl, USERNAME, PASSWORD, false);
      assert.equal(result.ok, false);
      assert.equal(result.error, expected);
      assert.equal(result.username, null);
      assert.equal(result.version, null);
      assert.equal(result.detail, null);
    }
  });

  it("网络错误 → 请求 {url} 失败 + --insecure 提示", async () => {
    const result = await checkRegistry("http://127.0.0.1:1", USERNAME, PASSWORD, false);
    assert.equal(result.ok, false);
    assert.match(
      String(result.error),
      /^请求 http:\/\/127\.0\.0\.1:1\/v2\/ 失败：.+（内网自签证书请加 --insecure）$/,
    );
    assert.equal(result.username, null);
  });

  it("token 端点网络错误同样带 URL 与 --insecure 提示", async () => {
    const mock = await startMock();
    mock.authorizeMode = "bearer";
    // realm 指向一个已关闭端口：质询可解析，但 token 请求会失败。
    mock.challengeHeader = 'Bearer realm="http://127.0.0.1:1/token"';
    const result = await checkRegistry(mock.baseUrl, USERNAME, PASSWORD, false);
    assert.equal(result.ok, false);
    assert.match(
      String(result.error),
      /^请求 http:\/\/127\.0\.0\.1:1\/token(\?.*)? 失败：.+（内网自签证书请加 --insecure）$/,
    );
  });

  it("地址非法时返回结构化错误，不抛异常", async () => {
    const result = await checkRegistry("ftp://hub.example.com", USERNAME, PASSWORD, false);
    assert.equal(result.ok, false);
    assert.equal(result.error, "镜像仓库地址必须是 http 或 https");
    assert.equal(result.username, null);
  });

  it("insecure 只影响 TLS 策略，仍可访问 http mock；未归一地址会先归一", async () => {
    const mock = await startMock();
    const result = await checkRegistry(`${mock.baseUrl}/v2/`, USERNAME, PASSWORD, true);
    assert.equal(result.ok, true);
    assert.equal(mock.requests[0]!.path, "/v2/");
    assert.equal(mock.requests[0]!.authorization, basicAuthorization(USERNAME, PASSWORD));
  });
});