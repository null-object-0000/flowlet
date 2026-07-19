import { describe, expect, it } from "vitest";
import { formatCompactNumber, formatInteger } from "./number";

describe("shared number formatters", () => {
  it("uses Chinese 万、亿 and 万亿 units", () => {
    expect(formatCompactNumber(12_345, "zh-CN")).toBe("1.2万");
    expect(formatCompactNumber(43_987_000, "zh-CN")).toBe("4398.7万");
    expect(formatCompactNumber(120_000_000, "zh-CN")).toBe("1.2亿");
    expect(formatCompactNumber(1_200_000_000_000, "zh-CN")).toBe("1.2万亿");
  });

  it("uses English K, M, B and T units", () => {
    expect(formatCompactNumber(1_200, "en-US")).toBe("1.2K");
    expect(formatCompactNumber(1_200_000, "en-US")).toBe("1.2M");
    expect(formatCompactNumber(1_200_000_000, "en-US")).toBe("1.2B");
  });

  it("keeps small and exact values localized and handles missing data", () => {
    expect(formatCompactNumber(9_999, "zh-CN")).toBe("9,999");
    expect(formatInteger(12_345, "zh-CN")).toBe("12,345");
    expect(formatCompactNumber(null, "zh-CN")).toBe("—");
  });
});
