import { describe, expect, it } from "vitest";
import {
  isQwenSubscriptionActive,
  parseQwenTokenPlanDetails,
  qwenSubscriptionInactiveKind,
} from "./qwenTokenPlanDetails";

describe("parseQwenTokenPlanDetails", () => {
  it("builds the subscription and both official quota windows", () => {
    const raw = JSON.stringify({
      subscription: response({
        specCode: "standard",
        remainingDays: 28,
        startTime: 1784512320000,
        endTime: 1787241600000,
        autoRenewFlag: false,
        status: "VALID",
      }),
      quota_config: response({
        standard: { five_hour: 3000, weekly: 10000 },
      }),
      usage: response({
        per5HourPercentage: 0,
        per1WeekPercentage: 0.789,
        per1WeekResetTime: 1785130440000,
      }),
    });

    const details = parseQwenTokenPlanDetails(raw);
    expect(details).toMatchObject({
      specCode: "standard",
      status: "VALID",
      autoRenew: false,
      remainingDays: 28,
      startAt: new Date(1784512320000).toISOString(),
      expireAt: new Date(1787241600000).toISOString(),
      fiveHour: {
        key: "five_hour",
        label: "5 小时",
        total: 3000,
        used: 0,
        remaining: 3000,
        remainingPercent: 100,
        resetAt: null,
      },
      primary: {
        key: "weekly",
        label: "7 天",
        total: 10000,
        used: 7890,
        remaining: 2110,
        resetAt: new Date(1785130440000).toISOString(),
      },
    });
    expect(details?.primaryLabel).toBe("7 天");
    expect(details?.windows.map((window) => window.key)).toEqual(["five_hour", "weekly"]);
    expect(details?.primary?.remainingPercent).toBeCloseTo(21.1);
  });

  it("reads the monthly quota window from the revamped console payload", () => {
    // 2026-10 控制台改版后的真实形态：额度只有 five_hour + monthly，
    // 用量只有 per1MonthPercentage（旧的 weekly / per1WeekPercentage 已消失）。
    const raw = JSON.stringify({
      subscription: response({ specCode: "standard", status: "VALID", endTime: 1795000000000 }),
      quota_config: response({ standard: { five_hour: 3000, monthly: 45000 } }),
      usage: response({
        per1MonthPercentage: 0.8008054844444444,
        per1MonthResetTime: 1792598400000,
      }),
    });

    const details = parseQwenTokenPlanDetails(raw);
    // 5 小时只有额度总量、没有用量百分比，不产出进度窗口。
    expect(details?.fiveHour).toBeNull();
    expect(details?.windows.map((window) => window.key)).toEqual(["monthly"]);
    expect(details?.primary).toMatchObject({
      key: "monthly",
      label: "每月",
      total: 45000,
      used: Math.round(45000 * 0.8008054844444444),
      remaining: 45000 - Math.round(45000 * 0.8008054844444444),
      resetAt: new Date(1792598400000).toISOString(),
    });
    expect(details?.primary?.remainingPercent).toBeCloseTo(19.92, 2);
    expect(details?.primaryLabel).toBe("每月");
  });

  it("keeps the declared primary window label when the usage percentage is missing", () => {
    // 额度配置声明了月额度但用量还没回来时，主额度槽位仍必须显示「每月」而不是「7 天」。
    const raw = JSON.stringify({
      subscription: response({ specCode: "standard", status: "VALID" }),
      quota_config: response({ standard: { five_hour: 3000, monthly: 45000 } }),
      usage: response({}),
    });

    const details = parseQwenTokenPlanDetails(raw);
    expect(details?.windows).toEqual([]);
    expect(details?.fiveHour).toBeNull();
    expect(details?.primary).toBeNull();
    expect(details?.primaryLabel).toBe("每月");
  });

  it("returns null for legacy summary-only snapshots", () => {
    expect(parseQwenTokenPlanDetails('{"token_total":10000}')).toBeNull();
  });

  it("treats expired subscriptions as inactive and legacy snapshots as active", () => {
    const build = (subscription: Record<string, unknown>) => JSON.stringify({
      subscription: response({ specCode: "standard", ...subscription }),
      quota_config: response({ standard: { five_hour: 3000, weekly: 10000 } }),
      usage: response({ per1WeekPercentage: 0.5 }),
    });

    // 明确过期：无效。
    const expired = parseQwenTokenPlanDetails(build({ status: "EXPIRED", endTime: 1767225600000 }));
    expect(expired?.status).toBe("EXPIRED");
    expect(isQwenSubscriptionActive(expired)).toBe(false);
    expect(qwenSubscriptionInactiveKind(expired)).toBe("expired");

    // 未订阅（接口返回空对象，specCode 兜底 standard、status 缺失）：向后兼容视为有效。
    // 状态判定以接口明确返回为准；这里验证 null status 的兼容语义。
    const noStatus = parseQwenTokenPlanDetails(build({}));
    expect(noStatus?.status).toBeNull();
    expect(isQwenSubscriptionActive(noStatus)).toBe(true);

    // 明确有效。
    const valid = parseQwenTokenPlanDetails(build({ status: "VALID" }));
    expect(isQwenSubscriptionActive(valid)).toBe(true);

    // 无快照：无效。
    expect(isQwenSubscriptionActive(null)).toBe(false);
  });

  it("parses active reset cards into the Codex-aligned structure", () => {
    const raw = JSON.stringify({
      subscription: response({ specCode: "standard", endTime: 1787241600000 }),
      quota_config: response({ standard: { five_hour: 3000, weekly: 10000 } }),
      usage: response({ per5HourPercentage: 0, per1WeekPercentage: 0 }),
      reset_card_list: cardListResponse([
        {
          cardNo: "CARD-ACTIVE",
          cardType: "RESET_1W",
          effectiveAt: Date.now() - 1000,
          expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
        },
        {
          cardNo: "CARD-EXPIRED",
          cardType: "RESET_1W",
          effectiveAt: Date.now() - 2 * 24 * 3600 * 1000,
          expiresAt: Date.now() - 1000,
        },
      ]),
    });

    const details = parseQwenTokenPlanDetails(raw);
    expect(details).not.toBeNull();
    expect(details?.resetCards).toMatchObject({
      available_count: 1,
      credits: [
        {
          id: "CARD-ACTIVE",
          reset_type: "RESET_1W",
          status: "ACTIVE",
          title: null,
        },
      ],
    });
    const card = details?.resetCards?.credits?.[0];
    expect(typeof card?.granted_at).toBe("number");
    expect(typeof card?.expires_at).toBe("number");
  });

  it("keeps resetCards null when the optional reset-card slot is absent", () => {
    const raw = JSON.stringify({
      subscription: response({ specCode: "standard" }),
      quota_config: response({ standard: { five_hour: 3000, weekly: 10000 } }),
      usage: response({ per5HourPercentage: 0, per1WeekPercentage: 0 }),
    });

    const details = parseQwenTokenPlanDetails(raw);
    expect(details).not.toBeNull();
    expect(details?.resetCards).toBeNull();
  });

  it("filters out expired and not-yet-effective cards", () => {
    const raw = JSON.stringify({
      subscription: response({ specCode: "standard" }),
      quota_config: response({ standard: { five_hour: 3000, weekly: 10000 } }),
      usage: response({ per5HourPercentage: 0, per1WeekPercentage: 0 }),
      reset_card_list: cardListResponse([
        {
          cardNo: "EXPIRED",
          cardType: "RESET_1W",
          effectiveAt: Date.now() - 2 * 24 * 3600 * 1000,
          expiresAt: Date.now() - 24 * 3600 * 1000,
        },
        {
          cardNo: "PENDING",
          cardType: "RESET_1W",
          effectiveAt: Date.now() + 24 * 3600 * 1000,
          expiresAt: Date.now() + 2 * 24 * 3600 * 1000,
        },
      ]),
    });

    const details = parseQwenTokenPlanDetails(raw);
    expect(details).not.toBeNull();
    expect(details?.resetCards).toBeNull();
  });

  it("converts second-level reset card timestamps into epoch millis", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify({
      subscription: response({ specCode: "standard" }),
      quota_config: response({ standard: { five_hour: 3000, weekly: 10000 } }),
      usage: response({ per5HourPercentage: 0, per1WeekPercentage: 0 }),
      reset_card_list: cardListResponse([
        {
          cardNo: "CARD-SEC",
          cardType: "RESET_1W",
          effectiveAt: nowSeconds - 60,
          expiresAt: nowSeconds + 7 * 24 * 3600,
        },
      ]),
    });

    const details = parseQwenTokenPlanDetails(raw);
    const card = details?.resetCards?.credits?.[0];
    expect(card?.granted_at).toBe((nowSeconds - 60) * 1000);
    expect(card?.expires_at).toBe((nowSeconds + 7 * 24 * 3600) * 1000);
  });
});

function response(data: Record<string, unknown>) {
  return { data: { DataV2: { data: { data } } } };
}

function cardListResponse(cards: unknown[]) {
  return { data: { DataV2: { data: { data: cards } } } };
}
