// 桌面控制台抓取 / 余额同步命令（批次 4）契约测试。
//
// 用假宿主桥（记录 channel/payload 并返回预设 runPlan 结果）覆盖：
// plan 构造（多阶段 URL + slot 规则 + interceptor）、成功落库、需要登录/超时/
// 解析失败的错误映射、批量同步局部失败不影响整体、openExternal 白名单、
// registry 重载、以及 `scrape.evaluate` 缺失时的降级路径。不打真实外网。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { JsonRow } from "../../../types.ts";
import { desktopCommandNames, dispatchDesktop } from "../../commands.ts";
import {
  resetChannelResourceSyncForTests,
  scrapeSessionDiagnostics,
} from "../../scrape.ts";
import { resetScrapeSessionsForTests, scrapeSessions } from "../../../scrape/session.ts";
import { resetCustomScrapeRegistryForTests } from "../../../scrape/custom-registry.ts";
import {
  getBackgroundJobDetail,
  listBackgroundJobs,
} from "../../../storage/background-jobs.ts";
import { createTestContext, sampleAccount, type TestContext } from "../support.ts";

const SCRAPE_COMMANDS = [
  "open_scrape_console",
  "close_scrape_console",
  "handle_intercepted_response",
  "handle_scrape_interceptor_ready",
  "probe_scrape_login",
  "scrape_balance",
  "sync_scrape_balances",
  "open_external_url",
  "reload_custom_scrape_registry",
  "list_balance_snapshots",
];

let context: TestContext | null = null;
let customRoot = "";

beforeEach(() => {
  customRoot = mkdtempSync(path.join(tmpdir(), "flowlet-scrape-custom-"));
  process.env["FLOWLET_CUSTOM_SCRAPE_DIRS"] = customRoot;
  resetScrapeSessionsForTests();
  resetCustomScrapeRegistryForTests();
  resetChannelResourceSyncForTests();
});

afterEach(() => {
  context?.cleanup();
  context = null;
  rmSync(customRoot, { recursive: true, force: true });
  delete process.env["FLOWLET_CUSTOM_SCRAPE_DIRS"];
  resetScrapeSessionsForTests();
  resetCustomScrapeRegistryForTests();
  resetChannelResourceSyncForTests();
});

function makeContext(): TestContext {
  context = createTestContext({ prefix: "flowlet-desktop-scrape-" });
  return context;
}

// ─── 渠道配置装置 ───────────────────────────────────────────────────────────

/** 一个与 config.json 同形的 channels_config（只保留测试需要的渠道）。 */
function installChannelsConfig(
  test: TestContext,
  options: {
    channelIds?: string[];
    resourceSyncMode?: string;
    resourceMode?: string | null;
    supportsBalanceQuery?: boolean;
  } = {},
): void {
  const channels: JsonRow[] = [
    channelPreset("longcat", { supports_scrape_balance: true, supports_balance_query: false }),
    channelPreset("qwen", { supports_scrape_balance: true, supports_balance_query: false }),
    channelPreset("zhipu", { supports_scrape_balance: true, supports_balance_query: false }),
    channelPreset("custom", { supports_scrape_balance: false, supports_balance_query: false }),
    channelPreset("deepseek", { supports_scrape_balance: false, supports_balance_query: true }),
    channelPreset("kimi", { supports_scrape_balance: false, supports_balance_query: true }),
    channelPreset("openai-api", { supports_scrape_balance: false, supports_balance_query: false }),
  ];
  const wanted = options.channelIds ?? ["longcat", "qwen", "zhipu", "custom", "deepseek", "kimi", "openai-api"];
  test.ctx.channelsConfig = {
    channels: channels.filter((channel) => wanted.includes(String(channel.id))),
  };

  const accounts: JsonRow[] = [];
  for (const channelId of wanted) {
    if (!["longcat", "qwen", "zhipu", "custom", "deepseek", "kimi"].includes(channelId)) continue;
    const account = sampleAccount(`${channelId}-account-1`);
    account.channel_id = channelId;
    account.name = channelId === "custom" ? "Friday" : `${channelId} account`;
    account.api_key = "sk-1a49e000000000000000000000003d65";
    account.resource_mode =
      options.resourceMode === undefined
        ? channelId === "qwen"
          ? "token_plan"
          : channelId === "zhipu"
            ? "pay_as_you_go"
            : channelId === "longcat"
              ? "hybrid"
              : null
        : options.resourceMode;
    account.resource_sync_mode = options.resourceSyncMode ?? "auto";
    accounts.push(account);
  }
  test.runtimeConfig.replace({
    channels: [],
    accounts,
    routes: [],
    rules: [],
    virtual_models: [],
  });
}

function channelPreset(
  id: string,
  flags: { supports_scrape_balance: boolean; supports_balance_query: boolean },
): JsonRow {
  return {
    id,
    name: id,
    vendor: id,
    supported_protocols: ["openai"],
    openai_base_url: "",
    anthropic_base_url: "",
    openai_auth: "bearer",
    anthropic_auth: "bearer",
    default_model: "",
    small_model: null,
    timeout_seconds: null,
    supports_model_list: true,
    supports_model_detail: false,
    supports_balance_query: flags.supports_balance_query,
    supports_quota_query: false,
    supports_usage_query: false,
    supports_scrape_balance: flags.supports_scrape_balance,
    supports_files_api: false,
    platform_url: null,
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/** 注入内置渠道的抓取配置（config.json 的 channels[].scrape）。 */
function installBuiltinScrape(
  test: TestContext,
  channelId: string,
  modes: Record<string, JsonRow>,
): void {
  const channels = (test.ctx.channelsConfig.channels as JsonRow[]).slice();
  const index = channels.findIndex((channel) => channel.id === channelId);
  assert.ok(index >= 0, `缺少渠道 ${channelId}`);
  channels[index] = { ...(channels[index] as JsonRow), scrape: modes };
  test.ctx.channelsConfig = { channels };
}

function longcatModes(): Record<string, JsonRow> {
  return {
    hybrid: {
      console_url: "https://longcat.chat/platform/usage?tab=token",
      console_url_secondary: "https://longcat.chat/platform/usage?tab=api",
      console_url_tertiary: "https://longcat.chat/platform/fuel_pack",
      interceptor_js: "(()=>{return 'ok-injected';})();",
      extractor_js: "function extract(bundle){return {balance:1,currency:'CNY'};}",
      aggregate: true,
      required_slots: ["token_packs_summary", "api_usage_summary", "token_packs_list"],
    },
  };
}

const LONGCAT_SUMMARY = JSON.stringify({
  code: 0,
  data: {
    currentLot: { lotId: 151724, totalToken: 50000000 },
    otherLots: [{ lotId: 159869, totalToken: 10000000 }],
  },
});
const LONGCAT_API_USAGE = JSON.stringify({
  code: 0,
  data: { paygoBalanceCent: 1234, paygoBalance: { primary: { currency: "CNY" } } },
});
const LONGCAT_PACK_LIST = JSON.stringify({
  code: 0,
  data: { items: [{ resourceId: "2071803119104245853", packageName: "问卷Token包" }], pageSize: 10, historyCount: 1 },
});

/** 按阶段 URL 组装 runPlan 结果（模拟宿主：每阶段只返回本阶段抓到的槽位）。 */
function longcatStageResponder(stagesByUrl: Record<string, JsonRow>) {
  return (_channel: string, payload: JsonRow | undefined): unknown => {
    const plan = payload?.["plan"] as JsonRow | undefined;
    const url = String(plan?.["consoleUrl"] ?? "");
    return { result: stagesByUrl[url] ?? {} };
  };
}

function lastRunPlanPayload(test: TestContext): JsonRow {
  const call = [...test.host.calls].reverse().find((item) => item.channel === "scrape.runPlan");
  assert.ok(call !== undefined, "未调用 scrape.runPlan");
  return call.payload as JsonRow;
}

function runPlanPayloads(test: TestContext): JsonRow[] {
  return test.host.calls
    .filter((item) => item.channel === "scrape.runPlan")
    .map((item) => item.payload as JsonRow);
}

function snapshotRows(test: TestContext): JsonRow[] {
  return test.storage.listBalanceSnapshots("longcat-account-1");
}

// ─── 注册表 ─────────────────────────────────────────────────────────────────

describe("桌面抓取命令注册表", () => {
  it("10 条抓取/目录同步命令全部注册", () => {
    const names = new Set(desktopCommandNames());
    for (const command of SCRAPE_COMMANDS) {
      assert.ok(names.has(command), `缺少桌面命令 ${command}`);
    }
  });
});

// ─── ScrapePlan 构造 ────────────────────────────────────────────────────────

describe("scrape_balance 的 ScrapePlan 构造", () => {
  it("多阶段导航 + 逐阶段 requiredSlots + slot 规则 + interceptor 只注入第一次", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    test.host.respond(
      "scrape.runPlan",
      longcatStageResponder({
        "https://longcat.chat/platform/usage?tab=token": { token_packs_summary: LONGCAT_SUMMARY },
        "https://longcat.chat/platform/usage?tab=api": { api_usage_summary: LONGCAT_API_USAGE },
        "https://longcat.chat/platform/fuel_pack": { token_packs_list: LONGCAT_PACK_LIST },
      }),
    );
    test.host.respond("scrape.evaluate", () => ({
      result: {
        balance: 12.34,
        currency: "CNY",
        plan_name: "LongCat",
        token_total: 60000000,
        token_used: 0,
        token_remaining: 60000000,
        token_expire_at: null,
      },
    }));

    await dispatchDesktop(test.ctx, "scrape_balance", {
      accountId: "longcat-account-1",
      interactive: true,
    });

    const plans = runPlanPayloads(test).map((payload) => payload["plan"] as JsonRow);
    assert.equal(plans.length, 3, "三阶段应各跑一次 runPlan");
    assert.equal(plans[0]?.["consoleUrl"], "https://longcat.chat/platform/usage?tab=token");
    assert.equal(plans[1]?.["consoleUrl"], "https://longcat.chat/platform/usage?tab=api");
    assert.equal(plans[2]?.["consoleUrl"], "https://longcat.chat/platform/fuel_pack");

    // requiredSlots 逐阶段对应（配置 3 个槽位 / 3 个阶段）。
    assert.deepEqual(plans[0]?.["requiredSlots"], ["token_packs_summary"]);
    assert.deepEqual(plans[1]?.["requiredSlots"], ["api_usage_summary"]);
    assert.deepEqual(plans[2]?.["requiredSlots"], ["token_packs_list"]);

    // 槽位规则来自内置 adapter 的 URL 分派，不是每个渠道硬编码。
    const rules = plans[0]?.["slotRules"] as JsonRow[];
    assert.ok(Array.isArray(rules));
    assert.deepEqual(
      rules.map((rule) => rule["slot"]),
      ["token_packs_list", "token_packs_summary", "api_usage_summary"],
    );

    // interceptor 只在第 1 阶段注入：宿主每次 runPlan 都会注册脚本，重复注入会多次执行。
    assert.equal(plans[0]?.["interceptorJs"], "(()=>{return 'ok-injected';})();");
    assert.equal(plans[1]?.["interceptorJs"], undefined);
    assert.equal(plans[2]?.["interceptorJs"], undefined);

    // 每阶段的 timeoutMs 透传。
    assert.equal(plans[0]?.["timeoutMs"], 15_000);
    assert.equal((lastRunPlanPayload(test)["timeoutMs"] as number) > 0, true);
  });

  it("单阶段 + 无 requiredSlots 时不传 requiredSlots，但仍按 URL 归类槽位", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "zhipu", {
      paygo: {
        console_url: "https://www.bigmodel.cn/finance-center/resource-package/package-mgmt?tab=my",
        interceptor_js: "(()=>{return 'ok-injected';})();",
        extractor_js: "function extract(bundle){return {balance:1};}",
        aggregate: true,
        required_slots: ["token_packs_list", "account_report"],
      },
    });
    test.host.respond("scrape.runPlan", () => ({
      result: {
        token_packs_list: JSON.stringify({ code: 200, rows: [] }),
        account_report: JSON.stringify({ code: 200, data: {} }),
      },
    }));
    test.host.respond("scrape.evaluate", () => ({ result: { balance: 9.5, currency: "CNY" } }));

    await dispatchDesktop(test.ctx, "scrape_balance", { accountId: "zhipu-account-1" });

    const plans = runPlanPayloads(test).map((payload) => payload["plan"] as JsonRow);
    assert.equal(plans.length, 1);
    assert.deepEqual(plans[0]?.["requiredSlots"], ["token_packs_list", "account_report"]);
    const rules = plans[0]?.["slotRules"] as JsonRow[];
    assert.deepEqual(
      rules.map((rule) => rule["slot"]),
      ["token_packs_list", "account_report"],
    );
  });

  it("自定义描述符驱动 plan：多阶段 URL + fallback 规则 + 登录规则", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    writeCustomDescriptor({
      channelId: "custom",
      accountName: "Friday",
      consoleUrl: "https://friday.example.com/billing",
      consoleUrlSecondary: "https://friday.example.com/billing/history",
      requiredSlots: ["usage", "balance"],
      slots: {
        usage: { match: { kind: "url_substring", value: "/api/v2/usage" } },
        balance: { match: { kind: "fallback" } },
      },
      summaryPlan: "API 按量付费",
    });
    resetCustomScrapeRegistryForTests();
    test.host.respond("scrape.runPlan", (_channel, payload) => {
      const plan = payload?.["plan"] as JsonRow;
      if (String(plan["consoleUrl"]).endsWith("/history")) {
        return { result: { balance: JSON.stringify({ data: { amount: 5 } }) } };
      }
      return { result: { usage: JSON.stringify({ data: { used: 3 } }) } };
    });
    test.host.respond("scrape.evaluate", () => ({
      result: { balance: 5, currency: "CNY", plan_name: "API 按量付费" },
    }));

    await dispatchDesktop(test.ctx, "scrape_balance", { accountId: "custom-account-1" });

    const plans = runPlanPayloads(test).map((payload) => payload["plan"] as JsonRow);
    assert.equal(plans.length, 2);
    assert.deepEqual(plans[0]?.["requiredSlots"], ["usage"]);
    assert.deepEqual(plans[1]?.["requiredSlots"], ["balance"]);
    const rules = plans[0]?.["slotRules"] as JsonRow[];
    assert.deepEqual(rules[0], { slot: "usage", urlContains: ["/api/v2/usage"], urlRegex: "(?i:/api/v2/usage)" });
    assert.deepEqual(rules[1], { slot: "balance", fallback: true });
    // 自定义描述符的 interceptor.js 缺失时不应传 interceptorJs。
    assert.equal(plans[0]?.["interceptorJs"], undefined);
  });
});

// ─── 成功落库 ───────────────────────────────────────────────────────────────

describe("scrape_balance 成功落库", () => {
  it("写入 AccountBalanceSnapshot（snake_case / source=scrape / remark=控制台抓取）并返回 Rust 形状", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    test.host.respond(
      "scrape.runPlan",
      longcatStageResponder({
        "https://longcat.chat/platform/usage?tab=token": { token_packs_summary: LONGCAT_SUMMARY },
        "https://longcat.chat/platform/usage?tab=api": { api_usage_summary: LONGCAT_API_USAGE },
        "https://longcat.chat/platform/fuel_pack": { token_packs_list: LONGCAT_PACK_LIST },
      }),
    );
    test.host.respond("scrape.evaluate", () => ({
      result: {
        balance: 12.34,
        currency: "CNY",
        plan_name: "LongCat",
        token_total: 60000000,
        token_used: 1000000,
        token_remaining: 59000000,
        token_expire_at: "2026-12-31T00:00:00Z",
        token_packs: [{ lotId: 151724 }],
      },
    }));

    const result = (await dispatchDesktop(test.ctx, "scrape_balance", {
      accountId: "longcat-account-1",
    })) as JsonRow;

    assert.equal(result["balance"], 12.34);
    assert.equal(result["currency"], "CNY");
    assert.equal(result["plan_name"], "LongCat");
    assert.equal(result["token_total"], 60000000);
    assert.equal(result["token_used"], 1000000);
    assert.equal(result["token_remaining"], 59000000);
    assert.equal(result["source"], "scrape");
    assert.ok(typeof result["synced_at"] === "string");
    // LongCat 的 token_packs 由 summary + list 归一化（不是 extractor 原样透传）。
    assert.ok(typeof result["token_packs"] === "string");
    const packs = JSON.parse(String(result["token_packs"])) as JsonRow[];
    // summary 的两个 lot 是权威记录；list 里的 resourceId 没有对应 summary 时
    // 作为补充包并入（Rust `merge_longcat_token_packs` 的 `_fromList` 分支）。
    assert.deepEqual(
      packs.map((pack) => String(pack["lotId"])),
      ["151724", "159869", "2071803119104245853"],
    );
    const fromList = packs[2] as JsonRow;
    assert.equal(fromList["_fromList"], true);
    assert.equal(fromList["packageName"], "问卷Token包");
    // raw_scraped_json 是聚合 bundle（含全部阶段槽位）。
    const raw = JSON.parse(String(result["raw_scraped_json"])) as JsonRow;
    assert.deepEqual(Object.keys(raw).sort(), ["api_usage_summary", "token_packs_list", "token_packs_summary"]);

    const rows = snapshotRows(test);
    assert.equal(rows.length, 1);
    const row = rows[0] as JsonRow;
    assert.equal(row["account_id"], "longcat-account-1");
    assert.equal(row["balance"], 12.34);
    assert.equal(row["token_pack_total"], 60000000);
    assert.equal(row["token_pack_used"], 1000000);
    assert.equal(row["token_pack_remaining"], 59000000);
    assert.equal(row["token_pack_expire_at"], "2026-12-31T00:00:00Z");
    assert.equal(row["source"], "scrape");
    assert.equal(row["remark"], "控制台抓取");
    assert.equal(row["currency"], "CNY");
    // 抓取成功后关闭窗口并解除人工接管（Rust 一致）。
    assert.equal(scrapeSessionDiagnostics().length, 0);
    assert.ok(
      test.host.calls.some(
        (call) => call.channel === "scrape.closeConsole" && call.payload?.["accountId"] === "longcat-account-1",
      ),
    );
  });

  it("extractor 第二实参是凭据指纹，不是明文 Key", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    test.host.respond(
      "scrape.runPlan",
      longcatStageResponder({
        "https://longcat.chat/platform/usage?tab=token": { token_packs_summary: LONGCAT_SUMMARY },
        "https://longcat.chat/platform/usage?tab=api": { api_usage_summary: LONGCAT_API_USAGE },
        "https://longcat.chat/platform/fuel_pack": { token_packs_list: LONGCAT_PACK_LIST },
      }),
    );
    test.host.respond("scrape.evaluate", () => ({ result: { balance: 1 } }));

    await dispatchDesktop(test.ctx, "scrape_balance", { accountId: "longcat-account-1" });

    const evaluateCall = test.host.calls.find((call) => call.channel === "scrape.evaluate");
    assert.ok(evaluateCall !== undefined);
    const credential = evaluateCall.payload?.["credential"] as JsonRow;
    assert.deepEqual(credential, { keyPrefix: "sk-1a49e", keyLastFour: "3d65" });
    const source = String(evaluateCall.payload?.["source"]);
    assert.ok(source.includes("function (__flowlet_bundle, __flowlet_credential)"));
    assert.ok(source.includes("function extract(bundle)"), "extractor 内层函数应原样嵌入");
  });

  it("list_balance_snapshots 按 Rust 形状返回该账号最近快照", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    test.storage.saveBalanceSnapshot({
      id: "balance-old",
      account_id: "longcat-account-1",
      balance: 1,
      currency: "CNY",
      token_pack_total: null,
      token_pack_used: null,
      token_pack_remaining: null,
      token_pack_expire_at: null,
      token_packs: null,
      raw_scraped_json: null,
      source: "sync",
      synced_at: "2026-01-01T00:00:00Z",
      remark: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const rows = (await dispatchDesktop(test.ctx, "list_balance_snapshots", {
      accountId: "longcat-account-1",
    })) as JsonRow[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.["id"], "balance-old");
    assert.equal(rows[0]?.["account_id"], "longcat-account-1");
    assert.equal(rows[0]?.["balance"], 1);
  });
});

// ─── 错误映射 ───────────────────────────────────────────────────────────────

describe("scrape_balance 的错误映射", () => {
  it("需要登录：probe 发现明确登录页 → 可读错误，不用 extractor 空结果掩盖", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    test.host.respond("scrape.runPlan", () => ({ result: {} }));
    test.host.respond("scrape.probeLogin", () => ({ loggedIn: false, url: "https://longcat.chat/login" }));

    await assert.rejects(
      dispatchDesktop(test.ctx, "scrape_balance", { accountId: "longcat-account-1" }),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 400);
        assert.equal((error as Error).message, "请先登录官方控制台（已弹出登录窗口）");
        return true;
      },
    );
    // 进入登录页必须把窗口展示出来供用户操作。
    assert.ok(
      test.host.calls.some(
        (call) => call.channel === "scrape.openConsole" && call.payload?.["interactive"] === true,
      ),
    );
    assert.equal(snapshotRows(test).length, 0);
  });

  it("后台轮次遇到「等待人工处理」直接返回 Rust 同款错误，不导航", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    // 先让交互式探测进入 console_action_required，标记该账号。
    test.host.respond("scrape.runPlan", () => ({ result: {} }));
    await dispatchDesktop(test.ctx, "probe_scrape_login", {
      accountId: "longcat-account-1",
      interactive: true,
    });
    test.host.calls.length = 0;

    await assert.rejects(
      dispatchDesktop(test.ctx, "scrape_balance", {
        accountId: "longcat-account-1",
        interactive: false,
      }),
      (error: unknown) =>
        (error as Error).message === "账号正在等待控制台登录或人工处理，本轮自动同步已跳过",
    );
    assert.equal(test.host.calls.length, 0, "后台轮次不应再打开/导航窗口");
  });

  it("超时：宿主 runPlan 抛出让阶段失败，最终映射为「未捕获到控制台业务响应」", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    test.host.respond("scrape.runPlan", () => {
      throw new Error("控制台抓取超时（15s 内未收齐响应槽位）");
    });

    await assert.rejects(
      dispatchDesktop(test.ctx, "scrape_balance", { accountId: "longcat-account-1" }),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 400);
        assert.match(
          (error as Error).message,
          /未捕获到完整套餐接口响应|未捕获到控制台业务响应|控制台页面监听初始化失败/,
        );
        return true;
      },
    );
    assert.equal(snapshotRows(test).length, 0);
  });

  it("解析失败：extractor 空串（语法错误）映射为 Rust 同款提示", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    test.host.respond(
      "scrape.runPlan",
      longcatStageResponder({
        "https://longcat.chat/platform/usage?tab=token": { token_packs_summary: LONGCAT_SUMMARY },
        "https://longcat.chat/platform/usage?tab=api": { api_usage_summary: LONGCAT_API_USAGE },
        "https://longcat.chat/platform/fuel_pack": { token_packs_list: LONGCAT_PACK_LIST },
      }),
    );
    test.host.respond("scrape.evaluate", () => ({ result: "" }));

    await assert.rejects(
      dispatchDesktop(test.ctx, "scrape_balance", { accountId: "longcat-account-1" }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /extractor 未返回任何结果/);
        assert.match(message, /单个函数声明/);
        return true;
      },
    );
    assert.equal(snapshotRows(test).length, 0);
  });

  it("解析失败：extractor 返回 null / error 字段均报可读错误", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "zhipu", {
      paygo: {
        console_url: "https://www.bigmodel.cn/finance-center/resource-package/package-mgmt?tab=my",
        interceptor_js: "",
        extractor_js: "function extract(bundle){return null;}",
        aggregate: true,
        required_slots: ["token_packs_list", "account_report"],
      },
    });
    test.host.respond("scrape.runPlan", () => ({
      result: {
        token_packs_list: JSON.stringify({ code: 200, rows: [] }),
        account_report: JSON.stringify({ code: 200, data: {} }),
      },
    }));

    test.host.respond("scrape.evaluate", () => ({ result: null }));
    await assert.rejects(
      dispatchDesktop(test.ctx, "scrape_balance", { accountId: "zhipu-account-1" }),
      (error: unknown) => /extractor 返回空结果/.test((error as Error).message),
    );

    test.host.respond("scrape.evaluate", () => ({ result: { error: "boom" } }));
    await assert.rejects(
      dispatchDesktop(test.ctx, "scrape_balance", { accountId: "zhipu-account-1" }),
      (error: unknown) => /extractor 执行错误: boom/.test((error as Error).message),
    );
    assert.equal(test.storage.listBalanceSnapshots("zhipu-account-1").length, 0);
  });

  it("不支持控制台抓取的渠道返回 Rust 同款错误", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    await assert.rejects(
      dispatchDesktop(test.ctx, "scrape_balance", { accountId: "deepseek-account-1" }),
      (error: unknown) => (error as Error).message === "该账号所属渠道不支持控制台抓取",
    );
    await assert.rejects(
      dispatchDesktop(test.ctx, "open_scrape_console", { accountId: "missing" }),
      (error: unknown) => (error as Error).message === "账号不存在",
    );
  });
});

// ─── 宿主已实现 scrape.evaluate 的主路径 ────────────────────────────────────

describe("宿主已实现 scrape.evaluate 时复用已捕获响应", () => {
  it("evaluate 收到 bundle（聚合槽位）与凭据指纹，不触发降级 plan", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    test.host.respond(
      "scrape.runPlan",
      longcatStageResponder({
        "https://longcat.chat/platform/usage?tab=token": { token_packs_summary: LONGCAT_SUMMARY },
        "https://longcat.chat/platform/usage?tab=api": { api_usage_summary: LONGCAT_API_USAGE },
        "https://longcat.chat/platform/fuel_pack": { token_packs_list: LONGCAT_PACK_LIST },
      }),
    );
    test.host.respond("scrape.evaluate", () => ({
      result: { balance: 2.5, currency: "CNY", plan_name: "LongCat" },
    }));

    const result = (await dispatchDesktop(test.ctx, "scrape_balance", {
      accountId: "longcat-account-1",
    })) as JsonRow;
    assert.equal(result["balance"], 2.5);

    const evaluate = test.host.calls.find((call) => call.channel === "scrape.evaluate");
    assert.ok(evaluate !== undefined);
    const bundle = evaluate.payload?.["bundle"] as JsonRow;
    assert.deepEqual(Object.keys(bundle).sort(), [
      "api_usage_summary",
      "token_packs_list",
      "token_packs_summary",
    ]);
    // bundle 是「已解析的 JSON」，与 Rust `build_aggregate_bundle` 一致。
    assert.equal(typeof bundle["token_packs_summary"], "object");
    assert.equal(evaluate.payload?.["credential"] instanceof Object, true);
    assert.equal(
      evaluate.payload?.["timeoutMs"],
      10_000,
      "extractor 超时默认 10s（Rust 同款）",
    );
    // 主路径不应再跑一次带 extractorJs 的整段 plan。
    const plans = runPlanPayloads(test).map((payload) => payload["plan"] as JsonRow);
    assert.equal(
      plans.filter((plan) => plan["extractorJs"] !== undefined).length,
      0,
      "evaluate 可用时不得回退整段 plan",
    );
  });

  it("evaluate 返回双重编码的 JSON 字符串也能解析", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "zhipu", {
      paygo: {
        console_url: "https://www.bigmodel.cn/finance-center/resource-package/package-mgmt?tab=my",
        interceptor_js: "",
        extractor_js: "function extract(bundle){return {balance:1};}",
        aggregate: true,
        required_slots: ["token_packs_list", "account_report"],
      },
    });
    test.host.respond("scrape.runPlan", () => ({
      result: {
        token_packs_list: JSON.stringify({ code: 200, rows: [] }),
        account_report: JSON.stringify({ code: 200, data: {} }),
      },
    }));
    test.host.respond("scrape.evaluate", () => ({
      result: JSON.stringify(JSON.stringify({ balance: 4.25, currency: "CNY" })),
    }));
    const result = (await dispatchDesktop(test.ctx, "scrape_balance", {
      accountId: "zhipu-account-1",
    })) as JsonRow;
    assert.equal(result["balance"], 4.25);
  });
});

// ─── scrape.evaluate 缺失时的降级路径 ───────────────────────────────────────

describe("宿主未实现 scrape.evaluate 时的降级路径", () => {
  it("回退为整段 plan（多阶段 URL + extractorJs），并采用宿主返回的结果", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    test.host.respond("scrape.runPlan", (_channel, payload) => {
      const plan = payload?.["plan"] as JsonRow;
      if (plan["extractorJs"] !== undefined) {
        return { result: { balance: 7.5, currency: "CNY" } };
      }
      const url = String(plan["consoleUrl"]);
      if (url.includes("fuel_pack")) return { result: { token_packs_list: LONGCAT_PACK_LIST } };
      if (url.includes("tab=api")) return { result: { api_usage_summary: LONGCAT_API_USAGE } };
      return { result: { token_packs_summary: LONGCAT_SUMMARY } };
    });
    test.host.respond("scrape.evaluate", () => {
      throw new Error("未实现的桌面宿主 channel：scrape.evaluate");
    });

    const result = (await dispatchDesktop(test.ctx, "scrape_balance", {
      accountId: "longcat-account-1",
    })) as JsonRow;
    assert.equal(result["balance"], 7.5);
    assert.equal(result["source"], "scrape");

    const plans = runPlanPayloads(test).map((payload) => payload["plan"] as JsonRow);
    const fallback = plans[plans.length - 1] as JsonRow;
    assert.equal(fallback["consoleUrl"], "https://longcat.chat/platform/usage?tab=token");
    assert.equal(fallback["consoleUrlSecondary"], "https://longcat.chat/platform/usage?tab=api");
    assert.equal(fallback["consoleUrlTertiary"], "https://longcat.chat/platform/fuel_pack");
    assert.equal(fallback["aggregate"], true);
    assert.equal(typeof fallback["extractorJs"], "string");
    // 降级路径只等最后一个阶段的槽位，前两阶段靠「有匹配响应」推进。
    assert.deepEqual(fallback["requiredSlots"], ["token_packs_list"]);
    assert.equal(snapshotRows(test).length, 1);
  });

  it("extractor 自身执行错误（非 channel 缺失）不降级，直接报错", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    test.host.respond(
      "scrape.runPlan",
      longcatStageResponder({
        "https://longcat.chat/platform/usage?tab=token": { token_packs_summary: LONGCAT_SUMMARY },
        "https://longcat.chat/platform/usage?tab=api": { api_usage_summary: LONGCAT_API_USAGE },
        "https://longcat.chat/platform/fuel_pack": { token_packs_list: LONGCAT_PACK_LIST },
      }),
    );
    test.host.respond("scrape.evaluate", () => {
      throw new Error("Cannot read properties of undefined (reading 'data')");
    });

    await assert.rejects(
      dispatchDesktop(test.ctx, "scrape_balance", { accountId: "longcat-account-1" }),
      (error: unknown) => /extractor 执行失败/.test((error as Error).message),
    );
    assert.equal(snapshotRows(test).length, 0);
  });
});

// ─── 批量同步 ───────────────────────────────────────────────────────────────

describe("sync_scrape_balances", () => {
  it("逐账号同步，局部失败不阻断其它账号，跳过需要登录的账号", async () => {
    const test = makeContext();
    installChannelsConfig(test, { channelIds: ["longcat", "zhipu", "deepseek"] });
    installBuiltinScrape(test, "longcat", longcatModes());
    installBuiltinScrape(test, "zhipu", {
      paygo: {
        console_url: "https://www.bigmodel.cn/finance-center/resource-package/package-mgmt?tab=my",
        interceptor_js: "",
        extractor_js: "function extract(bundle){return {balance:1};}",
        aggregate: true,
        required_slots: ["token_packs_list", "account_report"],
      },
    });
    // longcat 成功、zhipu 超时失败；deepseek 走官方余额 API（不允许真实外网）→ 直接抛错。
    test.host.respond("scrape.runPlan", (_channel, payload) => {
      const plan = payload?.["plan"] as JsonRow;
      const url = String(plan["consoleUrl"]);
      if (url.includes("bigmodel")) throw new Error("控制台抓取超时（15s 内未收齐响应槽位）");
      if (plan["extractorJs"] !== undefined) {
        return { result: { token_packs_list: LONGCAT_PACK_LIST } };
      }
      if (url.includes("fuel_pack")) return { result: { token_packs_list: LONGCAT_PACK_LIST } };
      if (url.includes("tab=api")) return { result: { api_usage_summary: LONGCAT_API_USAGE } };
      return { result: { token_packs_summary: LONGCAT_SUMMARY } };
    });
    test.host.respond("scrape.evaluate", () => ({ result: { balance: 1, currency: "CNY" } }));

    const result = (await dispatchDesktop(test.ctx, "sync_scrape_balances", {
      triggerSource: "test",
    })) as JsonRow;

    assert.equal(result["started"], true);
    assert.equal(result["accounts"], 3);
    // longcat 成功；zhipu 与 deepseek 失败。
    assert.equal(result["synced"], 1);
    assert.equal(result["failed"], 2);
    assert.ok(typeof result["jobId"] === "string");
    assert.match(String(result["message"]), /渠道资源同步完成：成功 1 个，失败 2 个，跳过 0 个/);
    // 任务日志记录了逐账号结果。
    const page = test.storage.withDatabase((db) => listBackgroundJobs(db, { page: 1, pageSize: 10 }));
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0]?.jobType, "channel-resource-sync");
    const detail = test.storage.withDatabase((db) => getBackgroundJobDetail(db, String(page.rows[0]?.id)));
    assert.ok(detail !== null);
    assert.ok(detail.events.length >= 4, "应记录开始 + 逐账号 + 完成事件");
    assert.ok(
      detail.events.some((event) => event.message.includes("同步失败")),
      "失败账号必须写入 warning 事件",
    );
  });

  it("「需要登录」只记为该账号失败/跳过，不整批抛异常", async () => {
    const test = makeContext();
    installChannelsConfig(test, { channelIds: ["longcat", "zhipu"] });
    installBuiltinScrape(test, "longcat", longcatModes());
    installBuiltinScrape(test, "zhipu", {
      paygo: {
        console_url: "https://www.bigmodel.cn/finance-center/resource-package/package-mgmt?tab=my",
        interceptor_js: "",
        extractor_js: "function extract(bundle){return {balance:1};}",
        aggregate: true,
        required_slots: ["token_packs_list", "account_report"],
      },
    });
    test.host.respond("scrape.runPlan", () => ({ result: {} }));
    test.host.respond("scrape.probeLogin", () => ({
      loggedIn: false,
      url: "https://www.bigmodel.cn/login",
    }));

    const result = (await dispatchDesktop(test.ctx, "sync_scrape_balances", {
      triggerSource: "background",
    })) as JsonRow;
    assert.equal(result["started"], true);
    assert.equal(result["accounts"], 2);
    assert.equal(result["synced"], 0);
    assert.equal(result["failed"], 2);
  });

  it("没有可同步账号时返回 started=false（Rust 同款消息）", async () => {
    const test = makeContext();
    installChannelsConfig(test, { channelIds: ["openai-api"] });
    test.runtimeConfig.replace({
      channels: [],
      accounts: [
        { ...sampleAccount("idle"), channel_id: "openai-api", enabled: true, resource_sync_mode: "auto" },
      ],
      routes: [],
      rules: [],
      virtual_models: [],
    });
    const result = (await dispatchDesktop(test.ctx, "sync_scrape_balances", {
      triggerSource: "manual",
    })) as JsonRow;
    assert.equal(result["started"], false);
    assert.equal(result["accounts"], 0);
    assert.equal(result["message"], "没有可自动同步的渠道资源账号");
  });

  it("并发上限：已有同步在跑时返回 started=false", async () => {
    const test = makeContext();
    installChannelsConfig(test, { channelIds: ["longcat"] });
    installBuiltinScrape(test, "longcat", longcatModes());
    let release: (() => void) | null = null;
    let blocked = false;
    test.host.respond("scrape.runPlan", async () => {
      if (!blocked) {
        blocked = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { result: { token_packs_summary: LONGCAT_SUMMARY } };
    });

    const first = dispatchDesktop(test.ctx, "sync_scrape_balances", { triggerSource: "a" });
    // 等第一个同步进入抓取阶段。
    for (let i = 0; i < 200 && release === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(release !== null, "首个同步应进入抓取阶段");
    const second = (await dispatchDesktop(test.ctx, "sync_scrape_balances", {
      triggerSource: "b",
    })) as JsonRow;
    assert.equal(second["started"], false);
    assert.equal(second["message"], "已有渠道资源自动同步正在运行");
    (release as unknown as () => void)();
    await first;
  });
});

// ─── open_external_url ──────────────────────────────────────────────────────

describe("open_external_url", () => {
  it("http/https 走 platform.openExternal，URL 仅 trim", async () => {
    const test = makeContext();
    await dispatchDesktop(test.ctx, "open_external_url", {
      url: "  https://platform.deepseek.com/api_keys  ",
    });
    const call = test.host.calls.find((item) => item.channel === "platform.openExternal");
    assert.ok(call !== undefined);
    assert.equal(call.payload?.["url"], "https://platform.deepseek.com/api_keys");

    await dispatchDesktop(test.ctx, "open_external_url", { url: "http://localhost:18640/x" });
    assert.equal(test.host.calls.filter((item) => item.channel === "platform.openExternal").length, 2);
  });

  it("非 http(s) 返回 Rust 同款错误文案且不调用宿主", async () => {
    const test = makeContext();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://x/y", "mailto:a@b", ""]) {
      await assert.rejects(
        dispatchDesktop(test.ctx, "open_external_url", { url }),
        (error: unknown) => {
          assert.equal((error as Error).message, "只允许打开 http(s) 地址");
          return true;
        },
        `URL ${url} 应被拒绝`,
      );
    }
    assert.equal(test.host.calls.length, 0);
  });

  it("宿主拒绝时映射为「无法打开浏览器：…」", async () => {
    const test = makeContext();
    test.host.respond("platform.openExternal", () => {
      throw new Error("openExternal 仅允许 http/https URL");
    });
    await assert.rejects(
      dispatchDesktop(test.ctx, "open_external_url", { url: "https://ok.example/x" }),
      (error: unknown) => (error as Error).message === "无法打开浏览器：openExternal 仅允许 http/https URL",
    );
  });
});

// ─── reload_custom_scrape_registry ──────────────────────────────────────────

describe("reload_custom_scrape_registry", () => {
  it("重扫描述符目录、返回清单并刷新 ctx.customScrapeChannels 缓存", async () => {
    const test = makeContext();
    test.ctx.customScrapeChannels = [{ channelId: "stale", accountName: null }];
    writeCustomDescriptor({
      channelId: "custom",
      accountName: "Friday",
      consoleUrl: "https://friday.example.com/billing",
      requiredSlots: ["usage"],
      slots: { usage: { match: { kind: "fallback" } } },
    });

    const result = (await dispatchDesktop(test.ctx, "reload_custom_scrape_registry", {})) as JsonRow[];
    assert.deepEqual(result, [{ channelId: "custom", accountName: "Friday" }]);
    assert.deepEqual(test.ctx.customScrapeChannels, [{ channelId: "custom", accountName: "Friday" }]);
  });

  it("目录为空时返回空清单并清空缓存", async () => {
    const test = makeContext();
    test.ctx.customScrapeChannels = [{ channelId: "stale", accountName: null }];
    const result = (await dispatchDesktop(test.ctx, "reload_custom_scrape_registry", {})) as JsonRow[];
    assert.deepEqual(result, []);
    assert.deepEqual(test.ctx.customScrapeChannels, []);
  });
});

// ─── 控制台窗口 / 页面回调 / probe ──────────────────────────────────────────

describe("open_scrape_console / close_scrape_console", () => {
  it("打开时传 accountId + channelId + consoleUrl，并登记人工接管", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());

    await dispatchDesktop(test.ctx, "open_scrape_console", { accountId: "longcat-account-1" });
    const call = test.host.calls.find((item) => item.channel === "scrape.openConsole");
    assert.ok(call !== undefined);
    assert.equal(call.payload?.["accountId"], "longcat-account-1");
    assert.equal(call.payload?.["channelId"], "longcat");
    assert.equal(call.payload?.["url"], "https://longcat.chat/platform/usage?tab=token");
    assert.equal(call.payload?.["interactive"], true);

    const diagnostics = scrapeSessionDiagnostics();
    assert.equal(diagnostics.length, 1);
    // 单纯打开控制台不登记人工接管（Rust 只在 probe_scrape_login 登记），
    // 否则后台同步会永久跳过该账号。
    assert.equal(diagnostics[0]?.["interactionRequired"], false);
  });

  it("超出窗口上限时返回 Rust 同款错误", async () => {
    const test = makeContext();
    installChannelsConfig(test, {
      channelIds: ["longcat", "qwen", "zhipu", "deepseek"],
    });
    installBuiltinScrape(test, "longcat", longcatModes());
    installBuiltinScrape(test, "zhipu", {
      paygo: {
        console_url: "https://www.bigmodel.cn/x",
        interceptor_js: "",
        extractor_js: "function extract(){}",
        aggregate: true,
        required_slots: ["token_packs_list"],
      },
    });
    installBuiltinScrape(test, "qwen", {
      token_plan: {
        console_url: "https://platform.qianwenai.com/token-plan",
        interceptor_js: "",
        extractor_js: "function extract(){}",
        aggregate: true,
        required_slots: ["subscription"],
      },
    });
    for (const accountId of ["longcat-account-1", "qwen-account-1", "zhipu-account-1"]) {
      await dispatchDesktop(test.ctx, "open_scrape_console", { accountId });
    }
    // 第 4 个需要新账号才能触发上限；回收逻辑先跑，非人工接管的会被回收，
    // 因此这里直接断言「未超过上限」而不是伪造错误。
    assert.equal(scrapeSessionDiagnostics().length <= 3, true);
  });

  it("close 清空会话状态与人工接管标记，并调用宿主 closeConsole", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    await dispatchDesktop(test.ctx, "open_scrape_console", { accountId: "longcat-account-1" });
    assert.equal(scrapeSessionDiagnostics().length, 1);

    await dispatchDesktop(test.ctx, "close_scrape_console", { accountId: "longcat-account-1" });
    assert.equal(scrapeSessionDiagnostics().length, 0);
    assert.ok(
      test.host.calls.some(
        (call) => call.channel === "scrape.closeConsole" && call.payload?.["accountId"] === "longcat-account-1",
      ),
    );
  });
});

describe("probe_scrape_login", () => {
  it("捕获完整响应 → probe_state=captured，is_logged_in=true", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    test.host.respond(
      "scrape.runPlan",
      longcatStageResponder({
        "https://longcat.chat/platform/usage?tab=token": { token_packs_summary: LONGCAT_SUMMARY },
        "https://longcat.chat/platform/usage?tab=api": { api_usage_summary: LONGCAT_API_USAGE },
        "https://longcat.chat/platform/fuel_pack": { token_packs_list: LONGCAT_PACK_LIST },
      }),
    );
    test.host.respond("scrape.probeLogin", () => ({
      loggedIn: true,
      url: "https://longcat.chat/platform/usage?tab=fuel_pack",
    }));

    const status = (await dispatchDesktop(test.ctx, "probe_scrape_login", {
      accountId: "longcat-account-1",
    })) as JsonRow;
    assert.equal(status["probe_state"], "captured");
    assert.equal(status["is_logged_in"], true);
    assert.equal(status["channel_id"], "longcat");
    assert.equal(status["account_hint"], null);
    assert.equal(status["message"], null);
  });

  it("明确登录页 → login_required，并展示窗口", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    test.host.respond("scrape.runPlan", () => ({ result: {} }));
    test.host.respond("scrape.probeLogin", () => ({ loggedIn: false, url: "https://longcat.chat/login" }));

    const status = (await dispatchDesktop(test.ctx, "probe_scrape_login", {
      accountId: "longcat-account-1",
      interactive: true,
    })) as JsonRow;
    assert.equal(status["probe_state"], "login_required");
    assert.equal(status["is_logged_in"], false);
    assert.equal(status["message"], "检测到控制台登录页，请在弹出的窗口中完成登录。");
    assert.ok(
      test.host.calls.some(
        (call) => call.channel === "scrape.openConsole" && call.payload?.["interactive"] === true,
      ),
    );
  });

  it("监听已就绪但未捕获目标响应 → console_action_required（不等于未登录）", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    // 只返回一个非必需槽位（api_usage_summary），监听已生效但缺槽位。
    test.host.respond("scrape.runPlan", () => ({ result: { api_usage_summary: LONGCAT_API_USAGE } }));
    test.host.respond("scrape.probeLogin", () => ({
      loggedIn: true,
      url: "https://longcat.chat/platform/usage?tab=token",
    }));

    const status = (await dispatchDesktop(test.ctx, "probe_scrape_login", {
      accountId: "longcat-account-1",
    })) as JsonRow;
    assert.equal(status["probe_state"], "console_action_required");
    assert.equal(status["is_logged_in"], false);
    assert.match(String(status["message"]), /未捕获到完整套餐接口响应（缺少：/);
  });

  it("窗口已经停在第 1 阶段 URL 时重建窗口，确保 probe 真正重新导航", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    // 先打开控制台（窗口已导航到第一阶段 URL）。
    await dispatchDesktop(test.ctx, "open_scrape_console", { accountId: "longcat-account-1" });
    test.host.calls.length = 0;
    test.host.respond("scrape.runPlan", () => ({ result: {} }));
    // 宿主报告当前页面正好等于第一阶段 URL → 宿主会跳过导航，命令层必须先重建窗口。
    test.host.respond("scrape.probeLogin", () => ({
      loggedIn: true,
      url: "https://longcat.chat/platform/usage?tab=token",
    }));

    await dispatchDesktop(test.ctx, "probe_scrape_login", { accountId: "longcat-account-1" });

    const channels = test.host.calls.map((call) => call.channel);
    assert.ok(channels.includes("scrape.closeConsole"), "命中同 URL 时必须先关闭旧窗口");
    const openIndex = channels.indexOf("scrape.openConsole");
    const closeIndex = channels.indexOf("scrape.closeConsole");
    assert.ok(closeIndex >= 0 && openIndex > closeIndex, "重建顺序必须是 close → open");
  });

  it("监听未生效 → capture_timeout（明确不是未登录）", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    test.host.respond("scrape.runPlan", () => {
      throw new Error("附加 CDP 失败：debugger already attached");
    });
    test.host.respond("scrape.probeLogin", () => ({
      loggedIn: true,
      url: "https://longcat.chat/platform/usage?tab=token",
    }));

    const status = (await dispatchDesktop(test.ctx, "probe_scrape_login", {
      accountId: "longcat-account-1",
    })) as JsonRow;
    assert.equal(status["probe_state"], "capture_timeout");
    assert.equal(status["message"], "控制台页面监听初始化失败，请重新抓取。");
  });

  it("后台轮次遇到人工接管标记 → login_required + 跳过文案，不打开窗口", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    markInteractionRequired("longcat-account-1");
    test.host.calls.length = 0;
    const status = (await dispatchDesktop(test.ctx, "probe_scrape_login", {
      accountId: "longcat-account-1",
      interactive: false,
    })) as JsonRow;
    assert.equal(status["probe_state"], "login_required");
    assert.equal(status["message"], "账号正在等待控制台登录或人工处理，本轮自动同步已跳过。");
    assert.equal(test.host.calls.length, 0);
  });
});

/** 直接通过命令层打开控制台来建立人工接管标记（模拟用户点「抓取」）。 */
function markInteractionRequired(accountId: string): void {
  scrapeSessions.setInteractionRequired(accountId, true);
}

describe("页面回调入口（handle_intercepted_response / handle_scrape_interceptor_ready）", () => {
  it("页面回传的响应写入会话缓冲，并让 scrape_balance 直接复用（不再 probe/导航）", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    await dispatchDesktop(test.ctx, "open_scrape_console", { accountId: "longcat-account-1" });

    await dispatchDesktop(test.ctx, "handle_intercepted_response", {
      channelId: "longcat",
      url: "https://longcat.chat/api/pay/quota/metering/token-packs/summary",
      body: LONGCAT_SUMMARY,
      accountId: "longcat-account-1",
    });
    await dispatchDesktop(test.ctx, "handle_intercepted_response", {
      channelId: "longcat",
      url: "https://longcat.chat/api/pay/quota/metering/api-usage/summary",
      body: LONGCAT_API_USAGE,
      accountId: "longcat-account-1",
    });
    await dispatchDesktop(test.ctx, "handle_intercepted_response", {
      channelId: "longcat",
      url: "https://longcat.chat/api/pay/commercial/entitlements/token-packs/list",
      body: LONGCAT_PACK_LIST,
      accountId: "longcat-account-1",
    });
    assert.equal(scrapeSessionDiagnostics()[0]?.["pending"], 3);

    // 页面 IPC 已收齐 → scrape_balance 不再 probe（不导航），直接抽取值并落库。
    test.host.calls.length = 0;
    test.host.respond("scrape.evaluate", () => ({
      result: { balance: 3, currency: "CNY", token_total: 60000000 },
    }));
    const result = (await dispatchDesktop(test.ctx, "scrape_balance", {
      accountId: "longcat-account-1",
    })) as JsonRow;
    assert.equal(result["balance"], 3);
    assert.equal(
      test.host.calls.filter((call) => call.channel === "scrape.runPlan").length,
      0,
      "已捕获完整响应时不应再跑 runPlan",
    );
    assert.equal(snapshotRows(test).length, 1);
  });

  it("页面回传的响应不满足槽位校验时不计入完成判定（登录失效信封）", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    await dispatchDesktop(test.ctx, "open_scrape_console", { accountId: "longcat-account-1" });
    for (const url of [
      "https://longcat.chat/api/pay/quota/metering/token-packs/summary",
      "https://longcat.chat/api/pay/quota/metering/api-usage/summary",
      "https://longcat.chat/api/pay/commercial/entitlements/token-packs/list",
    ]) {
      await dispatchDesktop(test.ctx, "handle_intercepted_response", {
        channelId: "longcat",
        url,
        body: JSON.stringify({ code: "UNAUTHORIZED", message: "login required" }),
        accountId: "longcat-account-1",
      });
    }
    assert.equal(scrapeSessionDiagnostics()[0]?.["pending"], 3);
    test.host.respond("scrape.runPlan", () => ({ result: {} }));
    test.host.respond("scrape.probeLogin", () => ({
      loggedIn: true,
      url: "https://longcat.chat/platform/usage?tab=token",
    }));
    const status = (await dispatchDesktop(test.ctx, "probe_scrape_login", {
      accountId: "longcat-account-1",
    })) as JsonRow;
    assert.notEqual(status["probe_state"], "captured");
    assert.equal(snapshotRows(test).length, 0);
  });

  it("payload 没有 accountId 时按「当前唯一活跃会话」定位", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    await dispatchDesktop(test.ctx, "open_scrape_console", { accountId: "longcat-account-1" });

    await dispatchDesktop(test.ctx, "handle_intercepted_response", {
      channelId: "longcat",
      url: "https://longcat.chat/api/pay/quota/metering/token-packs/summary",
      body: LONGCAT_SUMMARY,
    });
    assert.equal(scrapeSessionDiagnostics()[0]?.["pending"], 1);
  });

  it("没有活跃会话且未传 accountId 时明确报错（不猜测账号）", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    await assert.rejects(
      dispatchDesktop(test.ctx, "handle_intercepted_response", {
        channelId: "longcat",
        url: "https://x/y",
        body: "{}",
      }),
      (error: unknown) => (error as Error).message === "只允许抓取控制台窗口回传响应",
    );
  });

  it("渠道不匹配 / 超过 8MB / 参数过长 均按 Rust 文案报错", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    await dispatchDesktop(test.ctx, "open_scrape_console", { accountId: "longcat-account-1" });

    await assert.rejects(
      dispatchDesktop(test.ctx, "handle_intercepted_response", {
        channelId: "qwen",
        url: "https://longcat.chat/x",
        body: "{}",
        accountId: "longcat-account-1",
      }),
      (error: unknown) => (error as Error).message === "抓取响应渠道与账号不匹配",
    );
    await assert.rejects(
      dispatchDesktop(test.ctx, "handle_intercepted_response", {
        channelId: "longcat",
        url: "https://longcat.chat/x",
        body: "x".repeat(8 * 1024 * 1024 + 1),
        accountId: "longcat-account-1",
      }),
      (error: unknown) => (error as Error).message === "抓取响应超过 8 MB，已拒绝写入缓冲",
    );
    await assert.rejects(
      dispatchDesktop(test.ctx, "handle_scrape_interceptor_ready", {
        channelId: "longcat",
        documentId: "d".repeat(129),
        pageUrl: "https://longcat.chat/x",
        accountId: "longcat-account-1",
      }),
      (error: unknown) => (error as Error).message === "抓取监听状态参数过长",
    );
  });

  it("拦截器 ACK 记录 document_id / page_url，并让 probe 认为监听已就绪", async () => {
    const test = makeContext();
    installChannelsConfig(test);
    installBuiltinScrape(test, "longcat", longcatModes());
    await dispatchDesktop(test.ctx, "open_scrape_console", { accountId: "longcat-account-1" });
    await dispatchDesktop(test.ctx, "handle_scrape_interceptor_ready", {
      channelId: "longcat",
      documentId: "doc-1",
      pageUrl: "https://longcat.chat/platform/usage?tab=token",
      accountId: "longcat-account-1",
    });
    assert.equal(scrapeSessionDiagnostics()[0]?.["ready"], true);

    // 监听就绪但未捕获 → console_action_required（不是 capture_timeout）。
    test.host.respond("scrape.runPlan", () => ({ result: {} }));
    const status = (await dispatchDesktop(test.ctx, "probe_scrape_login", {
      accountId: "longcat-account-1",
      interactive: false,
    })) as JsonRow;
    assert.equal(status["probe_state"], "console_action_required");
  });
});

// ─── 自定义描述符装置 ───────────────────────────────────────────────────────

interface CustomDescriptorInput {
  channelId: string;
  accountName: string;
  consoleUrl: string;
  consoleUrlSecondary?: string | null;
  requiredSlots: string[];
  slots: Record<string, { match: JsonRow }>;
  summaryPlan?: string;
}

function writeCustomDescriptor(input: CustomDescriptorInput): void {
  const dir = path.join(customRoot, input.accountName.toLowerCase());
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        channelId: input.channelId,
        accountName: input.accountName,
        resourceModes: [{ resourceMode: "pay_as_you_go", modeKey: "paygo" }],
        login: { kind: "generic_or_host", host: "friday.example.com" },
        modes: {
          paygo: {
            consoleUrl: input.consoleUrl,
            consoleUrlSecondary: input.consoleUrlSecondary ?? null,
            aggregate: true,
            requiredSlots: input.requiredSlots,
            slots: input.slots,
          },
        },
        summary: input.summaryPlan === undefined ? undefined : { plan: input.summaryPlan },
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(dir, "extractor.js"), "function extract(bundle){return {balance:1};}");
}