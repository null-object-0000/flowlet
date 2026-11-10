// Dockhand 客户端纯函数单测（URL 归一 / 路径构造 / 解析容错 / 错误提示）。
// 运行：node --test packages/flowlet-cred/src/__tests__/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  apiBase,
  describeError,
  DockhandClient,
  DockhandError,
  normalizeBaseUrl,
  parseEnvironments,
  resolveApiPath,
} from "../dockhand.ts";

describe("dockhand normalizeBaseUrl", () => {
  it("根地址/末尾斜杠/粘贴 /api 后缀都归一到面板根地址", () => {
    assert.equal(normalizeBaseUrl("http://10.177.40.105:3000"), "http://10.177.40.105:3000");
    assert.equal(normalizeBaseUrl("  http://10.177.40.105:3000/  "), "http://10.177.40.105:3000");
    assert.equal(normalizeBaseUrl("http://10.177.40.105:3000/api"), "http://10.177.40.105:3000");
    assert.equal(normalizeBaseUrl("http://10.177.40.105:3000/api/"), "http://10.177.40.105:3000");
  });

  it("保留子路径部署，https 正常", () => {
    assert.equal(normalizeBaseUrl("https://ops.example.com/dockhand"), "https://ops.example.com/dockhand");
    assert.equal(normalizeBaseUrl("https://ops.example.com/dockhand/"), "https://ops.example.com/dockhand");
  });

  it("拒绝空地址/非法 scheme/无主机/query/fragment", () => {
    assert.throws(() => normalizeBaseUrl("   "), /Dockhand 地址不能为空/);
    assert.throws(() => normalizeBaseUrl("ftp://host:3000"), /Dockhand 地址必须是 http 或 https/);
    assert.throws(() => normalizeBaseUrl("http://host:badport"), /Dockhand 地址无法解析/);
    // 不带 scheme 的 `host:port` 会被 URL 解析成 scheme，最终落到 scheme 校验（与 Rust 一致）。
    assert.throws(() => normalizeBaseUrl("dockhand.example.com:3000"), /Dockhand 地址必须是 http 或 https/);
    assert.throws(() => normalizeBaseUrl("http://"), /Dockhand 地址无法解析/);
    assert.throws(() => normalizeBaseUrl("http://host:3000/?a=1"), /Dockhand 地址不能带查询参数或锚点/);
    assert.throws(() => normalizeBaseUrl("http://host:3000/#top"), /Dockhand 地址不能带查询参数或锚点/);
  });

  it("apiBase 固定拼 /api", () => {
    assert.equal(apiBase("http://host:3000"), "http://host:3000/api");
  });
});

describe("dockhand resolveApiPath", () => {
  const base = "http://host:3000";

  it("相对路径、无前导斜杠、/api 前缀、query 都能正确拼接", () => {
    assert.equal(resolveApiPath(base, "/environments"), "http://host:3000/api/environments");
    assert.equal(resolveApiPath(base, "environments"), "http://host:3000/api/environments");
    assert.equal(resolveApiPath(base, "/api/environments"), "http://host:3000/api/environments");
    assert.equal(resolveApiPath(base, "/stacks?env=2"), "http://host:3000/api/stacks?env=2");
  });

  it("拒绝空路径与绝对 URL（避免 token 被发到别处）", () => {
    assert.throws(() => resolveApiPath(base, "  "), /API 路径不能为空/);
    assert.throws(
      () => resolveApiPath(base, "https://evil.example.com/x"),
      /API 路径必须是相对路径（如 \/environments），不接受绝对 URL/,
    );
  });
});

describe("dockhand parseEnvironments", () => {
  it("解析正常字段，缺失 host/port/protocol 归一为 null", () => {
    assert.deepEqual(
      parseEnvironments([
        { id: 2, name: "panel", host: "10.0.0.2", port: 2375, protocol: "http" },
        { id: 3, name: "local" },
      ]),
      [
        { id: 2, name: "panel", host: "10.0.0.2", port: 2375, protocol: "http" },
        { id: 3, name: "local", host: null, port: null, protocol: null },
      ],
    );
  });

  it("id 缺失/非数字的行跳过，name 缺失按空串，非数组报错", () => {
    assert.deepEqual(parseEnvironments([{ name: "no-id" }, { id: "2", name: "string-id" }, { id: 5 }]), [
      { id: 5, name: "", host: null, port: null, protocol: null },
    ]);
    assert.throws(
      () => parseEnvironments({ environments: [] }),
      (error: unknown) =>
        error instanceof DockhandError &&
        error.toString() === "Dockhand API: 解析环境列表失败：expected a sequence",
    );
  });
});

describe("dockhand describeError / DockhandError", () => {
  it("按状态码给出可执行提示，detail 优先取 message 再 error", () => {
    assert.equal(describeError(401, null), "token 无效或已过期，请到 Dockhand 生成新的 API Token");
    assert.equal(
      describeError(403, { message: "Forbidden" }),
      "Forbidden（权限不足：该 API Token 可能缺少管理员权限，或账号未启用）",
    );
    assert.match(describeError(404, { error: "Not Found" }), /^Not Found（接口不存在/);
    assert.match(describeError(429, null), /触发 Dockhand 限流/);
    assert.match(describeError(500, "raw text"), /^raw text（请检查 token、实例地址与网络连通性）/);
  });

  it("toString 与 Rust Display 一致", () => {
    assert.equal(new DockhandError(401, "Unauthorized").toString(), "Dockhand API 401: Unauthorized");
    assert.equal(new DockhandError(null, "boom").toString(), "Dockhand API: boom");
  });

  it("空 token 立即拒绝", () => {
    assert.throws(() => new DockhandClient("http://host:3000", "  "), /Dockhand token 不能为空/);
  });
});
