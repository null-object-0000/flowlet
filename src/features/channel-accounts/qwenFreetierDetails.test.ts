import { describe, expect, it } from "vitest";
import {
  formatQwenFreeQuotaValue,
  parseQwenFreeTierDetails,
  qwenFreeQuotaByModel,
  type QwenFreeQuotaInstance,
  type QwenFreeTierDetails,
} from "./qwenFreetierDetails";

const BILLING = {
  data: {
    AvailableAmount: 106.13,
    CashBalanceAmount: 145.52,
    UnsettledAmount: 39.39,
    SettleCurrency: "CNY",
    Currency: "CNY",
    BillingAccountStatus: "VALID",
  },
};

const FQ = {
  data: {
    Data: [
      {
        Status: "valid",
        InitCapacity: { BaseValue: 30000.0, ShowUnit: "万字", ShowValue: "3.000000" },
        CurrCapacity: { BaseValue: 18000.0, ShowUnit: "万字", ShowValue: "1.800000" },
        Template: { Code: "sfm_inference_public_cn_20251111100408_0031", Name: "sambert-perla-v1" },
        CurrentCycleStartTime: "Sat Aug 01 00:00:00 CST 2026",
        CurrentCycleEndTime: "Tue Sep 01 00:00:00 CST 2026",
        EndTime: "Thu Jan 01 00:00:00 CST 2099",
      },
      {
        Status: "valid",
        InitCapacity: { BaseValue: 1000000.0, ShowUnit: "千tokens", ShowValue: "1000.000000" },
        CurrCapacity: { BaseValue: 1000000.0, ShowUnit: "千tokens", ShowValue: "1000.000000" },
        Template: { Code: "sfm_inference_public_cn_20251111100430_0719", Name: "qwen-plus" },
        CurrentCycleStartTime: "Sat Aug 01 00:00:00 CST 2026",
        CurrentCycleEndTime: "Tue Sep 01 00:00:00 CST 2026",
        EndTime: "Thu Jan 01 00:00:00 CST 2099",
      },
      {
        Status: "expire",
        InitCapacity: { BaseValue: 1000000.0, ShowUnit: "千tokens", ShowValue: "1000.000000" },
        CurrCapacity: { BaseValue: 1000000.0, ShowUnit: "千tokens", ShowValue: "1000.000000" },
        Template: { Code: "sfm_inference_public_cn_20251111100307_0803", Name: "qwen3-max-2025-10-30" },
        CurrentCycleStartTime: "Thu Oct 30 00:00:00 CST 2025",
        CurrentCycleEndTime: "Wed Jan 28 00:00:00 CST 2026",
        EndTime: "Wed Jan 28 00:00:00 CST 2026",
      },
      {
        // 剩余为 0 的 valid 实例不算「可用」。
        Status: "valid",
        InitCapacity: { BaseValue: 100.0, ShowUnit: "张", ShowValue: "100.000000" },
        CurrCapacity: { BaseValue: 0.0, ShowUnit: "张", ShowValue: "0.000000" },
        Template: { Code: "sfm_inference_public_cn_20251111100517_0226", Name: "wan2.2-animate-mix" },
        CurrentCycleStartTime: "Sat Aug 01 00:00:00 CST 2026",
        CurrentCycleEndTime: "Tue Sep 01 00:00:00 CST 2026",
        EndTime: "Thu Jan 01 00:00:00 CST 2099",
      },
    ],
    TotalCount: 4,
  },
};

function bundle(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    freetier_list: { data: { Data: [{ TemplateCode: "sfm_inference_public_cn", Safemode: "off" }] } },
    fq_instance: FQ,
    billing_amount: BILLING,
    settle_bill: { data: { Data: [{ BillingCycle: "202608", TotalPriceSettleFee: "366.000000" }] } },
    cert_info: { code: "200", data: { certified: true, subjectType: "personal", subjectName: "**恩" } },
    ...extra,
  });
}

describe("parseQwenFreeTierDetails", () => {
  it("parses billing, settle bill and certification info", () => {
    const details = parseQwenFreeTierDetails(bundle());
    expect(details).not.toBeNull();
    expect(details?.balance).toBe(106.13);
    expect(details?.currency).toBe("CNY");
    expect(details?.unsettledAmount).toBe(39.39);
    expect(details?.cashBalance).toBe(145.52);
    expect(details?.settleBillCycle).toBe("202608");
    expect(details?.settleBillTotal).toBe(366);
    expect(details?.certified).toBe(true);
    expect(details?.subjectType).toBe("personal");
    expect(details?.aliyunId).toBeNull();
  });

  it("parses instances and keeps only valid ones with remaining quota", () => {
    const details = parseQwenFreeTierDetails(bundle());
    expect(details?.instances).toHaveLength(4);
    expect(details?.validInstances).toHaveLength(2);
    expect(details?.expiredCount).toBe(2);

    const names = details?.validInstances.map((instance) => instance.name);
    expect(names).toEqual(["sambert-perla-v1", "qwen-plus"]);
  });

  it("computes remaining percent and parses CST cycle times", () => {
    const details = parseQwenFreeTierDetails(bundle())!;
    const first = details.instances[0];
    expect(first.remainingPercent).toBe(60); // 18000 / 30000
    expect(first.cycleEndAt).toBe("2026-08-31T16:00:00.000Z"); // Tue Sep 01 00:00:00 CST 2026 = UTC+8
    // 数量单位字段保留原始展示口径。
    expect(first.showValue).toBe(1.8);
    expect(first.showUnit).toBe("万字");
  });

  it("maps valid quotas by lowercase model name for pick-list annotation", () => {
    const details = parseQwenFreeTierDetails(bundle())!;
    const map = qwenFreeQuotaByModel(details);
    expect(map.has("sambert-perla-v1")).toBe(true);
    expect(map.get("sambert-perla-v1")?.name).toBe("sambert-perla-v1");
    expect(map.has("qwen-plus")).toBe(true);
    // Map 键统一小写：调用方（模型勾选列表）必须先用 model.trim().toLowerCase() 查找。
    expect(map.has("SAMBERT-PERLA-V1")).toBe(false);
    expect(map.has("wan2.2-animate-mix")).toBe(false); // 剩余 0
    expect(map.has("qwen3-max-2025-10-30")).toBe(false); // 已过期
  });

  it("returns null for empty or malformed bundles", () => {
    expect(parseQwenFreeTierDetails(null)).toBeNull();
    expect(parseQwenFreeTierDetails("not json")).toBeNull();
    expect(parseQwenFreeTierDetails(JSON.stringify({ billing_amount: { data: {} } }))).not.toBeNull();
    expect(parseQwenFreeTierDetails(JSON.stringify({}))).not.toBeNull();
  });

  it("keeps summary available without optional slots", () => {
    const details = parseQwenFreeTierDetails(JSON.stringify({ billing_amount: BILLING })) as QwenFreeTierDetails;
    expect(details.balance).toBe(106.13);
    expect(details.instances).toHaveLength(0);
    expect(details.expiredCount).toBe(0);
  });
});

describe("formatQwenFreeQuotaValue", () => {
  const instance = (overrides: Partial<QwenFreeQuotaInstance>): QwenFreeQuotaInstance => ({
    templateCode: "code",
    name: "model",
    status: "valid",
    init: null,
    current: null,
    unit: null,
    showValue: null,
    showUnit: null,
    remainingPercent: null,
    cycleStartAt: null,
    cycleEndAt: null,
    endAt: null,
    ...overrides,
  });

  it("normalizes 千tokens into compact token counts", () => {
    // ShowValue=1000 千tokens = 1,000,000 tokens，不再展示「1000 千tokens」。
    expect(formatQwenFreeQuotaValue(
      instance({ showValue: 1000, showUnit: "千tokens" }),
      "zh-CN",
    )).toBe("100.00万 Tokens");
    expect(formatQwenFreeQuotaValue(
      instance({ showValue: 1000, showUnit: "千tokens" }),
      "en-US",
    )).toBe("1.00M Tokens");
    // 小额（不足一万/一千）按整数展示。
    expect(formatQwenFreeQuotaValue(
      instance({ showValue: 5, showUnit: "千tokens" }),
      "zh-CN",
    )).toBe("5,000 Tokens");
  });

  it("normalizes 万字 into character counts", () => {
    expect(formatQwenFreeQuotaValue(
      instance({ showValue: 3, showUnit: "万字" }),
      "zh-CN",
    )).toBe("3.00万 字");
    expect(formatQwenFreeQuotaValue(
      instance({ showValue: 3, showUnit: "万字" }),
      "en-US",
    )).toBe("30.00K 字");
  });

  it("keeps non-counting units as-is", () => {
    expect(formatQwenFreeQuotaValue(
      instance({ showValue: 36000, showUnit: "秒" }),
      "zh-CN",
    )).toBe("36,000 秒");
    expect(formatQwenFreeQuotaValue(
      instance({ showValue: 100, showUnit: "张" }),
      "zh-CN",
    )).toBe("100 张");
  });

  it("falls back to BaseValue/current when ShowValue is missing and dashes when unknown", () => {
    // current=500000 千tokens = 5 亿 tokens。
    expect(formatQwenFreeQuotaValue(
      instance({ current: 500000, unit: "千tokens" }),
      "zh-CN",
    )).toBe("5.00亿 Tokens");
    expect(formatQwenFreeQuotaValue(instance({}), "zh-CN")).toBe("-");
  });
});