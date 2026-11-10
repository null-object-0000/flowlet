// 测试用 mock 服务器（独立子进程，避免 spawnSync 阻塞同进程 HTTP 服务）。
// 用法：node mock-server.ts '{"mode":"gitlab",...}'；启动后 stdout 打印 PORT <n>。
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

interface MockOptions {
  mode: "gitlab" | "flowlet-web" | "dockhand" | "jenkins" | "beszel" | "registry";
  versionStatus?: number;
  hiddenVersion?: boolean;
  projectPages?: Array<Array<Record<string, unknown>>>;
  entries?: Array<Record<string, string>>;
  gitlabToken?: string;
  adminToken?: string;
  dockhandToken?: string;
  /** jenkins：Basic 认证的用户名 / token / 身份字段。 */
  jenkinsUser?: string;
  jenkinsToken?: string;
  /** jenkins：`/me/api/json` 的 fullName；null 时只返回 id（测试回退取 id）。 */
  jenkinsFullName?: string | null;
  /** jenkins：X-Jenkins 版本头；null 时不返回该头（测试「版本未知」）。 */
  jenkinsVersion?: string | null;
  /** jenkins：强制 `/me/api/json` 返回该状态码（403/404 分支）。 */
  jenkinsMeStatus?: number;
  /** beszel：固定的登录邮箱 / 密码（auth-with-password 校验用）。 */
  beszelEmail?: string;
  beszelPassword?: string;
  /** beszel：`/api/beszel/info` 的版本；null 时不返回 `v`（测试「版本未知」）。 */
  beszelVersion?: string | null;
  /** beszel：强制 `/api/beszel/info` 返回该状态码（测试「info 失败不致命」）。 */
  beszelInfoStatus?: number;
  /** beszel：`systems/records` 的原始响应覆盖（测试解析失败分支）。 */
  beszelRecords?: unknown;
  /** registry：Basic 认证的用户名 / 密码（docker login 的密码或 token）。 */
  registryUser?: string;
  registryPassword?: string;
  /** registry：Bearer 换发后 `/v2/` 认可的 token。 */
  registryToken?: string;
  /** registry：认证方式；basic = 直接 200，bearer = 401 质询后换 token（默认 bearer）。 */
  registryAuth?: "basic" | "bearer";
  /** registry：`GET /v2/` 的 docker-distribution-api-version 响应头；null 时不返回。 */
  registryVersion?: string | null;
  /** registry：强制 `GET /v2/` 返回该状态码（403/404/429 等，绕过认证）。 */
  registryStatus?: number;
  /** registry：强制 token 端点返回该状态码。 */
  registryTokenStatus?: number;
  /** registry：token 端点 200 的响应体覆盖（测试「没有 token 字段」）。 */
  registryTokenBody?: unknown;
  /** registry：token 响应体里的 token 字段名（token | access_token）。 */
  registryTokenField?: string;
  /** registry：token 响应头的 docker-distribution-api-version（测试 version 回退）。 */
  registryTokenVersion?: string | null;
  /** registry：重试 `GET /v2/` 带 Bearer 时的响应状态（测试 token 成功但重试失败）。 */
  registryRetryStatus?: number;
  /** registry：覆盖 401 的 WWW-Authenticate（测试 Basic 质询 / 缺 realm / 不可解析）。 */
  registryChallenge?: string;
  /**
   * flowlet-web：启用浏览器授权端点（/api/auth/cli/start、/api/auth/cli/exchange），
   * 并接受 CLI token 调 export_service_credentials。默认关闭，既有 pull 用例行为不变。
   */
  cliAuth?: boolean;
  /** flowlet-web：固定的 CLI token（测试可断言它没有出现在 CLI 输出里）。 */
  cliToken?: string;
  /** flowlet-web：即使 cliAuth 开启也对该 CLI token 返回 403（模拟作用域不足）。 */
  cliForbidden?: boolean;
}

const options = JSON.parse(process.argv[2] ?? "{}") as MockOptions;
const GITLAB_TOKEN = options.gitlabToken ?? "glpat-test-fixture-token-1a2b";
const ADMIN_TOKEN = options.adminToken ?? "flowlet-admin-token-0123456789";
const DOCKHAND_TOKEN = options.dockhandToken ?? "dockhand-test-fixture-token-9x8y";
const JENKINS_USER = options.jenkinsUser ?? "fixture-user";
const JENKINS_TOKEN = options.jenkinsToken ?? "jenkins-test-fixture-token-7q2w";
const JENKINS_VERSION = options.jenkinsVersion === undefined ? "2.440.1" : options.jenkinsVersion;
const JENKINS_FULL_NAME = options.jenkinsFullName === undefined ? "Fixture User" : options.jenkinsFullName;
// Beszel（PocketBase 底座）：固定邮箱/密码换 token；record 字段与真实响应同形。
const BESZEL_EMAIL = options.beszelEmail ?? "fixture@example.com";
const BESZEL_PASSWORD = options.beszelPassword ?? "beszel-test-fixture-password-8k3m";
const BESZEL_TOKEN = "beszel-test-fixture-token-5v1n";
const BESZEL_VERSION = options.beszelVersion === undefined ? "0.21.1" : options.beszelVersion;
const BESZEL_SYSTEMS = [
  { id: "sys-1", name: "web-01", host: "10.0.0.11", status: "up", port: 45876, updated: "2026-11-10T00:00:00Z" },
  { id: "sys-2", name: "db-01", host: "10.0.0.12", status: "up", port: 45877, updated: "2026-11-10T00:00:00Z" },
  { id: "sys-3", name: "cache-01", host: "10.0.0.13", status: "down", port: 45878, updated: "2026-11-10T00:00:00Z" },
];
const CLI_TOKEN = options.cliToken ?? `flwcli_${"T".repeat(43)}`;
// OCI 镜像仓库（Docker Registry HTTP API V2）：Basic 换 Bearer token 的标准流程。
const REGISTRY_USER = options.registryUser ?? "robot$flowlet+pull";
const REGISTRY_PASSWORD = options.registryPassword ?? "registry-test-fixture-password-4h6k";
const REGISTRY_TOKEN = options.registryToken ?? "registry-test-fixture-bearer-2w9c";
const REGISTRY_AUTH = options.registryAuth ?? "bearer";
const REGISTRY_VERSION = options.registryVersion === undefined ? "registry/2.0" : options.registryVersion;
const REGISTRY_TOKEN_VERSION =
  options.registryTokenVersion === undefined ? null : options.registryTokenVersion;

/** 授权码 → PKCE challenge（120 秒有效、一次性，与 Node Host 契约一致）。 */
const cliAuthCodes = new Map<string, { challenge: string; expiresAt: number }>();

// Dockhand 1.0.57 实测响应形状（fixture 只放 mock，绝不访问真实实例）。
const DOCKHAND_ENVIRONMENTS = [
  { id: 2, name: "[CentOS] 10.100.217.60", host: "10.100.217.60", port: 2375, protocol: "http" },
  { id: 1, name: "本机", host: "127.0.0.1", port: 2375, protocol: "http" },
];
const DOCKHAND_STACKS = [
  { name: "flowlet", containers: ["flowlet", "flowlet-egress"], containerDetails: [] },
  { name: "tools", containers: ["registry"], containerDetails: [] },
];

const server = createServer((request, response) => {
  if (options.mode === "flowlet-web") {
    const url = new URL(request.url ?? "/", "http://localhost");
    const sendJson = (status: number, value: unknown): void => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(body.length),
        "cache-control": "no-store",
      });
      response.end(body);
    };
    const sendHtml = (status: number, html: string): void => {
      const body = Buffer.from(html, "utf8");
      response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(body.length),
      });
      response.end(body);
    };

    if (options.cliAuth === true) {
      // GET /api/auth/cli/start：校验参数、生成一次性授权码，直接 302 回 loopback。
      // 真实浏览器会先渲染授权页再点授权；测试里「浏览器」只关心最终回调，故 mock 直接跳转。
      if (
        url.pathname === "/api/auth/cli/start" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const method = url.searchParams.get("code_challenge_method") ?? "S256";
        let redirect: URL | null = null;
        try {
          redirect = new URL(redirectUri);
        } catch {
          redirect = null;
        }
        const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
        const valid =
          redirect !== null &&
          redirect.protocol === "http:" &&
          loopbackHosts.has(redirect.hostname) &&
          state.length >= 1 &&
          state.length <= 512 &&
          /^[A-Za-z0-9_-]{43}$/.test(challenge) &&
          method === "S256";
        if (!valid) {
          sendHtml(400, "<!doctype html><meta charset=utf-8><h1>参数不合法</h1>");
          return;
        }
        const code = randomBytes(32).toString("base64url");
        cliAuthCodes.set(code, { challenge, expiresAt: Date.now() + 120_000 });
        const target = new URL(redirect!.toString());
        target.searchParams.set("code", code);
        target.searchParams.set("state", state);
        response.writeHead(302, {
          location: target.toString(),
          "cache-control": "no-store",
          "content-length": "0",
        });
        response.end();
        return;
      }

      // POST /api/auth/cli/exchange：校验 code + PKCE S256，签发固定 fixture token。
      if (url.pathname === "/api/auth/cli/exchange" && request.method === "POST") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          let body: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
              body = parsed as Record<string, unknown>;
            }
          } catch {
            sendJson(400, { code: "invalid_request", message: "请求体不是合法 JSON" });
            return;
          }
          const code = typeof body.code === "string" ? body.code : "";
          const verifier = typeof body.codeVerifier === "string" ? body.codeVerifier : "";
          if (code === "" || verifier === "") {
            sendJson(400, { code: "invalid_request", message: "缺少 code 或 codeVerifier" });
            return;
          }
          const entry = cliAuthCodes.get(code);
          if (entry === undefined || entry.expiresAt < Date.now()) {
            sendJson(400, { code: "invalid_grant", message: "授权码无效或已过期" });
            return;
          }
          const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
          if (challenge !== entry.challenge) {
            sendJson(400, { code: "invalid_grant", message: "授权码无效或已过期" });
            return;
          }
          cliAuthCodes.delete(code);
          sendJson(200, {
            token: CLI_TOKEN,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
              .toISOString()
              .replace(/\.\d{3}Z$/, "Z"),
          });
        });
        return;
      }
    }

    // 既有行为：命令端点（export_service_credentials）只认管理 token；
    // cliAuth 模式下额外接受 /api/auth/cli/exchange 签发的 CLI token（作用域 credentials:read）。
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const bearer = request.headers.authorization;
      const authorized =
        bearer === `Bearer ${ADMIN_TOKEN}` ||
        (options.cliAuth === true && bearer === `Bearer ${CLI_TOKEN}`);
      if (options.cliForbidden === true && bearer === `Bearer ${CLI_TOKEN}`) {
        const forbidden = Buffer.from(
          JSON.stringify({ code: "forbidden", message: "CLI 凭据仅可用于凭据同步" }),
          "utf8",
        );
        response.writeHead(403, {
          "content-type": "application/json",
          "content-length": String(forbidden.length),
          "cache-control": "no-store",
        });
        response.end(forbidden);
        return;
      }
      const payload = authorized
        ? (options.entries ?? [])
        : { code: "unauthorized", message: "管理凭据无效，请重新登录" };
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      response.writeHead(authorized ? 200 : 401, {
        "content-type": "application/json",
        "content-length": String(body.length),
        "cache-control": "no-store",
      });
      response.end(body);
    });
    return;
  }

  if (options.mode === "dockhand") {
    // Dockhand：Bearer token + `?env=<id>`；/health 匿名可访问，其它资源接口需认证。
    const url = new URL(request.url ?? "/", "http://localhost");
    const authorized = request.headers.authorization === `Bearer ${DOCKHAND_TOKEN}`;
    const send = (status: number, value: unknown): void => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(body.length),
      });
      response.end(body);
    };
    const pathname = url.pathname;
    if (pathname === "/api/health") {
      return send(200, { status: "ok", timestamp: "2026-11-10T00:00:00Z" });
    }
    if (pathname === "/api/environments") {
      if (!authorized) return send(401, { message: "Unauthorized" });
      return send(200, DOCKHAND_ENVIRONMENTS);
    }
    if (pathname === "/api/system") {
      if (!authorized) return send(401, { message: "Unauthorized" });
      if (url.searchParams.get("env") === null) return send(400, { message: "Missing env parameter" });
      return send(200, {
        docker: { version: "27.3.1", serverVersion: "27.3.1" },
        host: { name: "fixture-host" },
        runtime: { os: "linux" },
        database: { size: 0 },
        stats: { containers: 2 },
      });
    }
    if (pathname === "/api/stacks") {
      if (!authorized) return send(401, { message: "Unauthorized" });
      if (url.searchParams.get("env") === null) return send(400, { message: "Missing env parameter" });
      return send(200, DOCKHAND_STACKS);
    }
    if (pathname === "/api/echo") {
      // 透传测试用：回显 method + 解析后的 JSON body。
      if (!authorized) return send(401, { message: "Unauthorized" });
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = null;
        if (text.trim() !== "") {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        send(200, { method: request.method ?? "GET", body });
      });
      return;
    }
    return send(404, { message: "Not Found" });
  }

  if (options.mode === "beszel") {
    // Beszel：邮箱 + 密码换 token（Authorization 是裸 token，不是 Bearer）。
    const url = new URL(request.url ?? "/", "http://localhost");
    const authorized = request.headers.authorization === BESZEL_TOKEN;
    const send = (status: number, value: unknown): void => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(body.length),
      });
      response.end(body);
    };
    const readJson = (callback: (body: Record<string, unknown>) => void): void => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            body = parsed as Record<string, unknown>;
          }
        } catch {
          body = {};
        }
        callback(body);
      });
    };
    const pathname = url.pathname;
    if (pathname === "/api/collections/users/auth-with-password" && request.method === "POST") {
      readJson((body) => {
        const identity = typeof body.identity === "string" ? body.identity.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (identity.toLowerCase() !== BESZEL_EMAIL.toLowerCase() || password !== BESZEL_PASSWORD) {
          // PocketBase 认证失败统一 400。
          return send(400, { status: 400, message: "Failed to authenticate." });
        }
        return send(200, {
          token: BESZEL_TOKEN,
          record: { id: "user-1", email: identity, name: "Fixture Beszel", role: "admin" },
        });
      });
      return;
    }
    if (pathname === "/api/beszel/info") {
      if (!authorized) return send(401, { status: 401, message: "Unauthorized" });
      if (options.beszelInfoStatus !== undefined && options.beszelInfoStatus !== 200) {
        return send(options.beszelInfoStatus, { message: `Status ${options.beszelInfoStatus}` });
      }
      return send(200, BESZEL_VERSION === null ? {} : { v: BESZEL_VERSION });
    }
    if (pathname === "/api/collections/systems/records") {
      if (!authorized) return send(401, { status: 401, message: "Unauthorized" });
      if (options.beszelRecords !== undefined) return send(200, options.beszelRecords);
      const rawPerPage = Number(url.searchParams.get("perPage") ?? "200");
      const perPage = Number.isInteger(rawPerPage) && rawPerPage > 0 ? rawPerPage : 200;
      return send(200, {
        page: 1,
        perPage,
        totalItems: BESZEL_SYSTEMS.length,
        totalPages: 1,
        items: BESZEL_SYSTEMS.slice(0, perPage),
      });
    }
    if (pathname === "/api/echo") {
      // 透传测试用：回显 method + 解析后的 JSON body。
      if (!authorized) return send(401, { status: 401, message: "Unauthorized" });
      readJson((body) => send(200, { method: request.method ?? "GET", body, path: pathname }));
      return;
    }
    // 404 分支：用 JSON body 证明「可执行提示」而不是上游 HTML。
    return send(404, { message: "Not Found" });
  }

  if (options.mode === "registry") {
    // OCI 镜像仓库：`GET /v2/` Basic → 401 + WWW-Authenticate: Bearer → token 端点 → 重试。
    // 只 mock 标准 Registry V2 端点（/v2/ 与 token），不提供任何 Harbor 专属 API。
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (
      status: number,
      value: unknown,
      headers: Record<string, string> = {},
    ): void => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(body.length),
        ...headers,
      });
      response.end(body);
    };
    const versionHeaders: Record<string, string> =
      REGISTRY_VERSION === null ? {} : { "docker-distribution-api-version": REGISTRY_VERSION };
    const tokenVersionHeaders: Record<string, string> =
      REGISTRY_TOKEN_VERSION === null
        ? {}
        : { "docker-distribution-api-version": REGISTRY_TOKEN_VERSION };
    const expectedBasic = `Basic ${Buffer.from(`${REGISTRY_USER}:${REGISTRY_PASSWORD}`, "utf8").toString("base64")}`;
    const authorization = request.headers.authorization ?? "";
    const origin = `http://${request.headers.host ?? "127.0.0.1"}`;
    const challenge =
      options.registryChallenge ??
      `Bearer realm="${origin}/token",service="mock-registry",scope="repository:library/nginx:pull"`;
    const pathname = url.pathname;
    if (pathname === "/v2/" || pathname === "/v2") {
      if (options.registryStatus !== undefined && options.registryStatus !== 200) {
        const headers: Record<string, string> =
          options.registryStatus === 401 ? { "www-authenticate": challenge } : {};
        return send(
          options.registryStatus,
          { errors: [{ code: "UNAUTHORIZED", message: `status ${options.registryStatus}` }] },
          headers,
        );
      }
      if (REGISTRY_AUTH === "basic") {
        if (authorization !== expectedBasic) {
          return send(401, { errors: [{ code: "UNAUTHORIZED" }] });
        }
        return send(200, {}, versionHeaders);
      }
      if (authorization === `Bearer ${REGISTRY_TOKEN}`) {
        if (options.registryRetryStatus !== undefined && options.registryRetryStatus !== 200) {
          return send(options.registryRetryStatus, { errors: [{ code: "DENIED" }] });
        }
        return send(200, {}, versionHeaders);
      }
      return send(401, { errors: [{ code: "UNAUTHORIZED" }] }, { "www-authenticate": challenge });
    }
    if (pathname === "/token") {
      if (options.registryTokenStatus !== undefined && options.registryTokenStatus !== 200) {
        return send(options.registryTokenStatus, { errors: [{ code: "UNAUTHORIZED" }] });
      }
      if (authorization !== expectedBasic) {
        return send(401, { errors: [{ code: "UNAUTHORIZED" }] });
      }
      if (options.registryTokenBody !== undefined) {
        return send(200, options.registryTokenBody, tokenVersionHeaders);
      }
      const field = options.registryTokenField ?? "token";
      return send(200, { [field]: REGISTRY_TOKEN }, tokenVersionHeaders);
    }
    return send(404, { message: "Not Found" });
  }

  if (options.mode === "jenkins") {
    // Jenkins：HTTP Basic（用户名:API Token）；`/me/api/json` 校验身份并返回 X-Jenkins。
    const url = new URL(request.url ?? "/", "http://localhost");
    const expected = `Basic ${Buffer.from(`${JENKINS_USER}:${JENKINS_TOKEN}`, "utf8").toString("base64")}`;
    const authorized = request.headers.authorization === expected;
    const send = (
      status: number,
      value: unknown,
      headers: Record<string, string> = {},
    ): void => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(body.length),
        ...headers,
      });
      response.end(body);
    };
    const versionHeaders: Record<string, string> =
      JENKINS_VERSION === null ? {} : { "x-jenkins": JENKINS_VERSION };
    const pathname = url.pathname;
    if (pathname === "/me/api/json") {
      if (!authorized) return send(401, { message: "Unauthorized" });
      if (options.jenkinsMeStatus !== undefined && options.jenkinsMeStatus !== 200) {
        return send(options.jenkinsMeStatus, { message: `Status ${options.jenkinsMeStatus}` });
      }
      const whoami: Record<string, unknown> = { id: JENKINS_USER, description: null };
      if (JENKINS_FULL_NAME !== null) whoami.fullName = JENKINS_FULL_NAME;
      return send(200, whoami, versionHeaders);
    }
    if (pathname === "/job/flowlet/api/json") {
      if (!authorized) return send(401, { message: "Unauthorized" });
      return send(200, { name: "flowlet", color: "blue" });
    }
    if (pathname === "/echo") {
      // 透传测试用：回显 method + 解析后的 JSON body。
      if (!authorized) return send(401, { message: "Unauthorized" });
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = null;
        if (text.trim() !== "") {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        send(200, { method: request.method ?? "GET", body, path: pathname });
      });
      return;
    }
    // 404 分支：用 JSON body 证明「可执行提示」而不是上游 HTML。
    return send(404, { message: "Not Found" });
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const token = request.headers["private-token"];
  const send = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": String(body.length),
      ...headers,
    });
    response.end(body);
  };
  const suffix = url.pathname.replace(/^\/gitlab/, "");
  if (suffix === "/api/v4/user") {
    if (token !== GITLAB_TOKEN) return send(401, { message: "401 Unauthorized" });
    return send(200, { id: 7, username: "fixture", name: "Fixture User" });
  }
  if (suffix === "/api/v4/version") {
    if (options.hiddenVersion) return send(404, { message: "404 Not Found" });
    if (options.versionStatus !== undefined && options.versionStatus !== 200) {
      return send(options.versionStatus, { message: `${options.versionStatus} Forbidden` });
    }
    if (token !== GITLAB_TOKEN) return send(401, { message: "401 Unauthorized" });
    return send(200, { version: "10.8.7" });
  }
  if (suffix === "/api/v4/projects") {
    if (token !== GITLAB_TOKEN) return send(401, { message: "401 Unauthorized" });
    const pages = options.projectPages ?? [];
    const page = Number(url.searchParams.get("page") ?? "1");
    const batch = pages[page - 1] ?? [];
    const headers: Record<string, string> = { "x-page": String(page) };
    if (page < pages.length) headers["x-next-page"] = String(page + 1);
    headers["x-total"] = String(pages.flat().length);
    return send(200, batch, headers);
  }
  send(404, { message: "404 Not Found" });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  process.stdout.write(`PORT ${port}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));