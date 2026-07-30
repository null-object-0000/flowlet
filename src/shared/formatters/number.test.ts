import { describe, expect, it } from "vitest";
import { formatCompactNumber, formatInteger, formatTokenCapacity } from "./number";

describe("shared number formatters", () => {
  it("uses Chinese 万、亿 and 万亿 units with 2 decimals", () => {
    expect(formatCompactNumber(12_345, "zh-CN")).toBe("1.23万");
    expect(formatCompactNumber(43_987_000, "zh-CN")).toBe("4398.70万");
    expect(formatCompactNumber(120_000_000, "zh-CN")).toBe("1.20亿");
    expect(formatCompactNumber(1_200_000_000_000, "zh-CN")).toBe("1.20万亿");
  });

  it("uses English K, M, B and T units with 2 decimals", () => {
    expect(formatCompactNumber(1_200, "en-US")).toBe("1.20K");
    expect(formatCompactNumber(1_200_000, "en-US")).toBe("1.20M");
    expect(formatCompactNumber(1_200_000_000, "en-US")).toBe("1.20B");
  });

  it("keeps small and exact values localized and handles missing data", () => {
    expect(formatCompactNumber(9_999, "zh-CN")).toBe("9,999");
    expect(formatInteger(12_345, "zh-CN")).toBe("12,345");
    expect(formatCompactNumber(null, "zh-CN")).toBe("—");
  });

  it("formats model token capacities with conventional K and M units", () => {
    expect(formatTokenCapacity(65_536, "zh-CN")).toBe("64K");
    expect(formatTokenCapacity(128_000, "zh-CN")).toBe("128K");
    expect(formatTokenCapacity(131_072, "zh-CN")).toBe("128K");
    expect(formatTokenCapacity(1_000_000, "zh-CN")).toBe("1M");
    expect(formatTokenCapacity(1_048_576, "zh-CN")).toBe("1M");
    expect(formatTokenCapacity(1_500_000, "en-US")).toBe("1.5M");
    expect(formatTokenCapacity(null, "zh-CN")).toBe("—");
  });
});
