export type NumberLanguage = "zh-CN" | "en-US";

export type NumberFormatOptions = {
  fallback?: string;
  maximumFractionDigits?: number;
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
  const maximumFractionDigits = options.maximumFractionDigits ?? 1;
  const absolute = Math.abs(value);

  if (language === "zh-CN") {
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

function formatScaled(
  value: number,
  divisor: number,
  suffix: string,
  language: NumberLanguage,
  maximumFractionDigits: number,
) {
  const scaled = new Intl.NumberFormat(language, {
    maximumFractionDigits,
    minimumFractionDigits: 0,
    useGrouping: false,
  }).format(value / divisor);
  return `${scaled}${suffix}`;
}
