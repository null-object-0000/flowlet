import { describe, expect, it } from "vitest";
import { createHeatLevelScale } from "./heatmapLevels";

describe("createHeatLevelScale", () => {
  it("uses the visible positive-value distribution instead of a fixed max ratio", () => {
    const scale = createHeatLevelScale([10, 20, 30, 40, 1_000_000]);
    expect(scale.thresholds).toEqual([20, 30, 40]);
    expect([0, 10, 20, 30, 40, 1_000_000].map(scale.levelFor))
      .toEqual([0, 1, 1, 2, 3, 4]);
  });

  it("keeps equal non-zero values visually active and maps invalid values to zero", () => {
    const scale = createHeatLevelScale([100, 100, 100]);
    expect(scale.levelFor(100)).toBe(4);
    expect(scale.levelFor(0)).toBe(0);
    expect(scale.levelFor(Number.NaN)).toBe(0);
  });

  it("returns an empty scale when the visible period has no usage", () => {
    const scale = createHeatLevelScale([0, -1, Number.POSITIVE_INFINITY]);
    expect(scale.thresholds).toEqual([0, 0, 0]);
    expect(scale.levelFor(10)).toBe(0);
  });
});
