import { useCallback, useLayoutEffect, useState, type RefCallback } from "react";

type ResponsiveTablePageSizeOptions = {
  rowHeight: number;
  initialPageSize?: number;
  minPageSize?: number;
  maxPageSize?: number;
};

export function calculateTablePageSize(
  availableHeight: number,
  rowHeight: number,
  minPageSize = 1,
  maxPageSize = 50,
) {
  if (!Number.isFinite(availableHeight) || availableHeight <= 0 || !Number.isFinite(rowHeight) || rowHeight <= 0) {
    return minPageSize;
  }
  return Math.max(minPageSize, Math.min(maxPageSize, Math.floor(availableHeight / rowHeight)));
}

export function useResponsiveTablePageSize({
  rowHeight,
  initialPageSize = 8,
  minPageSize = 1,
  maxPageSize = 50,
}: ResponsiveTablePageSizeOptions): {
  bodyRef: RefCallback<HTMLDivElement>;
  pageSize: number;
} {
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const bodyRef = useCallback((node: HTMLDivElement | null) => setBody(node), []);

  useLayoutEffect(() => {
    if (!body) return;

    const update = (height: number) => {
      // A minimized/temporarily hidden window reports zero; keep the last useful size.
      if (height <= 0) return;
      const nextPageSize = calculateTablePageSize(height, rowHeight, minPageSize, maxPageSize);
      setPageSize((current) => current === nextPageSize ? current : nextPageSize);
    };
    update(body.clientHeight);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.height);
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [body, maxPageSize, minPageSize, rowHeight]);

  return { bodyRef, pageSize };
}
