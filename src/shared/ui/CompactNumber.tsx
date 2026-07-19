import type { HTMLAttributes, ReactNode } from "react";
import { formatCompactNumber, formatInteger, type NumberLanguage } from "../formatters/number";

type Props = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  value: number | null | undefined;
  language: NumberLanguage;
  fallback?: string;
  maximumFractionDigits?: number;
  showExactTitle?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
};

export function CompactNumber({
  value,
  language,
  fallback = "—",
  maximumFractionDigits = 1,
  showExactTitle = true,
  prefix,
  suffix,
  title,
  ...spanProps
}: Props) {
  const compact = formatCompactNumber(value, language, { fallback, maximumFractionDigits });
  const exactTitle = value == null ? undefined : formatInteger(value, language, fallback);
  return (
    <span {...spanProps} title={title ?? (showExactTitle && compact !== exactTitle ? exactTitle : undefined)}>
      {prefix}{compact}{suffix}
    </span>
  );
}
