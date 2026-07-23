import { describe, expect, it } from "vitest";
import { parseQwenTokenPlanDetails } from "./qwenTokenPlanDetails";

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
        total: 3000,
        used: 0,
        remaining: 3000,
        remainingPercent: 100,
        resetAt: null,
      },
      sevenDay: {
        total: 10000,
        used: 7890,
        remaining: 2110,
        resetAt: new Date(1785130440000).toISOString(),
      },
    });
    expect(details?.sevenDay?.remainingPercent).toBeCloseTo(21.1);
  });

  it("returns null for legacy summary-only snapshots", () => {
    expect(parseQwenTokenPlanDetails('{"token_total":10000}')).toBeNull();
  });
});

function response(data: Record<string, unknown>) {
  return { data: { DataV2: { data: { data } } } };
}
