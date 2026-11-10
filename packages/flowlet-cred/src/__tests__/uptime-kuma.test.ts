// Uptime Kuma 客户端单测（地址归一 / /metrics 解析 / 鉴权与错误映射 / 重定向不跟随）。
// 运行：node --test packages/flowlet-cred/src/__tests__/
//
// mock 用同名进程内的 node:http 提供：这里只测客户端模块（不启动 CLI 进程），
// 与 cli.test.ts 需要子进程 mock 的场景不同。
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import {
  UptimeKumaClient,
  UptimeKumaError,
  authorizationHeader,
  metricsUrl,
  normalizeBaseUrl,
  parseMetrics,
  summarizeMetrics,
} from "../uptime-kuma.ts";

const API_KEY = "uk1_fixture-key-7q2w";
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

/** 按路径返回不同的 `/metrics` 行为；路径前缀用于区分场景与子路径部署。 */
async function startMock(): Promise<MockServer> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? "";
    const pathname = new URL(url, "http://127.0.0.1").pathname;
    response.setHeader("connection", "close");
    if (pathname === "/uptime-kuma/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      response.end(FIXTURE);
      return;
    }
    if (pathname === "/html/metrics") {
      // 子路径写错时 SPA 兜底会返回 200 HTML——必须识别为错误。
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
    if (pathname === "/missing/metrics") {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end("Not Found");
      return;
    }
    if (pathname === "/empty/metrics") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
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

describe("uptime-kuma normalizeBaseUrl", () => {
  it("保留子路径部署并去掉末尾斜杠", () => {
    assert.equal(
      normalizeBaseUrl("https://tcwireless.qa.17usoft.com/uptime-kuma"),
      "https://tcwireless.qa.17usoft.com/uptime-kuma",
    );
    assert.equal(
      normalizeBaseUrl("  https://tcwireless.qa.17usoft.com/uptime-kuma//  "),
      "https://tcwireless.qa.17usoft.com/uptime-kuma",
    );
    assert.equal(normalizeBaseUrl("http://host:3001/"), "http://host:3001");
  });

  it("用户粘贴的前端设置页地址：丢掉 fragment", () => {
    assert.equal(
      normalizeBaseUrl("https://host/uptime-kuma/#/settings/api-keys"),
      "https://host/uptime-kuma",
    );
  });

  it("粘贴到 /metrics 时归一掉", () => {
    assert.equal(normalizeBaseUrl("https://host/uptime-kuma/metrics"), "https://host/uptime-kuma");
  });

  it("拒绝空地址 / 非法 scheme / query / 账号密码", () => {
    assert.throws(() => normalizeBaseUrl("   "), /Uptime Kuma 地址不能为空/);
    assert.throws(() => normalizeBaseUrl("ftp://host"), /必须以 http:\/\/ 或 https:\/\//);
    assert.throws(() => normalizeBaseUrl("https://host/uptime-kuma?x=1"), /查询参数或账号密码/);
    assert.throws(() => normalizeBaseUrl("https://user:pass@host/uptime-kuma"), /查询参数或账号密码/);
  });
});

describe("uptime-kuma metrics url 与鉴权头", () => {
  it("拼 /metrics 并把空用户名 + Key 编成 Basic", () => {
    assert.equal(metricsUrl("https://host/uptime-kuma"), "https://host/uptime-kuma/metrics");
    assert.equal(authorizationHeader("secret-key"), "Basic OnNlY3JldC1rZXk=");
    assert.equal(
      authorizationHeader(API_KEY),
      `Basic ${Buffer.from(`:${API_KEY}`, "utf8").toString("base64")}`,
    );
  });
});

describe("uptime-kuma parseMetrics", () => {
  it("解析 monitor_status / app_version，label 值可含空格", () => {
    const metrics = parseMetrics(FIXTURE);
    assert.equal(metrics.samples, 4);
    assert.equal(metrics.version, "0.0.28");
    assert.deepEqual(metrics.monitors, [
      { id: "1", name: "HG 英文站", type: "group", up: true },
      { id: "47", name: "生产 Redis .11", type: "redis", up: false },
    ]);
    assert.equal(summarizeMetrics(metrics), "2 个监控（1 正常 / 1 异常）");
  });

  it("支持 Prometheus 转义并忽略注释", () => {
    const metrics = parseMetrics(
      '# comment\nmonitor_status{monitor_id="2",monitor_name="a \\"quoted\\" name",monitor_type="http"} 1\n',
    );
    assert.equal(metrics.samples, 1);
    assert.equal(metrics.monitors[0]?.name, 'a "quoted" name');
    assert.equal(metrics.monitors[0]?.up, true);
  });

  it("空文本没有样本", () => {
    const metrics = parseMetrics("");
    assert.equal(metrics.samples, 0);
    assert.deepEqual(metrics.monitors, []);
    assert.equal(summarizeMetrics(metrics), "0 个监控（0 正常 / 0 异常）");
  });
});

describe("uptime-kuma client", () => {
  it("子路径部署能取到指标", async () => {
    const mock = await startMock();
    try {
      const client = new UptimeKumaClient(`${mock.baseUrl}/uptime-kuma`, API_KEY);
      const metrics = await client.metrics();
      assert.equal(metrics.monitors.length, 2);
      assert.equal(client.metricsUrl(), `${mock.baseUrl}/uptime-kuma/metrics`);
    } finally {
      await mock.close();
    }
  });

  it("401 映射为 Key 无效的可执行提示", async () => {
    const mock = await startMock();
    try {
      const client = new UptimeKumaClient(`${mock.baseUrl}/denied`, API_KEY);
      await assert.rejects(
        () => client.metrics(),
        (error: unknown) => {
          assert.ok(error instanceof UptimeKumaError);
          assert.equal(error.status, 401);
          assert.match(error.toString(), /Uptime Kuma API 401: 已拒绝这把 API Key/);
          return true;
        },
      );
    } finally {
      await mock.close();
    }
  });

  it("200 HTML（SPA 兜底）不能被当成指标", async () => {
    const mock = await startMock();
    try {
      const client = new UptimeKumaClient(`${mock.baseUrl}/html`, API_KEY);
      await assert.rejects(
        () => client.metrics(),
        /返回的不是 Prometheus 指标（HTTP 200, text\/html/,
      );
    } finally {
      await mock.close();
    }
  });

  it("不跟随重定向", async () => {
    const mock = await startMock();
    try {
      const client = new UptimeKumaClient(`${mock.baseUrl}/moved`, API_KEY);
      await assert.rejects(() => client.metrics(), /返回重定向（HTTP 302）/);
    } finally {
      await mock.close();
    }
  });

  it("404 提示检查子路径", async () => {
    const mock = await startMock();
    try {
      const client = new UptimeKumaClient(`${mock.baseUrl}/missing`, API_KEY);
      await assert.rejects(() => client.metrics(), /子路径部署需带 \/uptime-kuma/);
    } finally {
      await mock.close();
    }
  });

  it("200 但没有样本也算失败", async () => {
    const mock = await startMock();
    try {
      const client = new UptimeKumaClient(`${mock.baseUrl}/empty`, API_KEY);
      await assert.rejects(() => client.metrics(), /没有返回任何指标样本/);
    } finally {
      await mock.close();
    }
  });

  it("空 API Key 直接拒绝", () => {
    assert.throws(
      () => new UptimeKumaClient("https://host/uptime-kuma", "  "),
      /Uptime Kuma API Key 不能为空/,
    );
  });
});