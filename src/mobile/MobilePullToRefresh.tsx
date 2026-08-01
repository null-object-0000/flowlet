import { IconRefresh } from "@douyinfe/semi-icons";
import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import styles from "./MobilePullToRefresh.module.css";

const REFRESH_THRESHOLD = 56;
const MAX_PULL = 88;

export function MobilePullToRefresh({
  children,
  disabled = false,
  refreshing,
  onRefresh,
}: {
  children: ReactNode;
  disabled?: boolean;
  refreshing: boolean;
  onRefresh: () => Promise<unknown>;
}) {
  const { t } = useAppPreferences();
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [dragging, setDragging] = useState(false);

  const reset = () => {
    startY.current = null;
    setDragging(false);
    setPull(refreshing ? 40 : 0);
  };

  return (
    <div
      className={styles.root}
      style={{ "--mobile-pull-distance": `${refreshing ? Math.max(pull, 40) : pull}px` } as CSSProperties}
      data-dragging={dragging || undefined}
      data-pulling={(pull > 0 || refreshing) || undefined}
      data-refreshing={refreshing || undefined}
      onTouchStart={(event) => {
        if (disabled || refreshing || window.scrollY > 0) return;
        startY.current = event.touches[0]?.clientY ?? null;
        setDragging(startY.current != null);
      }}
      onTouchMove={(event) => {
        if (startY.current == null || window.scrollY > 0) return;
        const distance = Math.max(0, (event.touches[0]?.clientY ?? startY.current) - startY.current);
        setPull(Math.min(MAX_PULL, distance * 0.52));
      }}
      onTouchCancel={reset}
      onTouchEnd={() => {
        const shouldRefresh = pull >= REFRESH_THRESHOLD && !disabled && !refreshing;
        reset();
        if (shouldRefresh) void onRefresh().finally(() => setPull(0));
      }}
    >
      <div className={styles.indicator} aria-live="polite">
        <IconRefresh spin={refreshing} />
        <span>{refreshing ? t("正在刷新远端数据…") : pull >= REFRESH_THRESHOLD ? t("松开刷新") : t("下拉刷新")}</span>
      </div>
      <div className={styles.content}>{children}</div>
    </div>
  );
}
