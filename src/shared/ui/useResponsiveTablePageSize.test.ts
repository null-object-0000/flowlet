import { describe, expect, it } from "vitest";
import { calculateTablePageSize } from "./useResponsiveTablePageSize";

describe("calculateTablePageSize", () => {
  it("fills the available table body with whole rows", () => {
    expect(calculateTablePageSize(449, 54)).toBe(8);
    expect(calculateTablePageSize(450, 45)).toBe(10);
  });

  it("keeps the result within the supported range", () => {
    expect(calculateTablePageSize(10, 54, 2, 20)).toBe(2);
    expect(calculateTablePageSize(10_000, 54, 1, 20)).toBe(20);
  });
});

