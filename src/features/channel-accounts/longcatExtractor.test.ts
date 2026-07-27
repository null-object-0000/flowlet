import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type LongCatExtractResult = {
  balance: number | null;
  currency: string | null;
  plan_name: string;
  token_total: number | null;
  token_used: number | null;
  token_remaining: number | null;
  token_expire_at: string | null;
  token_packs: Array<Record<string, unknown>> | null;
};

function loadLongCatExtractor(): (bundle: unknown) => LongCatExtractResult | null {
  // vitest 始终从仓库根目录启动（npm test），jsdom 环境下 import.meta.url 不是 file:// 协议。
  const configPath = resolve(process.cwd(), "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
    channels_config: {
      channels: Array<{ id: string; scrape?: Record<string, { extractor_js?: string }> }>;
    };
  };
  const extractorSource = config.channels_config.channels
    .find((channel) => channel.id === "longcat")
    ?.scrape?.hybrid?.extractor_js;
  if (!extractorSource) throw new Error("config.json 缺少 longcat hybrid extractor_js");
  // extractor_js 是函数声明字符串（function extract(bundle){...}），按表达式求值后调用。
  return new Function(`return (${extractorSource});`)() as (bundle: unknown) => LongCatExtractResult | null;
}

const extract = loadLongCatExtractor();

const EXHAUSTED_HISTORY_ITEM = {
  resourceId: "2071803119104245853",
  packageName: "问卷Token包",
  sourceTypeCode: 4,
  sourceTypeText: "下发",
  statusCode: 4,
  statusText: "已用尽",
  totalTokenAmount: 5_000_000,
  usedTokenAmount: 5_000_000,
  remainTokenAmount: 0,
  usagePercent: 100,
  validEndTime: "2026-07-30T03:48:49.000+00:00",
};

describe("LongCat hybrid extractor (config.json)", () => {
  it("keeps token_remaining = 0 when all resource packs are used up", () => {
    const result = extract({
      token_packs_summary: { code: 0, msg: "success", data: { currentLot: null, otherLots: [] } },
      api_usage_summary: {
        code: 0,
        msg: "success",
        data: { paygoBalanceCent: 0, paygoBalance: { primary: { currency: "CNY", amount: "0.00" } } },
      },
      token_packs_list: {
        code: 0,
        msg: "success",
        data: { activeCount: 0, historyCount: 1, total: 1, items: [EXHAUSTED_HISTORY_ITEM] },
      },
    });

    // 资源包全部用尽时剩余必须记 0（前端照常展示「资源包 0 Tokens」），而不是 null。
    expect(result?.token_remaining).toBe(0);
    // 历史包不参与 total / used 汇总，无活跃包时保持 null。
    expect(result?.token_total).toBeNull();
    expect(result?.token_used).toBeNull();
    expect(result?.token_expire_at).toBeNull();
    expect(result?.balance).toBe(0);
    expect(result?.currency).toBe("CNY");
    expect(result?.token_packs).toHaveLength(1);
    expect(result?.token_packs?.[0]).toMatchObject({ _fromList: true, lotId: "2071803119104245853" });
  });

  it("sums active lots and preserves real zeros for total / used", () => {
    const result = extract({
      token_packs_summary: {
        code: 0,
        msg: "success",
        data: {
          currentLot: {
            lotId: 151724,
            totalToken: 50_000_000,
            consumedToken: 0,
            remainingToken: 50_000_000,
            expireTime: "2026-07-30 01:00:31",
            status: "ACTIVE",
          },
          otherLots: [],
        },
      },
      api_usage_summary: {
        code: 0,
        msg: "success",
        data: { paygoBalanceCent: 100, paygoBalance: { primary: { currency: "CNY" } } },
      },
      token_packs_list: { code: 0, msg: "success", data: { items: [] } },
    });

    expect(result?.token_total).toBe(50_000_000);
    expect(result?.token_used).toBe(0);
    expect(result?.token_remaining).toBe(50_000_000);
    expect(result?.token_expire_at).toBe("2026-07-30 01:00:31");
    expect(result?.balance).toBe(1);
    expect(result?.token_packs).toHaveLength(1);
  });

  it("writes null pack fields when the account has no resource packs at all", () => {
    const result = extract({
      token_packs_summary: { code: 0, msg: "success", data: { currentLot: null, otherLots: [] } },
      api_usage_summary: {
        code: 0,
        msg: "success",
        data: { paygoBalanceCent: 100, paygoBalance: { primary: { currency: "CNY" } } },
      },
      token_packs_list: { code: 0, msg: "success", data: { items: [] } },
    });

    expect(result?.token_remaining).toBeNull();
    expect(result?.token_total).toBeNull();
    expect(result?.token_used).toBeNull();
    expect(result?.token_packs).toBeNull();
    expect(result?.balance).toBe(1);
  });
});
