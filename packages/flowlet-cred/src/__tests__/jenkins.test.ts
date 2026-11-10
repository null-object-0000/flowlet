// Jenkins 客户端单测（地址归一 / 路径构造 / 身份解析 / 错误提示）+ mock 服务器集成。
// 运行：node --test packages/flowlet-cred/src/__tests__/
//
// HTTP mock 必须跑在子进程里（与 cli.test.ts 相同原因：本进程内不能可靠地同时提供 mock）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  describeError,
  JenkinsClient,
  JenkinsError,
  normalizeBaseUrl,
  parseIdentityUsername,
  resolveApiPath,
} from "../jenkins.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.resolve(HERE, "mock-server.ts");

const JENKINS_USER = "fixture-user";
const JENKINS_TOKEN = "jenkins-test-fixture-token-7q2w";

const processes: Array<import("node:child_process").ChildProcess> = [];
after(() => {
  for (const child of processes) child.kill("SIGKILL");
});

function startMock(options: Record<string, unknown>): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK_SERVER, JSON.stringify({ mode: "jenkins", ...options })], {
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

describe("jenkins normalizeBaseUrl", () => {
  it("去末尾斜杠、保留子路径部署", () => {
    assert.equal(normalizeBaseUrl("https://jenkins.example.com"), "https://jenkins.example.com");
    assert.equal(normalizeBaseUrl("  https://jenkins.example.com/  "), "https://jenkins.example.com");
    assert.equal(normalizeBaseUrl("http://host:8080///"), "http://host:8080");
    assert.equal(normalizeBaseUrl("https://ops.example.com/ci/"), "https://ops.example.com/ci");
  });

  it("不自动剥 /api、/me、/api/json（Jenkins 没有统一 API 前缀）", () => {
    assert.equal(normalizeBaseUrl("https://host/api"), "https://host/api");
    assert.equal(normalizeBaseUrl("https://host/me"), "https://host/me");
    assert.equal(normalizeBaseUrl("https://host/api/json"), "https://host/api/json");
  });

  it("拒绝空地址/非法 scheme/无法解析/query/fragment", () => {
    assert.throws(() => normalizeBaseUrl("   "), /Jenkins 地址不能为空/);
    assert.throws(() => normalizeBaseUrl("ftp://host:8080"), /Jenkins 地址必须是 http 或 https/);
    // 不带 scheme 的 `host:port` 会被 URL 解析成 scheme，最终落到 scheme 校验（与 Rust 一致）。
    assert.throws(() => normalizeBaseUrl("jenkins.example.com:8080"), /Jenkins 地址必须是 http 或 https/);
    assert.throws(() => normalizeBaseUrl("http://"), /Jenkins 地址无法解析/);
    assert.throws(() => normalizeBaseUrl("http://host:8080/?a=1"), /Jenkins 地址不能带查询参数或锚点/);
    assert.throws(() => normalizeBaseUrl("http://host:8080/#top"), /Jenkins 地址不能带查询参数或锚点/);
  });
});

describe("jenkins resolveApiPath", () => {
  const base = "https://host/ci";

  it("PATH 原样拼在 base 后，只补前导斜杠、不自动加 /api", () => {
    assert.equal(resolveApiPath(base, "/me/api/json"), "https://host/ci/me/api/json");
    assert.equal(resolveApiPath(base, "me/api/json"), "https://host/ci/me/api/json");
    assert.equal(resolveApiPath(base, "/job/flowlet/api/json"), "https://host/ci/job/flowlet/api/json");
    assert.equal(resolveApiPath(base, "/api/json?tree=jobs"), "https://host/ci/api/json?tree=jobs");
    assert.equal(
      resolveApiPath(base, "/queue/item/1/api/json?tree=executable[url]"),
      "https://host/ci/queue/item/1/api/json?tree=executable[url]",
    );
  });

  it("拒绝空路径与绝对 URL（避免 Basic 凭据被发到别处）", () => {
    assert.throws(() => resolveApiPath(base, "  "), /API 路径不能为空/);
    assert.throws(
      () => resolveApiPath(base, "https://evil.example.com/me/api/json"),
      /API 路径必须是相对路径（如 \/me\/api\/json），不接受绝对 URL/,
    );
    assert.throws(() => resolveApiPath(base, "http://evil.example.com/x"), /不接受绝对 URL/);
  });
});

describe("jenkins 身份解析", () => {
  it("fullName 优先，其次 id；非字符串回退", () => {
    assert.equal(parseIdentityUsername({ id: "alice", fullName: "Alice Smith" }), "Alice Smith");
    assert.equal(parseIdentityUsername({ id: "alice", fullName: "" }), "alice");
    assert.equal(parseIdentityUsername({ id: "alice" }), "alice");
    assert.equal(parseIdentityUsername({ id: 7 }), null);
    assert.equal(parseIdentityUsername([]), null);
    assert.equal(parseIdentityUsername("alice"), null);
  });
});

describe("jenkins describeError / JenkinsError", () => {
  it("按状态码给出可执行提示，JSON 体的 message 拼在前面", () => {
    assert.equal(
      describeError(401, null),
      "用户名或 API Token 无效，请到 Jenkins 用户设置页确认 API Token",
    );
    assert.equal(
      describeError(403, { message: "Forbidden" }),
      "Forbidden（权限不足：该 Jenkins 用户可能缺少 Overall/Read 权限）",
    );
    assert.match(describeError(404, { error: "Not Found" }), /^Not Found（接口不存在/);
    assert.match(describeError(404, null), /不要带 \/me 或 \/api\/json/);
    assert.match(describeError(429, null), /触发 Jenkins 限流/);
    assert.match(describeError(500, null), /请检查用户名、token、实例地址与网络连通性/);
  });

  it("不把上游 HTML 错误页塞进 message", () => {
    const html = "<html><head><title>Error 401 Unauthorized</title></head></html>";
    const message = describeError(401, html);
    assert.equal(message, "用户名或 API Token 无效，请到 Jenkins 用户设置页确认 API Token");
    assert.ok(!message.includes("<html>"));
  });

  it("toString 与 Rust Display 一致", () => {
    assert.equal(new JenkinsError(401, "Unauthorized").toString(), "Jenkins API 401: Unauthorized");
    assert.equal(new JenkinsError(null, "boom").toString(), "Jenkins API: boom");
  });

  it("构造时立即拒绝空 token / 空用户名", () => {
    assert.throws(
      () => new JenkinsClient("https://host", JENKINS_USER, "  "),
      /Jenkins token 不能为空/,
    );
    assert.throws(
      () => new JenkinsClient("https://host", "  ", JENKINS_TOKEN),
      /Jenkins 用户名不能为空/,
    );
  });
});

describe("jenkins JenkinsClient（mock 服务器）", () => {
  it("identity：Basic 认证通过后返回 fullName 与 X-Jenkins 版本", async () => {
    const mock = await startMock({});
    const client = new JenkinsClient(mock.baseUrl, JENKINS_USER, JENKINS_TOKEN);
    assert.equal(client.base(), mock.baseUrl);
    assert.deepEqual(await client.identity(), {
      username: "Fixture User",
      version: "2.440.1",
    });
    mock.close();
  });

  it("identity：fullName 缺失回退 id；X-Jenkins 缺失时版本为 null", async () => {
    const mock = await startMock({ jenkinsFullName: null, jenkinsVersion: null });
    const client = new JenkinsClient(mock.baseUrl, JENKINS_USER, JENKINS_TOKEN);
    assert.deepEqual(await client.identity(), { username: JENKINS_USER, version: null });
    mock.close();
  });

  it("identity：token 无效 / 权限不足 / 接口不存在都给出契约文案", async () => {
    const ok = await startMock({});
    const badToken = new JenkinsClient(ok.baseUrl, JENKINS_USER, "wrong-token");
    await assert.rejects(badToken.identity(), (error: unknown) => {
      assert.ok(error instanceof JenkinsError);
      assert.equal(error.status, 401);
      assert.equal(
        error.toString(),
        "Jenkins API 401: Unauthorized（用户名或 API Token 无效，请到 Jenkins 用户设置页确认 API Token）",
      );
      return true;
    });
    ok.close();

    const forbidden = await startMock({ jenkinsMeStatus: 403 });
    await assert.rejects(
      new JenkinsClient(forbidden.baseUrl, JENKINS_USER, JENKINS_TOKEN).identity(),
      (error: unknown) =>
        error instanceof JenkinsError &&
        error.toString() ===
          "Jenkins API 403: Status 403（权限不足：该 Jenkins 用户可能缺少 Overall/Read 权限）",
    );
    forbidden.close();

    const missing = await startMock({ jenkinsMeStatus: 404 });
    await assert.rejects(
      new JenkinsClient(missing.baseUrl, JENKINS_USER, JENKINS_TOKEN).identity(),
      (error: unknown) =>
        error instanceof JenkinsError &&
        /^Jenkins API 404: Status 404（接口不存在：请确认填写的是 Jenkins 根地址/.test(
          error.toString(),
        ),
    );
    missing.close();
  });

  it("request：GET 透传、POST body 透传、404 映射", async () => {
    const mock = await startMock({});
    const client = new JenkinsClient(mock.baseUrl, JENKINS_USER, JENKINS_TOKEN);
    assert.deepEqual(await client.request("GET", "/job/flowlet/api/json"), {
      color: "blue",
      name: "flowlet",
    });
    assert.deepEqual(await client.request("POST", "/echo", { hello: 1 }), {
      method: "POST",
      body: { hello: 1 },
      path: "/echo",
    });
    await assert.rejects(
      client.request("GET", "/missing"),
      (error: unknown) =>
        error instanceof JenkinsError &&
        error.status === 404 &&
        error.toString().startsWith("Jenkins API 404: Not Found（接口不存在："),
    );
    await assert.rejects(
      client.request("GET", "https://evil.example.com/x"),
      (error: unknown) =>
        error instanceof JenkinsError &&
        error.status === null &&
        error.toString() ===
          "Jenkins API: API 路径必须是相对路径（如 /me/api/json），不接受绝对 URL",
    );
    mock.close();
  });

  it("identity：连不上时带 --insecure 提示且 status 为 null", async () => {
    // 127.0.0.1:1 连接被拒绝（Linux 上稳定）。
    const client = new JenkinsClient("http://127.0.0.1:1", JENKINS_USER, JENKINS_TOKEN);
    await assert.rejects(
      client.identity(),
      (error: unknown) =>
        error instanceof JenkinsError &&
        error.status === null &&
        /请求 http:\/\/127\.0\.0\.1:1\/me\/api\/json 失败：/.test(error.toString()) &&
        error.toString().includes("内网自签证书请加 --insecure"),
    );
  });
});