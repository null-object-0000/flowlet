import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type ZhipuExtractResult = {
  balance: number | null;
  currency: string | null;
  plan_name: string;
  token_total: number | null;
  token_used: number | null;
  token_remaining: number | null;
  token_expire_at: string | null;
  token_packs: Array<Record<string, unknown>> | null;
};

function loadZhipuExtractor(): (bundle: unknown) => ZhipuExtractResult | null {
  // vitest 始终从仓库根目录启动（npm test），jsdom 环境下 import.meta.url 不是 file:// 协议。
  const configPath = resolve(process.cwd(), "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
    channels_config: {
      channels: Array<{ id: string; scrape?: Record<string, { extractor_js?: string }> }>;
    };
  };
  const extractorSource = config.channels_config.channels
    .find((channel) => channel.id === "zhipu")
    ?.scrape?.paygo?.extractor_js;
  if (!extractorSource) throw new Error("config.json 缺少 zhipu paygo extractor_js");
  return new Function(`return (${extractorSource});`)() as (
    bundle: unknown,
  ) => ZhipuExtractResult | null;
}

const extract = loadZhipuExtractor();

// 上游真实字段（与 bigmodel.cn 资源包管理页 / tokenAccounts/list/my 的 rows 一致）：
// tokenBalance=总量，availableBalance=剩余，packageExpirationTime=到期，
// suitableScene=适用场景，consumeType=TOKENS/TIMES，status=EFFECTIVE/NOTUSED/EXPIRED/CANCELLED。
const REAL_BUNDLE = {
  account_report: {
    code: 200,
    data: {
      balance: 100,
      rechargeAmount: 80,
      giveAmount: 20,
      totalSpendAmount: 30,
      frozenBalance: 0,
      availableBalance: 70,
    },
  },
  token_packs_list: {
    code: 200,
    total: 2,
    rows: [
      {
        type: "pay",
        resourcePackageName: "500万GLM-4.7体验包",
        tokenBalance: 5_000_000,
        availableBalance: 3_000_000,
        consumeType: "TOKENS",
        status: "EFFECTIVE",
        suitableScene: "通用",
        purchaseTime: "2026-08-01",
        effectiveTime: "2026-08-01",
        packageExpirationTime: "2026-12-31",
      },
      {
        type: "give",
        resourcePackageName: "按次调用包",
        tokenBalance: 100,
        availableBalance: 100,
        consumeType: "TIMES",
        status: "EFFECTIVE",
        suitableScene: "视频理解",
        purchaseTime: "2026-08-02",
        effectiveTime: "2026-08-02",
        packageExpirationTime: "2026-12-31",
      },
    ],
  },
};

describe("Z.AI paygo extractor (config.json)", () => {
  it("maps tokenBalance / availableBalance to token totals and balance", () => {
    const result = extract(REAL_BUNDLE);
    expect(result).not.toBeNull();
    expect(result?.plan_name).toBe("API 按量付费");
    expect(result?.balance).toBe(70);
    expect(result?.currency).toBe("CNY");
    expect(result?.token_total).toBe(5_000_000);
    expect(result?.token_used).toBe(2_000_000);
    expect(result?.token_remaining).toBe(3_000_000);
    expect(result?.token_expire_at).toBe("2026-12-31");
    expect(result?.token_packs).toHaveLength(2);
    const pack = result?.token_packs?.[0] as Record<string, unknown>;
    expect(pack.packageName).toBe("500万GLM-4.7体验包");
    expect(pack.totalToken).toBe(5_000_000);
    expect(pack.remainingToken).toBe(3_000_000);
    expect(pack.statusText).toBe("生效中");
    expect(pack.suitableScene).toBe("通用");
  });

  it("excludes TIMES packs from token summary", () => {
    const result = extract(REAL_BUNDLE);
    // 仅 TOKENS 生效包参与汇总，按次包不影响 token_total。
    expect(result?.token_total).toBe(5_000_000);
    expect(result?.token_packs?.some((p) => p.consumeType === "TIMES")).toBe(true);
  });

  it("coerces string amounts", () => {
    const result = extract({
      account_report: { code: 200, data: { availableBalance: "70.50" } },
      token_packs_list: {
        code: 200,
        rows: [
          {
            resourcePackageName: "字符串额度包",
            tokenBalance: "1000",
            availableBalance: "400",
            consumeType: "TOKENS",
            status: "EFFECTIVE",
            packageExpirationTime: "2026-12-31",
          },
        ],
      },
    });
    expect(result?.balance).toBe(70.5);
    expect(result?.token_total).toBe(1000);
    expect(result?.token_remaining).toBe(400);
  });

  it("returns null balance and no summary for an auth-error bundle", () => {
    const result = extract({
      account_report: { code: 401, msg: "unauthorized" },
      token_packs_list: { code: 401, rows: null },
    });
    expect(result).not.toBeNull();
    expect(result?.balance).toBeNull();
    expect(result?.token_total).toBeNull();
    expect(result?.token_packs).toEqual([]);
  });
});
