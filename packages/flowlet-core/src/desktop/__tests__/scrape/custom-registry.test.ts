// 自定义抓取描述符注册表（Rust core/custom_scrape.rs）契约测试。
//
// 覆盖：发现目录、schema 校验（跳过非法描述符）、accountName/fallback 匹配、
// 声明式 slot 规则的 classify/satisfies/merge。测试用临时目录，不读用户本机描述符。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  accountNameMatches,
  jsonPointer,
  listCustomScrapeChannelInfos,
  loadCustomScrapeRegistry,
  loginMatches,
  mergeArrays,
  pointerGet,
  reloadCustomScrapeRegistry,
  resolveCustomScrapeMode,
  slotSatisfies,
  urlMatches,
  type CustomDescriptor,
  type CustomScrapeRegistry,
} from "../../../scrape/custom-registry.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "flowlet-custom-scrape-"));
  process.env["FLOWLET_CUSTOM_SCRAPE_DIRS"] = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env["FLOWLET_CUSTOM_SCRAPE_DIRS"];
});

interface DescriptorFixture {
  name: string;
  manifest: Record<string, unknown>;
  extractor?: string;
  interceptor?: string;
}

function writeDescriptor(fixture: DescriptorFixture): string {
  const dir = path.join(root, fixture.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(fixture.manifest, null, 2));
  if (fixture.extractor !== undefined) writeFileSync(path.join(dir, "extractor.js"), fixture.extractor);
  if (fixture.interceptor !== undefined) {
    writeFileSync(path.join(dir, "interceptor.js"), fixture.interceptor);
  }
  return dir;
}

function fridayManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    channelId: "custom",
    accountName: "Friday",
    resourceModes: [{ resourceMode: "pay_as_you_go", modeKey: "paygo" }],
    login: { kind: "generic_or_host", host: "friday.example.com" },
    modes: {
      paygo: {
        consoleUrl: "https://friday.example.com/billing",
        consoleUrlSecondary: "https://friday.example.com/billing/history",
        consoleUrlTertiary: null,
        aggregate: true,
        requiredSlots: ["usage", "balance"],
        slots: {
          usage: {
            match: { kind: "url_substring", value: "/api/v2/usage", caseInsensitive: true },
            satisfies: { kind: "json_path", path: "$.data.used", expect: "number" },
            merge: { kind: "last_write_wins" },
          },
          balance: {
            match: { kind: "url_substring", value: "/api/v2/balance" },
            satisfies: { kind: "json_path", path: "$.data.amount", expect: "number" },
            merge: {
              kind: "merge_arrays",
              path: "$.data.messages",
              dedupBy: ["$.id"],
              keepFields: ["id", "text"],
            },
          },
        },
      },
    },
    summary: { plan: "API 按量付费" },
    ...overrides,
  };
}

function onlyDescriptor(registry: CustomScrapeRegistry): CustomDescriptor {
  assert.equal(registry.descriptors.length, 1, JSON.stringify(registry.errors));
  return registry.descriptors[0] as CustomDescriptor;
}

describe("自定义抓取描述符发现", () => {
  it("读取合法描述符并解析多阶段 URL / 槽位规则 / 登录规则", () => {
    writeDescriptor({ name: "friday", manifest: fridayManifest(), extractor: "function extract(bundle){return null;}" });
    const registry = loadCustomScrapeRegistry([root]);
    const descriptor = onlyDescriptor(registry);
    assert.equal(descriptor.channelId, "custom");
    assert.equal(descriptor.accountName, "Friday");
    assert.equal(descriptor.login.kind, "generic_or_host");
    const mode = descriptor.modes.get("paygo");
    assert.ok(mode !== undefined);
    assert.equal(mode.consoleUrlSecondary, "https://friday.example.com/billing/history");
    assert.equal(mode.consoleUrlTertiary, null);
    assert.deepEqual(mode.requiredSlots, ["usage", "balance"]);
    assert.equal(mode.slots.length, 2);
    assert.equal(mode.slots[0]?.key, "usage");
    assert.equal(mode.slots[0]?.satisfies.kind, "json_path");
    assert.deepEqual(listCustomScrapeChannelInfos(registry), [
      { channelId: "custom", accountName: "Friday" },
    ]);
  });

  it("跳过非法描述符并把错误写进 errors，不影响其它描述符", () => {
    writeDescriptor({ name: "friday", manifest: fridayManifest(), extractor: "function extract(){}" });
    writeDescriptor({
      name: "broken",
      manifest: fridayManifest({ schemaVersion: 2 }),
      extractor: "function extract(){}",
    });
    writeDescriptor({
      name: "no-extractor",
      manifest: fridayManifest({ accountName: "NoExtractor" }),
    });
    const registry = loadCustomScrapeRegistry([root]);
    assert.equal(registry.descriptors.length, 1);
    assert.equal(registry.errors.length, 2);
    assert.ok(registry.errors.some((error) => error.includes("不支持的 schemaVersion：2")));
    assert.ok(registry.errors.some((error) => error.includes("extractor.js 不能为空")));
  });

  it("custom 渠道缺少 accountName 且未声明 fallback 时拒绝加载", () => {
    const manifest = fridayManifest();
    delete manifest["accountName"];
    writeDescriptor({ name: "friday", manifest, extractor: "function extract(){}" });
    const registry = loadCustomScrapeRegistry([root]);
    assert.equal(registry.descriptors.length, 0);
    assert.ok(registry.errors[0]?.includes("必须声明 accountName"));
  });

  it("聚合模式缺少 requiredSlots 或引用未声明槽位时拒绝加载", () => {
    const missing = fridayManifest();
    const modes = missing["modes"] as Record<string, Record<string, unknown>>;
    modes["paygo"]!["requiredSlots"] = [];
    writeDescriptor({ name: "missing", manifest: missing, extractor: "function extract(){}" });
    const missingRegistry = loadCustomScrapeRegistry([root]);
    assert.equal(missingRegistry.descriptors.length, 0);
    assert.ok(missingRegistry.errors[0]?.includes("聚合抓取缺少 requiredSlots"));

    rmSync(path.join(root, "missing"), { recursive: true, force: true });
    const undeclared = fridayManifest();
    const undeclaredModes = undeclared["modes"] as Record<string, Record<string, unknown>>;
    undeclaredModes["paygo"]!["requiredSlots"] = ["usage", "ghost"];
    writeDescriptor({ name: "undeclared", manifest: undeclared, extractor: "function extract(){}" });
    const undeclaredRegistry = loadCustomScrapeRegistry([root]);
    assert.equal(undeclaredRegistry.descriptors.length, 0);
    assert.ok(undeclaredRegistry.errors[0]?.includes("引用了未声明的槽位：ghost"));
  });

  it("reload 替换进程内注册表并看到新增描述符", () => {
    const empty = reloadCustomScrapeRegistry();
    assert.equal(empty.descriptors.length, 0);
    writeDescriptor({ name: "friday", manifest: fridayManifest(), extractor: "function extract(){}" });
    const reloaded = reloadCustomScrapeRegistry();
    assert.equal(reloaded.descriptors.length, 1);
    assert.equal(listCustomScrapeChannelInfos(reloaded).length, 1);
  });
});

describe("自定义抓取描述符匹配", () => {
  function registryWith(): CustomScrapeRegistry {
    writeDescriptor({ name: "friday", manifest: fridayManifest(), extractor: "function extract(){}" });
    return loadCustomScrapeRegistry([root]);
  }

  it("accountName 大小写不敏感，先精确后子串", () => {
    assert.equal(accountNameMatches("Friday", "friday"), true);
    assert.equal(accountNameMatches("friday", "Friday Workspace"), true);
    // Rust 是双向子串匹配（actual.contains(expected) || expected.contains(actual)）。
    assert.equal(accountNameMatches("friday", "Fridayee"), true);
    assert.equal(accountNameMatches("friday workspace", "friday"), true);
    assert.equal(accountNameMatches("", "friday"), false);
    assert.equal(accountNameMatches("friday", ""), false);
  });

  it("custom 渠道按账号名解析到对应描述符，无匹配返回 null", () => {
    const registry = registryWith();
    const resolved = resolveCustomScrapeMode("custom", "friday", "pay_as_you_go", registry);
    assert.ok(resolved !== null);
    assert.equal(resolved.consoleUrl, "https://friday.example.com/billing");
    assert.equal(resolved.aggregate, true);
    assert.equal(resolved.summary.plan, "API 按量付费");
    assert.equal(resolveCustomScrapeMode("custom", "other", "pay_as_you_go", registry), null);
    // resource_mode 无法映射时回退 pay_as_you_go。
    assert.ok(resolveCustomScrapeMode("custom", "friday", "token_plan", registry) !== null);
  });

  it("fallback 描述符只在没有 accountName 时生效", () => {
    const manifest = fridayManifest({ fallback: true });
    delete manifest["accountName"];
    writeDescriptor({ name: "friday-fallback", manifest, extractor: "function extract(){}" });
    const registry = loadCustomScrapeRegistry([root]);
    assert.ok(resolveCustomScrapeMode("custom", "anything", null, registry) !== null);
  });
});

describe("声明式槽位规则", () => {
  it("url_matches 复刻 Rust 语义（子串大小写 / 前缀 / 精确去查询串 / 正则）", () => {
    assert.equal(
      urlMatches({ kind: "substring", value: "/API/V2", caseInsensitive: true }, "https://x/api/v2/usage"),
      true,
    );
    assert.equal(
      urlMatches({ kind: "substring", value: "/API/V2", caseInsensitive: false }, "https://x/api/v2/usage"),
      false,
    );
    assert.equal(urlMatches({ kind: "prefix", value: "https://X" }, "https://x/a"), true);
    assert.equal(urlMatches({ kind: "exact", value: "https://x/a/" }, "https://x/a?page=1"), true);
    assert.equal(urlMatches({ kind: "exact", value: "https://x/a" }, "https://x/b"), false);
    assert.equal(
      urlMatches({ kind: "regex", pattern: "/api/v\\d+", regex: /\/api\/v\d+/ }, "https://x/api/v2"),
      true,
    );
    assert.equal(urlMatches({ kind: "fallback" }, "https://x/a"), false);
  });

  it("slot_satisfies 区分真数据与登录失效信封", () => {
    assert.equal(slotSatisfies({ kind: "json_valid" }, '{"ok":1}'), true);
    assert.equal(slotSatisfies({ kind: "json_valid" }, "not-json"), false);
    assert.equal(slotSatisfies({ kind: "none" }, "anything"), true);
    const rule = { kind: "json_path" as const, path: "$.data.used", expect: "number" as const };
    assert.equal(slotSatisfies(rule, '{"data":{"used":12}}'), true);
    assert.equal(slotSatisfies(rule, '{"data":{"used":"12"}}'), false);
    // 登录失效：合法 JSON 但缺少业务字段 → 判定未抓全。
    assert.equal(slotSatisfies(rule, '{"code":"UNAUTHORIZED"}'), false);
    assert.equal(
      slotSatisfies({ kind: "json_path", path: "/data/secToken", expect: "nonempty_string" }, '{"data":{"secToken":"t"}}'),
      true,
    );
  });

  it("json_pointer 支持 $.a.b[0] 与 /a/b/0，并保留信封其它字段", () => {
    assert.equal(jsonPointer("$.a.b[0]"), "/a/b/0");
    assert.equal(jsonPointer("/a/b/0"), "/a/b/0");
    assert.equal(jsonPointer(""), null);
    assert.equal(jsonPointer("a.b"), null);
    assert.equal(pointerGet({ a: { b: [1] } }, "/a/b/0"), 1);
  });

  it("merge_arrays 按 dedupBy 去重（后到覆盖先到）并裁剪 keepFields", () => {
    const existing = JSON.stringify({
      code: 0,
      data: {
        messages: [
          { id: 1, text: "a", secret: "x" },
          { id: 2, text: "b", secret: "y" },
        ],
      },
    });
    const incoming = JSON.stringify({
      code: 0,
      data: {
        messages: [
          { id: 2, text: "b2", secret: "z" },
          { id: 3, text: "c", secret: "w" },
        ],
      },
    });
    const merged = mergeArrays("$.data.messages", ["$.id"], ["id", "text"], existing, incoming);
    assert.ok(merged !== null);
    const parsed = JSON.parse(merged) as { code: number; data: { messages: Array<Record<string, unknown>> } };
    assert.equal(parsed.code, 0);
    assert.deepEqual(parsed.data.messages, [
      { id: 1, text: "a" },
      { id: 2, text: "b2" },
      { id: 3, text: "c" },
    ]);
    assert.equal(mergeArrays("$.data.missing", [], [], existing, incoming), null);
  });

  it("login_matches 复刻 generic / generic_or_host", () => {
    assert.equal(loginMatches({ kind: "none" }, "https://x/login"), false);
    assert.equal(loginMatches({ kind: "generic" }, "https://x/login"), true);
    assert.equal(loginMatches({ kind: "generic" }, "https://x/dashboard"), false);
    assert.equal(
      loginMatches({ kind: "generic_or_host", host: "account.aliyun.com" }, "https://account.aliyun.com/oauth"),
      true,
    );
  });
});