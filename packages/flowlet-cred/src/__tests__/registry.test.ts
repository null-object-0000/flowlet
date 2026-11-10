// OCI 镜像仓库客户端单测（地址归一 / 用户名规则 / Basic 200 / Bearer 质询换 token /
// 错误文案）+ mock 服务器集成。运行：node --test packages/flowlet-cred/src/__tests__/
//
// HTTP mock 必须跑在子进程里（与 cli.test.ts 相同原因：本进程内不能可靠地同时提供 mock）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_REGISTRY_USERNAME_LENGTH,
  RegistryClient,
  RegistryError,
  normalizeBaseUrl,
  normalizeUsername,
  parseToken,
  parseWwwAuthenticate,
  registryHost,
} from "../registry.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.resolve(HERE, "mock-server.ts");

const REGISTRY_USER = "robot$flowlet+pull";
const REGISTRY_PASSWORD = "registry-test-fixture-password-4h6k";
const INVALID = "用户名或 token 无效（registry 认证失败）";

const processes: Array<import("node:child_process").ChildProcess> = [];
after(() => {
  for (const child of processes) child.kill("SIGKILL");
});

function startMock(options: Record<string, unknown>): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [MOCK_SERVER, JSON.stringify({ mode: "registry", ...options })],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
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

describe("registry normalizeBaseUrl", () => {
  it("缺 scheme 补 https；去末尾斜杠", () => {
    assert.equal(normalizeBaseUrl("hub.example.com"), "https://hub.example.com");
    assert.equal(normalizeBaseUrl("  https://hub.example.com/  "), "https://hub.example.com");
    assert.equal(normalizeBaseUrl("http://host:5000///"), "http://host:5000");
    assert.equal(normalizeBaseUrl("hub.example.com:5000"), "https://hub.example.com:5000");
    assert.equal(normalizeBaseUrl("http://[::1]:5000/"), "http://[::1]:5000");
  });

  it("去掉 /v2 与 /v2/（兼容从文档粘贴）", () => {
    assert.equal(normalizeBaseUrl("https://host/v2/"), "https://host");
    assert.equal(normalizeBaseUrl("https://host/v2"), "https://host");
    assert.equal(normalizeBaseUrl("http://host:5000/v2/"), "http://host:5000");
  });

  it("拒绝非根路径（只能是主机，可带端口）", () => {
    assert.throws(
      () => normalizeBaseUrl("https://hub.example.com/library/nginx"),
      /镜像仓库地址只能是主机（可带端口），不能包含路径/,
    );
    assert.throws(
      () => normalizeBaseUrl("http://host:5000/v2/tags/list"),
      /镜像仓库地址只能是主机（可带端口），不能包含路径/,
    );
  });

  it("拒绝空地址/非法 scheme/query/fragment/缺主机名", () => {
    assert.throws(() => normalizeBaseUrl("   "), /镜像仓库地址不能为空/);
    assert.throws(() => normalizeBaseUrl("ftp://host:5000"), /镜像仓库地址必须是 http 或 https/);
    assert.throws(
      () => normalizeBaseUrl("http://host:5000/?a=1"),
      /镜像仓库地址不能带查询参数或锚点/,
    );
    assert.throws(
      () => normalizeBaseUrl("http://host:5000/#top"),
      /镜像仓库地址不能带查询参数或锚点/,
    );
    // 与 Node/Rust 对齐：`scheme://` 空主机 → 缺少主机名；`scheme:///` 无法解析。
    assert.throws(() => normalizeBaseUrl("https://"), /镜像仓库地址缺少主机名/);
    assert.throws(() => normalizeBaseUrl("http://"), /镜像仓库地址缺少主机名/);
    assert.throws(
      () => normalizeBaseUrl("https:///"),
      /镜像仓库地址无法解析：invalid URL/,
    );
  });
});

describe("registry registryHost", () => {
  it("提取 host[:port]，无 scheme、无路径", () => {
    assert.equal(registryHost("https://hub.example.com"), "hub.example.com");
    assert.equal(registryHost("https://hub.example.com:5000/"), "hub.example.com:5000");
    assert.equal(registryHost("http://[::1]:5000"), "[::1]:5000");
    // pull 落库的是裸 host，registryHost 仍能处理。
    assert.equal(registryHost("hub.example.com:5000"), "hub.example.com:5000");
  });

  it("空/脏数据不抛错（env/pull 依赖该语义），按文本兜底", () => {
    assert.equal(registryHost(""), "");
    assert.equal(registryHost("  "), "");
    assert.equal(registryHost("not a url"), "not a url");
  });
});

describe("registry normalizeUsername", () => {
  it("允许 Harbor robot account 形态（$ + _ -）", () => {
    assert.equal(normalizeUsername("robot$project+name"), "robot$project+name");
    assert.equal(normalizeUsername("  alice  "), "alice");
    assert.equal(normalizeUsername("a_b-c+d$e"), "a_b-c+d$e");
  });

  it("必填；空/空白报契约文案", () => {
    assert.throws(
      () => normalizeUsername(""),
      /^Error: 镜像仓库需要填写用户名（docker login 需要用户名 \+ 密码\/token）$/,
    );
    assert.throws(
      () => normalizeUsername("   "),
      /镜像仓库需要填写用户名（docker login 需要用户名 \+ 密码\/token）/,
    );
  });

  it("拒绝冒号/空白/控制字符", () => {
    assert.throws(() => normalizeUsername("a:b"), /用户名不能包含冒号、空格或控制字符/);
    assert.throws(() => normalizeUsername("a b"), /用户名不能包含冒号、空格或控制字符/);
    assert.throws(() => normalizeUsername("a\tb"), /用户名不能包含冒号、空格或控制字符/);
    assert.throws(() => normalizeUsername("a\u0000b"), /用户名不能包含冒号、空格或控制字符/);
    assert.throws(() => normalizeUsername("a\u007fb"), /用户名不能包含冒号、空格或控制字符/);
  });

  it("长度按 Unicode 字符计，上限 255", () => {
    assert.equal(normalizeUsername("a".repeat(MAX_REGISTRY_USERNAME_LENGTH)).length, 255);
    assert.throws(
      () => normalizeUsername("a".repeat(MAX_REGISTRY_USERNAME_LENGTH + 1)),
      /用户名不能超过 255 个字符/,
    );
    assert.equal([...normalizeUsername("名".repeat(255))].length, 255);
    assert.throws(() => normalizeUsername("名".repeat(256)), /用户名不能超过 255 个字符/);
  });
});

describe("registry parseWwwAuthenticate / parseToken", () => {
  it("解析 Bearer 质询的 realm/service/scope（引号内逗号保留）", () => {
    const challenge = parseWwwAuthenticate(
      'Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:library/nginx:pull,push"',
    );
    assert.ok(challenge !== null);
    assert.equal(challenge.scheme, "Bearer");
    assert.equal(challenge.params.get("realm"), "https://auth.example.com/token");
    assert.equal(challenge.params.get("service"), "registry.example.com");
    assert.equal(challenge.params.get("scope"), "repository:library/nginx:pull,push");
  });

  it("Basic 质询只解析出 scheme", () => {
    const challenge = parseWwwAuthenticate('Basic realm="Registry"');
    assert.ok(challenge !== null);
    assert.equal(challenge.scheme, "Basic");
    assert.equal(challenge.params.get("realm"), "Registry");
  });

  it("token 响应体：token 优先，其次 access_token；缺失/空/非 JSON 为 null", () => {
    assert.equal(parseToken('{"token":"abc"}'), "abc");
    assert.equal(parseToken('{"access_token":"def"}'), "def");
    assert.equal(parseToken('{"token":"abc","access_token":"def"}'), "abc");
    assert.equal(parseToken('{"token":""}'), null);
    assert.equal(parseToken('{"token":123}'), null);
    assert.equal(parseToken("{}"), null);
    assert.equal(parseToken("not json"), null);
    assert.equal(parseToken(""), null);
  });
});

describe("registry RegistryClient（mock 服务器）", () => {
  it("Basic 直接 200：返回 version / detail=null / 入参用户名", async () => {
    const mock = await startMock({ registryAuth: "basic" });
    const client = new RegistryClient(mock.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD);
    assert.equal(client.base(), mock.baseUrl);
    assert.deepEqual(await client.check(), {
      version: "registry/2.0",
      detail: null,
      username: REGISTRY_USER,
    });
    mock.close();
  });

  it("Bearer 质询 → token 端点 → Bearer 重试 200", async () => {
    const mock = await startMock({});
    const client = new RegistryClient(mock.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD);
    assert.deepEqual(await client.check(), {
      version: "registry/2.0",
      detail: null,
      username: REGISTRY_USER,
    });
    mock.close();
  });

  it("version 优先取重试响应头，其次 token 响应头，都缺失为 null", async () => {
    const fromToken = await startMock({ registryVersion: null, registryTokenVersion: "registry/2.0" });
    assert.equal(
      (await new RegistryClient(fromToken.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD).check()).version,
      "registry/2.0",
    );
    fromToken.close();

    const none = await startMock({ registryVersion: null });
    assert.equal(
      (await new RegistryClient(none.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD).check()).version,
      null,
    );
    none.close();
  });

  it("access_token 字段同样认", async () => {
    const mock = await startMock({ registryTokenField: "access_token" });
    assert.equal(
      (await new RegistryClient(mock.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD).check()).version,
      "registry/2.0",
    );
    mock.close();
  });

  it("用户名/密码错误（token 端点 401）→ 契约文案", async () => {
    const mock = await startMock({});
    await assert.rejects(
      new RegistryClient(mock.baseUrl, REGISTRY_USER, "wrong-password").check(),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError);
        assert.equal(error.status, 401);
        assert.equal(error.toString(), INVALID);
        return true;
      },
    );
    mock.close();
  });

  it("Basic 质询（没有 Bearer）→ 契约文案", async () => {
    const mock = await startMock({ registryChallenge: 'Basic realm="Registry"' });
    await assert.rejects(
      new RegistryClient(mock.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD).check(),
      (error: unknown) => error instanceof RegistryError && error.toString() === INVALID,
    );
    mock.close();
  });

  it("Bearer 缺 realm / realm 无法解析 → 质询解析失败", async () => {
    const noRealm = await startMock({ registryChallenge: 'Bearer service="mock-registry"' });
    await assert.rejects(
      new RegistryClient(noRealm.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD).check(),
      (error: unknown) =>
        error instanceof RegistryError &&
        error.toString() === "镜像仓库返回的认证质询无法解析",
    );
    noRealm.close();

    const badRealm = await startMock({ registryChallenge: 'Bearer realm="not a url"' });
    await assert.rejects(
      new RegistryClient(badRealm.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD).check(),
      (error: unknown) =>
        error instanceof RegistryError &&
        error.toString() === "镜像仓库返回的认证质询无法解析",
    );
    badRealm.close();
  });

  it("token 端点 200 但没有 token 字段 → 认证失败", async () => {
    const mock = await startMock({ registryTokenBody: {} });
    await assert.rejects(
      new RegistryClient(mock.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD).check(),
      (error: unknown) => error instanceof RegistryError && error.toString() === INVALID,
    );
    mock.close();

    const forbidden = await startMock({ registryTokenStatus: 403 });
    await assert.rejects(
      new RegistryClient(forbidden.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD).check(),
      (error: unknown) => error instanceof RegistryError && error.toString() === INVALID,
    );
    forbidden.close();
  });

  it("token 换发成功但 Bearer 重试非 200 → 认证失败", async () => {
    const mock = await startMock({ registryRetryStatus: 403 });
    await assert.rejects(
      new RegistryClient(mock.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD).check(),
      (error: unknown) => error instanceof RegistryError && error.toString() === INVALID,
    );
    mock.close();
  });

  it("403 / 404 / 429 / 其它状态码映射", async () => {
    const forbidden = await startMock({ registryStatus: 403 });
    await assert.rejects(
      new RegistryClient(forbidden.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD).check(),
      (error: unknown) =>
        error instanceof RegistryError &&
        error.status === 403 &&
        error.toString() === "认证被拒绝（403）：用户名或 token 无效，或该账号无权访问",
    );
    forbidden.close();

    const missing = await startMock({ registryStatus: 404 });
    await assert.rejects(
      new RegistryClient(missing.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD).check(),
      (error: unknown) =>
        error instanceof RegistryError &&
        error.status === 404 &&
        error.toString() ===
          "接口不存在：请确认填写的是镜像仓库根地址（如 https://hub.example.com），不要带路径",
    );
    missing.close();

    const limited = await startMock({ registryStatus: 429 });
    await assert.rejects(
      new RegistryClient(limited.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD).check(),
      (error: unknown) =>
        error instanceof RegistryError &&
        error.status === 429 &&
        error.toString() === "镜像仓库触发限流，稍后重试",
    );
    limited.close();

    const broken = await startMock({ registryStatus: 500 });
    await assert.rejects(
      new RegistryClient(broken.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD).check(),
      (error: unknown) =>
        error instanceof RegistryError &&
        error.status === 500 &&
        error.toString() === "镜像仓库返回 HTTP 500",
    );
    broken.close();
  });

  it("网络错误：主请求与 token 端点都带 --insecure 提示", async () => {
    // 127.0.0.1:1 连接被拒绝（Linux 上稳定）。
    const client = new RegistryClient("http://127.0.0.1:1", REGISTRY_USER, REGISTRY_PASSWORD);
    await assert.rejects(
      client.check(),
      (error: unknown) =>
        error instanceof RegistryError &&
        error.status === null &&
        /^请求 http:\/\/127\.0\.0\.1:1\/v2\/ 失败：/.test(error.toString()) &&
        error.toString().includes("内网自签证书请加 --insecure"),
    );

    const mock = await startMock({
      registryChallenge: 'Bearer realm="http://127.0.0.1:1/token",service="mock"',
    });
    await assert.rejects(
      new RegistryClient(mock.baseUrl, REGISTRY_USER, REGISTRY_PASSWORD).check(),
      (error: unknown) =>
        error instanceof RegistryError &&
        error.status === null &&
        /请求 http:\/\/127\.0\.0\.1:1\/token\?service=mock 失败：/.test(error.toString()) &&
        error.toString().includes("内网自签证书请加 --insecure"),
    );
    mock.close();
  });

  it("构造时立即拒绝空用户名 / 空密码", async () => {
    assert.throws(
      () => new RegistryClient("https://host", "   ", REGISTRY_PASSWORD),
      /镜像仓库需要填写用户名（docker login 需要用户名 \+ 密码\/token）/,
    );
    assert.throws(
      () => new RegistryClient("https://host", REGISTRY_USER, "  "),
      /镜像仓库密码\/token 不能为空/,
    );
  });
});