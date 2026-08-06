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
