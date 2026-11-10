// Uptime Kuma Web Host 适配测试（客户端 + 保存校验 + pull 键名）。Owner: node-web.
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/uptime-kuma.test.ts
// 覆盖：地址归一（子路径/fragment/query）、/metrics Basic 鉴权、401 与 200-HTML 区分、
// 重定向不跟随、monitor_status/app_version 解析、checkUptimeKuma 的 detail/version、
// envKeys 生成 UPTIME_KUMA_URL / UPTIME_KUMA_API_KEY。
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { checkUptimeKuma, envKeys } from "../credentials.ts";
import {
  UptimeKumaClient,
  UptimeKumaError,
  authorizationHeader,
  metricsUrl,
  normalizeBaseUrl,
  parseMetrics,
  summarizeMetrics,
} from "../uptime-kuma.ts";

const API_KEY = "uk1_fixture-key-8r3x";
const FIXTURE = `# HELP monitor_status Monitor status
# TYPE monitor_status gauge
monitor_status{monitor_id="1",monitor_name="HG 英文站",monitor_type="group",monitor_url="https://"} 1
monitor_status{monitor_id="47",monitor_name="生产 Redis .11",monitor_type="redis",monitor_url="tcp://"} 0
# HELP app_version The service version by package.json
# TYPE app_version gauge
app_version{version="0.0.28",major="0",minor="0",patch="28"} 1
nodejs_version_info{version="v20.19.4"} 1
`;

interface MockServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startMock(): Promise<MockServer> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.setHeader("connection", "close");
    if (pathname === "/uptime-kuma/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      response.end(FIXTURE);
      return;
    }
    if (pathname === "/html/metrics") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!DOCTYPE html><html><body>Uptime Kuma</body></html>");
      return;
    }
    if (pathname === "/denied/metrics") {
      response.writeHead(401, { "content-type": "text/html; charset=utf-8" });
      response.end("");
      return;
    }
    if (pathname === "/moved/metrics") {
      response.writeHead(302, { location: "http://127.0.0.1:9/uptime-kuma/metrics" });
      response.end("");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

describe("uptime-kuma normalizeBaseUrl（Web Host）", () => {
  it("保留子路径、丢弃 fragment、去掉末尾 /metrics", () => {
    assert.equal(
      normalizeBaseUrl("https://host/uptime-kuma/#/settings/api-keys"),
      "https://host/uptime-kuma",
    );
    assert.equal(normalizeBaseUrl("https://host/uptime-kuma/metrics/"), "https://host/uptime-kuma");
    assert.equal(normalizeBaseUrl("http://host:3001"), "http://host:3001");
  });

  it("拒绝空地址 / query / 账号密码", () => {
    assert.throws(() => normalizeBaseUrl(""), /不能为空/);
    assert.throws(() => normalizeBaseUrl("https://host/uptime-kuma?x=1"), /查询参数或账号密码/);
    assert.throws(() => normalizeBaseUrl("https://u:p@host/uptime-kuma"), /查询参数或账号密码/);
  });
});

describe("uptime-kuma 指标与鉴权", () => {
  it("拼 URL 与 Basic（空用户名）", () => {
    assert.equal(metricsUrl("https://host/uptime-kuma"), "https://host/uptime-kuma/metrics");
    assert.equal(authorizationHeader("secret-key"), "Basic OnNlY3JldC1rZXk=");
  });

  it("解析 monitor_status 与 app_version", () => {
    const metrics = parseMetrics(FIXTURE);
    assert.equal(metrics.samples, 4);
    assert.equal(metrics.version, "0.0.28");
    assert.deepEqual(metrics.monitors, [
      { id: "1", name: "HG 英文站", type: "group", up: true },
      { id: "47", name: "生产 Redis .11", type: "redis", up: false },
    ]);
    assert.equal(summarizeMetrics(metrics), "2 个监控（1 正常 / 1 异常）");
  });
});

describe("uptime-kuma client 与 checkUptimeKuma", () => {
  it("子路径实例校验成功：detail 为监控摘要，version 取内部构建版本", async () => {
    const mock = await startMock();
    try {
      const base = `${mock.baseUrl}/uptime-kuma`;
      const check = await checkUptimeKuma(base, API_KEY, false);
      assert.equal(check.ok, true);
      assert.equal(check.detail, "2 个监控（1 正常 / 1 异常）");
      assert.equal(check.version, "0.0.28");
      assert.equal(check.username, null);
      assert.equal(check.error, null);

      const client = new UptimeKumaClient(base, API_KEY);
      assert.equal(client.metricsUrl(), `${base}/metrics`);
    } finally {
      await mock.close();
    }
  });

  it("401 返回可执行提示", async () => {
    const mock = await startMock();
    try {
      const check = await checkUptimeKuma(`${mock.baseUrl}/denied`, API_KEY, false);
      assert.equal(check.ok, false);
      assert.match(check.error ?? "", /Uptime Kuma API 401: 已拒绝这把 API Key/);
      assert.equal(check.detail, null);
    } finally {
      await mock.close();
    }
  });

  it("200 HTML 不能当成指标", async () => {
    const mock = await startMock();
    try {
      const check = await checkUptimeKuma(`${mock.baseUrl}/html`, API_KEY, false);
      assert.equal(check.ok, false);
      assert.match(check.error ?? "", /返回的不是 Prometheus 指标/);
    } finally {
      await mock.close();
    }
  });

  it("不跟随重定向", async () => {
    const mock = await startMock();
    try {
      const client = new UptimeKumaClient(`${mock.baseUrl}/moved`, API_KEY);
      await assert.rejects(
        () => client.metrics(),
        (error: unknown) => error instanceof UptimeKumaError && /返回重定向/.test(error.toString()),
      );
    } finally {
      await mock.close();
    }
  });
});

describe("uptime-kuma envKeys", () => {
  const base = {
    name: "TW Kuma",
    provider: "uptime-kuma",
    baseUrl: "https://host/uptime-kuma",
    username: null,
    envPrefix: "",
    token: "fixture-token",
  };

  it("默认前缀生成 UPTIME_KUMA_URL / UPTIME_KUMA_API_KEY", () => {
    assert.deepEqual(envKeys(base), [
      ["UPTIME_KUMA_URL", "https://host/uptime-kuma", "service"],
      ["UPTIME_KUMA_API_KEY", "fixture-token", "cli_token"],
    ]);
  });

  it("多实例前缀跟随，token 键仍是 _API_KEY", () => {
    const keys = envKeys({ ...base, envPrefix: "UPTIME_KUMA_TW" }).map(([key]) => key);
    assert.deepEqual(keys, ["UPTIME_KUMA_TW_URL", "UPTIME_KUMA_TW_API_KEY"]);
  });
});