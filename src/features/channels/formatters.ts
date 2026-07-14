/** ISO/RFC3339 字符串转换为本地化日期时间（与前端展示风格一致）。 */
export function formatIsoDateTime(value?: string | null): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

export function formatAmount(value: number | null | undefined, fallback = "-"): string {
  if (value == null) return fallback;
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function formatTokenCount(value?: number | null): string {
  if (value == null) return "-";
  return value.toLocaleString();
}
