import type { HTMLAttributes, ReactNode } from "react";
import { formatCompactNumber, formatInteger, type NumberLanguage, type TokenUnit } from "../formatters/number";

type Props = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  value: number | null | undefined;
  language: NumberLanguage;
  unit?: TokenUnit;
  fallback?: string;
  maximumFractionDigits?: number;
  showExactTitle?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
};

export function CompactNumber({
  value,
  language,
  unit,
  fallback = "—",
  maximumFractionDigits = 2,
  showExactTitle = true,
  prefix,
  suffix,
  title,
  ...spanProps
}: Props) {
  const compact = formatCompactNumber(value, language, { fallback, maximumFractionDigits, unit });
  const exactTitle = value == null ? undefined : formatInteger(value, language, fallback);
  return (
    <span {...spanProps} title={title ?? (showExactTitle && compact !== exactTitle ? exactTitle : undefined)}>
      {prefix}{compact}{suffix}
    </span>
  );
}
