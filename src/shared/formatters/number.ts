export type NumberLanguage = "zh-CN" | "en-US";

/** Token 展示单位：`auto` 跟随界面语言（中文用万/亿，英文用 K/M），
 *  `zh` / `en` 强制使用对应单位体系。 */
export type TokenUnit = "auto" | "zh" | "en";

/** 当前全局生效的 Token 展示单位。由 AppPreferences 在读取/切换偏好时同步，
 *  缺省为 `auto`（跟随界面语言）。纯格式化调用仍可显式传 `unit` 覆盖。 */
let activeTokenUnit: TokenUnit = "auto";

export function setActiveTokenUnit(unit: TokenUnit) {
  activeTokenUnit = unit;
}

export function getActiveTokenUnit(): TokenUnit {
  return activeTokenUnit;
}

export type NumberFormatOptions = {
  fallback?: string;
  maximumFractionDigits?: number;
  /** Token 展示单位；缺省时使用全局 activeTokenUnit（默认跟随语言）。 */
  unit?: TokenUnit;
};

export function formatInteger(
  value: number | null | undefined,
  language: NumberLanguage,
  fallback = "—",
) {
  if (value == null || !Number.isFinite(value)) return fallback;
  return new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(value);
}

export function formatCompactNumber(
  value: number | null | undefined,
  language: NumberLanguage,
  options: NumberFormatOptions = {},
) {
  const fallback = options.fallback ?? "—";
  if (value == null || !Number.isFinite(value)) return fallback;
  const maximumFractionDigits = options.maximumFractionDigits ?? 2;
  const unit = resolveTokenUnit(options.unit ?? activeTokenUnit, language);
  const absolute = Math.abs(value);

  if (unit === "zh") {
    if (absolute >= 1_000_000_000_000) return formatScaled(value, 1_000_000_000_000, "万亿", language, maximumFractionDigits);
    if (absolute >= 100_000_000) return formatScaled(value, 100_000_000, "亿", language, maximumFractionDigits);
    if (absolute >= 10_000) return formatScaled(value, 10_000, "万", language, maximumFractionDigits);
    return formatInteger(value, language, fallback);
  }

  if (absolute >= 1_000_000_000_000) return formatScaled(value, 1_000_000_000_000, "T", language, maximumFractionDigits);
  if (absolute >= 1_000_000_000) return formatScaled(value, 1_000_000_000, "B", language, maximumFractionDigits);
  if (absolute >= 1_000_000) return formatScaled(value, 1_000_000, "M", language, maximumFractionDigits);
  if (absolute >= 1_000) return formatScaled(value, 1_000, "K", language, maximumFractionDigits);
  return formatInteger(value, language, fallback);
}

function resolveTokenUnit(unit: TokenUnit, language: NumberLanguage): "zh" | "en" {
  if (unit === "zh" || unit === "en") return unit;
  return language === "zh-CN" ? "zh" : "en";
}

/**
 * Formats model token capacities using the conventional K/M notation.
 * Catalog sources may encode advertised capacities using either decimal
 * (128_000) or binary-aligned (131_072) values, so prefer an exact unit in
 * either system before falling back to decimal scaling.
 */
export function formatTokenCapacity(
  value: number | null | undefined,
  language: NumberLanguage,
  fallback = "—",
) {
  if (value == null || !Number.isFinite(value)) return fallback;
  const absolute = Math.abs(value);

  if (absolute >= 1_000_000) {
    const divisor = absolute % 1_000_000 === 0 || absolute % 1_048_576 !== 0
      ? 1_000_000
      : 1_048_576;
    return formatCapacityScaled(value, divisor, "M", language);
  }

  if (absolute >= 1_000) {
    const divisor = absolute % 1_000 === 0 || absolute % 1_024 !== 0
      ? 1_000
      : 1_024;
    return formatCapacityScaled(value, divisor, "K", language);
  }

  return formatInteger(value, language, fallback);
}

function formatScaled(
  value: number,
  divisor: number,
  suffix: string,
  language: NumberLanguage,
  maximumFractionDigits: number,
) {
  const scaled = new Intl.NumberFormat(language, {
    maximumFractionDigits,
    minimumFractionDigits: maximumFractionDigits,
    useGrouping: false,
  }).format(value / divisor);
  return `${scaled}${suffix}`;
}

function formatCapacityScaled(
  value: number,
  divisor: number,
  suffix: string,
  language: NumberLanguage,
) {
  const scaled = new Intl.NumberFormat(language, {
    maximumFractionDigits: 2,
    useGrouping: false,
  }).format(value / divisor);
  return `${scaled}${suffix}`;
}
