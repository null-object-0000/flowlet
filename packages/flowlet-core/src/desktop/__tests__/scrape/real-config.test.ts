// 用仓库根目录真实 config.json 校验内置渠道的抓取描述解析（不打外网）。
//
// 这组测试的意义：`scrape_balance` 的 ScrapePlan 必须由 config.json 的
// `channels[].scrape` 描述符驱动，而不是为每个渠道硬编码 URL/槽位。若 config.json
// 的 scrape 配置改坏（缺阶段、缺槽位），这里的断言会先失败。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { JsonRow } from "../../../types.ts";
import { DEFAULT_BUILTIN_CONFIG, loadChannelsConfig } from "../../../config/index.ts";
import {
  builtinScrapeModeConfig,
  resolveScrapeMode,
} from "../../../scrape/mode.ts";
import {
  aggregateComplete,
  classifySlot,
  collectSlots,
  requiredSlotsForPhase,
  scrapePhases,
  singleResponseTargetSlot,
  slotSatisfied,
  builtinSlotRules,
} from "../../../scrape/slot-engine.ts";
import { buildExtractorSource } from "../../../scrape/extractor.ts";
import { resolveCustomScrapeMode } from "../../../scrape/custom-registry.ts";
import { createTestContext, sampleAccount, type TestContext } from "../support.ts";

/** 仓库根 config.json（与 Rust `include_str!` 的内置默认是同一份文件）。 */
const REPO_CONFIG = DEFAULT_BUILTIN_CONFIG;

let context: TestContext | null = null;
let customRoot = "";

beforeEach(() => {
  customRoot = mkdtempSync(path.join(tmpdir(), "flowlet-scrape-real-"));
  process.env["FLOWLET_CUSTOM_SCRAPE_DIRS"] = customRoot;
  context = createTestContext({ prefix: "flowlet-desktop-scrape-real-" });
  const configJson = JSON.parse(readFileSync(REPO_CONFIG, "utf8")) as JsonRow;
  const channels = loadChannelsConfig(configJson);
  context.ctx.channelsConfig = {
    channels: channels.presets.map((preset) => {
      const raw = (configJson.channels_config as JsonRow).channels as JsonRow[];
      const source = raw.find((channel) => channel.id === preset.id);
      return source?.scrape === undefined ? preset : { ...preset, scrape: source.scrape };
    }),
  };
});

afterEach(() => {
  context?.cleanup();
  context = null;
  rmSync(customRoot, { recursive: true, force: true });
  delete process.env["FLOWLET_CUSTOM_SCRAPE_DIRS"];
});

function ctxOf(): TestContext {
  assert.ok(context !== null);
  return context;
}

describe("真实 config.json 的内置抓取描述", () => {
  it("LongCat hybrid 是三阶段抓取，槽位按阶段一一对应", () => {
    const test = ctxOf();
    const mode = resolveScrapeMode(test.ctx, "longcat", "hybrid", "longcat account");
    assert.ok(mode !== null);
    const phases = scrapePhases(mode);
    assert.equal(phases.length, 3);
    assert.equal(phases[0], "https://longcat.chat/platform/usage?tab=token");
    assert.equal(phases[1], "https://longcat.chat/platform/usage?tab=api");
    assert.equal(phases[2], "https://longcat.chat/platform/fuel_pack");
    assert.equal(mode.aggregate, true);
    assert.deepEqual(mode.requiredSlots, [
      "token_packs_summary",
      "api_usage_summary",
      "token_packs_list",
    ]);
    assert.equal(requiredSlotsForPhase(mode, 0, 3).length, 1);
    assert.equal(requiredSlotsForPhase(mode, 1, 3).length, 1);
    assert.deepEqual(requiredSlotsForPhase(mode, 2, 3), ["token_packs_list"]);

    // 宿主槽位规则必须覆盖三个必需槽位，且 URL 分派与 Rust adapter 一致。
    const rules = builtinSlotRules("longcat", mode.requiredSlots);
    assert.deepEqual(
      rules.map((rule) => rule.slot),
      ["token_packs_list", "token_packs_summary", "api_usage_summary"],
    );
    assert.equal(
      classifySlot(mode, "https://longcat.chat/api/pay/quota/metering/token-packs/summary"),
      "token_packs_summary",
    );
    assert.equal(
      classifySlot(mode, "https://longcat.chat/api/pay/quota/metering/api-usage/summary"),
      "api_usage_summary",
    );
    assert.equal(
      classifySlot(mode, "https://longcat.chat/api/pay/commercial/entitlements/token-packs/list"),
      "token_packs_list",
    );
    // 控制台 document / 埋点响应不得被误认成业务槽位。
    assert.equal(classifySlot(mode, "https://longcat.chat/platform/usage?tab=token"), "unknown");
    assert.equal(classifySlot(mode, "https://longcat.chat/api/irrelevant"), "unknown");

    // interceptor / extractor 来自 config.json 原文。
    assert.ok(mode.interceptorJs.includes("__flowlet_scrape_push"));
    assert.ok(mode.extractorJs.startsWith("function extract(bundle)"));
    // tab=api 的控制台映射到单响应模式的按量余额槽。
    assert.equal(singleResponseTargetSlot(mode), "token_packs_summary");
  });

  it("LongCat 的槽位校验区分业务成功与登录失效信封", () => {
    const test = ctxOf();
    const mode = resolveScrapeMode(test.ctx, "longcat", "hybrid", null);
    assert.ok(mode !== null);
    // summary / api_usage：合法 JSON 即到位。
    assert.equal(slotSatisfied(mode, "token_packs_summary", '{"code":0,"data":{}}'), true);
    // list：code!=0、items 非数组、或「historyCount=0 且 pageSize<=1」的活跃包探测响应
    // 都不算完整的资源包列表（Rust 用这个条件避免筛选请求抢先把阶段判完成）。
    assert.equal(
      slotSatisfied(
        mode,
        "token_packs_list",
        '{"code":0,"data":{"items":[{"resourceId":"1"}],"historyCount":1,"pageSize":10}}',
      ),
      true,
    );
    assert.equal(slotSatisfied(mode, "token_packs_list", '{"code":0,"data":{"items":[]}}'), false);
    assert.equal(
      slotSatisfied(mode, "token_packs_list", '{"code":401,"data":{"items":[],"historyCount":1,"pageSize":10}}'),
      false,
    );
    assert.equal(slotSatisfied(mode, "token_packs_list", '{"code":0,"data":{}}'), false);
    // LongCat 的 summary / api_usage 槽位只要求合法 JSON（Rust adapter 语义），
    // 登录失效由「明确登录页 URL」判定；list 槽位才做业务信封校验。
    // 注意 `aggregateComplete` 只检查槽位是否到齐（与 Rust 一致），是否「到位」由
    // collectSlots 的 satisfies 过滤决定，因此这里走完整的 record → collect 链路。
    const buffered: Array<[string, string]> = [
      ["https://longcat.chat/api/pay/quota/metering/token-packs/summary", '{"code":"UNAUTHORIZED"}'],
      ["https://longcat.chat/api/pay/quota/metering/api-usage/summary", '{"code":"UNAUTHORIZED"}'],
      [
        "https://longcat.chat/api/pay/commercial/entitlements/token-packs/list",
        '{"code":0,"data":{"items":[{"resourceId":"1"}],"historyCount":1,"pageSize":10}}',
      ],
    ];
    const complete = collectSlots(buffered, mode);
    assert.equal(complete.size, 3);
    assert.equal(aggregateComplete(complete, mode), true);

    const broken: Array<[string, string]> = [
      ["https://longcat.chat/api/pay/quota/metering/token-packs/summary", '{"code":"UNAUTHORIZED"}'],
      ["https://longcat.chat/api/pay/quota/metering/api-usage/summary", '{"code":"UNAUTHORIZED"}'],
      ["https://longcat.chat/api/pay/commercial/entitlements/token-packs/list", '{"code":"UNAUTHORIZED"}'],
    ];
    const incomplete = collectSlots(broken, mode);
    assert.equal(incomplete.has("token_packs_list"), false);
    assert.equal(aggregateComplete(incomplete, mode), false);
  });

  it("Qwen 双资源模式解析到不同抓取描述（token_plan / freetier）", () => {
    const test = ctxOf();
    const tokenPlan = resolveScrapeMode(test.ctx, "qwen", "token_plan", "qwen tp");
    const payAsYouGo = resolveScrapeMode(test.ctx, "qwen", "pay_as_you_go", "qwen paygo");
    assert.ok(tokenPlan !== null);
    assert.ok(payAsYouGo !== null);
    assert.equal(tokenPlan.consoleUrl, "https://platform.qianwenai.com/home/billing/subscription/token-plan-individual");
    assert.deepEqual(tokenPlan.requiredSlots, ["subscription", "quota_config", "usage"]);
    assert.equal(payAsYouGo.consoleUrl, "https://platform.qianwenai.com/home/benefits");
    assert.deepEqual(payAsYouGo.requiredSlots, ["freetier_list", "fq_instance", "billing_amount"]);

    // 历史账号 resource_mode 缺失时回退默认按量付费（freetier）。
    const legacy = resolveScrapeMode(test.ctx, "qwen", null, "qwen legacy");
    assert.ok(legacy !== null);
    assert.equal(legacy.consoleUrl, "https://platform.qianwenai.com/home/benefits");

    // Token Plan 槽位校验：登录失效（缺 DataV2 业务信封）不算抓全。
    assert.equal(
      slotSatisfied(
        tokenPlan,
        "subscription",
        '{"data":{"DataV2":{"data":{"data":{"specCode":"x","status":"VALID"}}}}}',
      ),
      true,
    );
    assert.equal(
      slotSatisfied(tokenPlan, "subscription", '{"code":"UNAUTHORIZED"}'),
      false,
    );
    // 月口径额度窗口必须被接受（上游改版后的主窗口）。
    assert.equal(
      slotSatisfied(
        tokenPlan,
        "quota_config",
        '{"data":{"DataV2":{"data":{"data":{"standard":{"monthly":10000}}}}}}',
      ),
      true,
    );
  });

  it("Z.AI paygo 抓资源包列表 + 钱包报告，两者都必须业务成功", () => {
    const test = ctxOf();
    const mode = resolveScrapeMode(test.ctx, "zhipu", "pay_as_you_go", "zhipu account");
    assert.ok(mode !== null);
    assert.equal(scrapePhases(mode).length, 1);
    assert.deepEqual(mode.requiredSlots, ["token_packs_list", "account_report"]);
    assert.equal(
      classifySlot(mode, "https://www.bigmodel.cn/api/biz/tokenaccounts/list/my"),
      "token_packs_list",
    );
    assert.equal(
      classifySlot(mode, "https://www.bigmodel.cn/api/biz/account/query-customer-account-report"),
      "account_report",
    );
    assert.equal(slotSatisfied(mode, "token_packs_list", '{"code":200,"rows":[]}'), true);
    assert.equal(slotSatisfied(mode, "token_packs_list", '{"code":401,"msg":"unauthorized"}'), false);
    assert.equal(slotSatisfied(mode, "account_report", '{"code":200,"data":{}}'), true);
    assert.equal(slotSatisfied(mode, "account_report", '{"success":true,"data":{}}'), true);
    assert.equal(slotSatisfied(mode, "account_report", '{"code":401,"msg":"unauthorized"}'), false);
  });

  it("不支持抓取的渠道（deepseek / openrouter / custom 无描述符）返回 null", () => {
    const test = ctxOf();
    assert.equal(resolveScrapeMode(test.ctx, "deepseek", null, "ds"), null);
    assert.equal(resolveScrapeMode(test.ctx, "openrouter", null, "or"), null);
    assert.equal(resolveScrapeMode(test.ctx, "kimi", null, "kimi"), null);
    assert.equal(resolveScrapeMode(test.ctx, "custom", null, "no-descriptor"), null);
    assert.equal(resolveCustomScrapeMode("custom", "no-descriptor", null), null);
  });

  it("config.json 的 scrape 配置可直接从 channels[] 逐 mode 读取（与 Rust scrape_config 同源）", () => {
    const test = ctxOf();
    const longcat = builtinScrapeModeConfig(test.ctx, "longcat", "hybrid");
    assert.ok(longcat !== null);
    assert.equal(longcat.console_url_secondary, "https://longcat.chat/platform/usage?tab=api");
    assert.equal(builtinScrapeModeConfig(test.ctx, "longcat", "nope"), null);
    assert.equal(builtinScrapeModeConfig(test.ctx, "missing-channel", "hybrid"), null);
  });

  it("extractor 调用源只包装成单个函数表达式，内层仍是 config.json 的 extractor", () => {
    const test = ctxOf();
    const mode = resolveScrapeMode(test.ctx, "longcat", "hybrid", null);
    assert.ok(mode !== null);
    const source = buildExtractorSource(mode.extractorJs, mode.aggregate, "token_packs_summary");
    assert.ok(source.startsWith("function (__flowlet_bundle, __flowlet_credential) {"));
    assert.ok(source.endsWith("}"));
    // 内层 extractor 原样嵌入（保留 config.json 的 helper 内联约束）。
    assert.ok(source.includes(mode.extractorJs.trim()));

    const single = buildExtractorSource("function extract(raw){return {};}", false, "api_usage_summary");
    assert.ok(single.includes('var __flowlet_target = "api_usage_summary";'));
  });
});