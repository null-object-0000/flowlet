export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export type HeatLevelScale = {
  thresholds: readonly [number, number, number];
  levelFor: (value: number) => HeatLevel;
};

/**
 * 按当前可见周期内的正值分布计算四档颜色，而不是按固定 Token 阈值或
 * 单个最大值的固定比例切分。四分位数使用线性插值；0 始终为 level 0，
 * 当前周期最大值始终为 level 4。
 */
export function createHeatLevelScale(values: number[]): HeatLevelScale {
  const positive = values
    .map(finiteNonNegative)
    .filter((value) => value > 0)
    .sort((left, right) => left - right);

  if (positive.length === 0) {
    return { thresholds: [0, 0, 0], levelFor: () => 0 };
  }

  const thresholds = [
    quantile(positive, 0.25),
    quantile(positive, 0.5),
    quantile(positive, 0.75),
  ] as const;
  const max = positive[positive.length - 1];

  return {
    thresholds,
    levelFor: (rawValue): HeatLevel => {
      const value = finiteNonNegative(rawValue);
      if (value <= 0) return 0;
      if (value >= max) return 4;
      if (value <= thresholds[0]) return 1;
      if (value <= thresholds[1]) return 2;
      if (value <= thresholds[2]) return 3;
      return 4;
    },
  };
}

function quantile(sorted: number[], percentile: number) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * percentile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  return lower + (upper - lower) * (position - lowerIndex);
}

function finiteNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
