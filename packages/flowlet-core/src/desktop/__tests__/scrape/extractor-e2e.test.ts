// 端到端提取链路：命令层构造的 extractor source 必须能在页面环境执行。
//
// 宿主 `scrape.evaluate` 的实现是 `(<source>)(bundle, credential)`，与 wry 的
// `(extractor_js)(bundle, credential)` 同形。这里用 `node:vm` 模拟那个调用点，
// 用仓库 config.json 里**真实的** interceptor/extractor 验证：
// - 抽象包装不破坏 extractor（helper 内联约束不变）；
// - bundle 形状（聚合槽位 → 解析后的 JSON）与 Rust `build_aggregate_bundle` 一致；
// - credential 作为第二实参传入，内置 extractor 忽略它也不报错；
// - 产物能按 Rust `ScrapeBalanceResult` 字段读出。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it } from "node:test";

import type { JsonRow } from "../../../types.ts";
import { DEFAULT_BUILTIN_CONFIG } from "../../../config/index.ts";
import {
  buildExtractorSource,
  credentialKeyContext,
  parseExtractorOutput,
  readExtractedBalance,
} from "../../../scrape/extractor.ts";
import { buildAggregateBundle, collectSlots, type ScrapeMode } from "../../../scrape/slot-engine.ts";
import { normalizeScrapeTokenPacks } from "../../../scrape/token-packs.ts";

const config = JSON.parse(readFileSync(DEFAULT_BUILTIN_CONFIG, "utf8")) as JsonRow;
const channels = (config.channels_config as JsonRow).channels as JsonRow[];

function builtinMode(channelId: string, modeKey: string): ScrapeMode {
  const channel = channels.find((item) => item.id === channelId);
  assert.ok(channel !== undefined, `config.json 缺少渠道 ${channelId}`);
  const mode = ((channel.scrape as JsonRow)[modeKey] ?? null) as JsonRow | null;
  assert.ok(mode !== null, `渠道 ${channelId} 缺少 ${modeKey} 抓取模式`);
  return {
    consoleUrl: String(mode["console_url"]),
    consoleUrlSecondary: (mode["console_url_secondary"] as string | undefined) ?? null,
    consoleUrlTertiary: (mode["console_url_tertiary"] as string | undefined) ?? null,
    interceptorJs: String(mode["interceptor_js"]),
    extractorJs: String(mode["extractor_js"]),
    aggregate: mode["aggregate"] === true,
    requiredSlots: (mode["required_slots"] as string[] | undefined) ?? [],
    slotRules: null,
    login: null,
    summaryPlan: null,
  };
}

/** 模拟宿主 `scrape.evaluate`：新建 sandbox 求值 `(<source>)(bundle, credential)`。 */
function runInPage(source: string, bundle: unknown, credential: unknown): unknown {
  const context = vm.createContext({});
  const script = new vm.Script(`(\n${source}\n)`);
  const fn = script.runInContext(context) as (
    bundle: unknown,
    credential: unknown,
  ) => unknown;
  assert.equal(typeof fn, "function", "source 必须求值成函数");
  return fn(bundle, credential);
}

describe("真实 config.json extractor 端到端", () => {
  it("LongCat hybrid：三阶段槽位 → extractor → ScrapeBalanceResult 字段", () => {
    const mode = builtinMode("longcat", "hybrid");
    const buffered: Array<[string, string]> = [
      [
        "https://longcat.chat/api/pay/quota/metering/token-packs/summary",
        JSON.stringify({
          code: 0,
          data: {
            currentLot: {
              lotId: 151724,
              totalToken: 50000000,
              consumedToken: 0,
              remainingToken: 50000000,
            },
            otherLots: [
              { lotId: 159869, totalToken: 10000000, consumedToken: 1000000, remainingToken: 9000000 },
            ],
          },
        }),
      ],
      [
        "https://longcat.chat/api/pay/quota/metering/api-usage/summary",
        JSON.stringify({
          code: 0,
          data: { paygoBalanceCent: 1234, paygoBalance: { primary: { currency: "CNY" } } },
        }),
      ],
      [
        "https://longcat.chat/api/pay/commercial/entitlements/token-packs/list",
        JSON.stringify({ code: 0, data: { items: [], pageSize: 10, historyCount: 0 } }),
      ],
    ];
    const slots = collectSlots(buffered, mode);
    assert.equal(slots.size, 3);

    const bundle = buildAggregateBundle(slots);
    assert.deepEqual(Object.keys(bundle).sort(), [
      "api_usage_summary",
      "token_packs_list",
      "token_packs_summary",
    ]);

    const source = buildExtractorSource(mode.extractorJs, mode.aggregate, "token_packs_summary");
    const raw = runInPage(source, bundle, null);
    const parsed = parseExtractorOutput(raw);
    const extracted = readExtractedBalance(parsed);
    assert.equal(extracted.balance, 12.34);
    assert.equal(extracted.currency, "CNY");
    assert.equal(extracted.plan_name, "LongCat");
    assert.equal(extracted.token_total, 60000000);
    assert.equal(extracted.token_used, 1000000);
    assert.equal(extracted.token_remaining, 59000000);
    assert.equal(extracted.token_expire_at, null);
    assert.ok(extracted.token_packs !== null);

    // Rust 侧进一步按 summary/list 归一化资源包。
    const normalized = normalizeScrapeTokenPacks("longcat", slots, extracted.token_packs);
    assert.ok(normalized !== null);
    const packs = JSON.parse(normalized) as JsonRow[];
    assert.deepEqual(
      packs.map((pack) => pack["lotId"]),
      [151724, 159869],
    );
  });

  it("Qwen token_plan：DataV2 信封 → 套餐额度", () => {
    const mode = builtinMode("qwen", "token_plan");
    const buffered: Array<[string, string]> = [
      [
        "https://cs-data.qianwenai.com/data/api.json?api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fsubscription",
        JSON.stringify({
          data: {
            DataV2: {
              data: {
                data: {
                  specCode: "standard",
                  status: "VALID",
                  endTime: 1893456000000,
                },
              },
            },
          },
        }),
      ],
      [
        "https://cs-data.qianwenai.com/data/api.json?api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fquota-config",
        JSON.stringify({
          data: { DataV2: { data: { data: { standard: { monthly: 10000 } } } } },
        }),
      ],
      [
        "https://cs-data.qianwenai.com/data/api.json?api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage",
        JSON.stringify({
          data: { DataV2: { data: { data: { per1MonthPercentage: 0.25 } } } },
        }),
      ],
    ];
    const slots = collectSlots(buffered, mode);
    assert.equal(slots.size, 3, JSON.stringify([...slots.keys()]));

    const source = buildExtractorSource(mode.extractorJs, mode.aggregate, "subscription");
    const raw = runInPage(source, buildAggregateBundle(slots), null);
    const extracted = readExtractedBalance(parseExtractorOutput(raw));
    assert.equal(extracted.token_total, 10000);
    assert.equal(extracted.token_used, 2500);
    assert.equal(extracted.token_remaining, 7500);
    assert.equal(extracted.plan_name, "Token Plan 个人版(standard)");
    assert.equal(extracted.balance, null);
  });

  it("Qwen freetier：免费额度 + 账单余额", () => {
    const mode = builtinMode("qwen", "freetier");
    const buffered: Array<[string, string]> = [
      [
        "https://platform-home.qianwenai.com/data/api.json?product=freetier&action=ListBailianFreetier",
        JSON.stringify({ data: { Data: [{ Template: { Code: "t1", Name: "n1" } }] } }),
      ],
      [
        "https://platform-home.qianwenai.com/data/api.json?product=BssOpenAPI-V3&action=DescribeFqInstance",
        JSON.stringify({
          data: {
            Data: [
              {
                Template: { Code: "sfm_a", Name: "额度A" },
                Status: "valid",
                InitCapacity: { BaseValue: 1000000 },
                CurrCapacity: { BaseValue: 400000 },
              },
            ],
          },
        }),
      ],
      [
        "https://platform-home.qianwenai.com/data/api.json?product=BssOpenAPI-V3&action=GetBillingAccountAvailableAmount",
        JSON.stringify({ data: { AvailableAmount: 88.5, SettleCurrency: "CNY" } }),
      ],
    ];
    const slots = collectSlots(buffered, mode);
    assert.equal(slots.size, 3, JSON.stringify([...slots.keys()]));
    const source = buildExtractorSource(mode.extractorJs, mode.aggregate, "freetier_list");
    const raw = runInPage(source, buildAggregateBundle(slots), null);
    const extracted = readExtractedBalance(parseExtractorOutput(raw));
    assert.equal(extracted.balance, 88.5);
    assert.equal(extracted.currency, "CNY");
    assert.equal(extracted.plan_name, "API 按量付费");
    assert.equal((parseExtractorOutput(raw) as JsonRow)["free_quota_valid_total"], 1000000);
    assert.equal((parseExtractorOutput(raw) as JsonRow)["free_quota_valid_used"], 600000);
  });

  it("Z.AI paygo：资源包 + 钱包余额", () => {
    const mode = builtinMode("zhipu", "paygo");
    const buffered: Array<[string, string]> = [
      [
        "https://www.bigmodel.cn/api/biz/tokenaccounts/list/my",
        JSON.stringify({
          code: 200,
          rows: [
            {
              id: 1,
              resourcePackageName: "1000万 Tokens",
              status: "EFFECTIVE",
              consumeType: "TOKENS",
              tokenBalance: 10000000,
              availableBalance: 6000000,
              packageExpirationTime: "2026-12-31T00:00:00Z",
            },
          ],
        }),
      ],
      [
        "https://www.bigmodel.cn/api/biz/account/query-customer-account-report",
        JSON.stringify({ code: 200, data: { availableBalance: 42.5 } }),
      ],
    ];
    const slots = collectSlots(buffered, mode);
    assert.equal(slots.size, 2, JSON.stringify([...slots.keys()]));
    const source = buildExtractorSource(mode.extractorJs, mode.aggregate, "token_packs_list");
    const raw = runInPage(source, buildAggregateBundle(slots), null);
    const parsed = parseExtractorOutput(raw);
    const extracted = readExtractedBalance(parsed);
    assert.equal(extracted.balance, 42.5);
    assert.equal(extracted.currency, "CNY");
    assert.equal(extracted.plan_name, "API 按量付费");
    assert.equal(extracted.token_total, 10000000);
    assert.equal(extracted.token_used, 4000000);
    assert.equal(extracted.token_remaining, 6000000);
    assert.equal(extracted.token_expire_at, "2026-12-31T00:00:00Z");
    // Z.AI 的资源包数组由 extractor 产出并直接透传（不跑 LongCat 合并逻辑）。
    assert.ok(extracted.token_packs !== null);
    assert.equal(normalizeScrapeTokenPacks("zhipu", slots, extracted.token_packs), extracted.token_packs);
  });

  it("自定义描述符的 extractor 收到 credential 指纹（第二实参）", () => {
    const mode: ScrapeMode = {
      consoleUrl: "https://friday.example.com/billing",
      consoleUrlSecondary: null,
      consoleUrlTertiary: null,
      interceptorJs: "",
      extractorJs:
        "function extract(bundle, credential){ return { balance: 1, currency: 'CNY', plan_name: credential ? credential.keyLastFour : 'none' }; }",
      aggregate: true,
      requiredSlots: ["usage"],
      slotRules: [
        {
          key: "usage",
          match: null,
          satisfies: { kind: "json_valid" },
          merge: { kind: "last_write_wins" },
        },
      ],
      login: { kind: "generic_or_host", host: "friday.example.com" },
      summaryPlan: "API 按量付费",
    };
    const credential = credentialKeyContext("sk-8cce6b31245e45a7a426acc72551c5d8");
    assert.deepEqual(credential, { keyPrefix: "sk-8cce6", keyLastFour: "c5d8" });
    const slots = collectSlots(
      [["https://friday.example.com/api/v2/usage", JSON.stringify({ data: { used: 3 } })]],
      mode,
    );
    const source = buildExtractorSource(mode.extractorJs, true, "usage");
    const raw = runInPage(source, buildAggregateBundle(slots), credential);
    const extracted = readExtractedBalance(parseExtractorOutput(raw));
    assert.equal(extracted.plan_name, "c5d8");
  });

  it("单响应模式：extractor 收到目标槽位的原始响应字符串", () => {
    const mode: ScrapeMode = {
      consoleUrl: "https://x.example/usage?tab=api",
      consoleUrlSecondary: null,
      consoleUrlTertiary: null,
      interceptorJs: "",
      extractorJs: "function extract(raw){ return { balance: JSON.parse(raw).data.amount }; }",
      aggregate: false,
      requiredSlots: [],
      slotRules: null,
      login: null,
      summaryPlan: null,
    };
    const source = buildExtractorSource(mode.extractorJs, false, "api_usage_summary");
    const raw = runInPage(
      source,
      { api_usage_summary: JSON.stringify({ data: { amount: 5.5 } }) },
      null,
    );
    assert.equal(readExtractedBalance(parseExtractorOutput(raw)).balance, 5.5);
  });

  it("extractor 抛错时宿主拿到 rejection（不是静默空串）", () => {
    const source = buildExtractorSource(
      "function extract(){ throw new Error('boom'); }",
      true,
      "x",
    );
    assert.throws(() => runInPage(source, {}, null), /boom/);
  });
});