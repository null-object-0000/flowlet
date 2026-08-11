import { DesktopRefreshControlView } from "@flowlet/product-ui";
import { formatTime } from "../formatters/datetime";

type Translate = (source: string, variables?: Record<string, string | number>) => string;

export function RefreshControl({ autoRefresh, onToggleAutoRefresh, isFetching, lastUpdatedAt, intervalMs, onRefresh, language, t }: {
  autoRefresh: boolean;
  onToggleAutoRefresh: () => void;
  isFetching: boolean;
  lastUpdatedAt: number | undefined;
  intervalMs: number;
  onRefresh: () => void;
  language: "zh-CN" | "en-US";
  t: Translate;
}) {
  const lastLabel = lastUpdatedAt ? formatTime(new Date(lastUpdatedAt).toISOString(), language) : "—";
  const nextLabel = autoRefresh && lastUpdatedAt ? formatTime(new Date(lastUpdatedAt + intervalMs).toISOString(), language) : undefined;
  return <DesktopRefreshControlView
    autoRefresh={autoRefresh}
    isFetching={isFetching}
    liveLabel={t("实时更新中")}
    pausedLabel={t("实时更新已暂停")}
    refreshLabel={t("刷新数据")}
    timingLabel={<>{t("上次 {time}", { time: lastLabel })}{nextLabel ? ` · ${t("下次 {time}", { time: nextLabel })}` : ""}</>}
    onToggleAutoRefresh={onToggleAutoRefresh}
    onRefresh={onRefresh}
  />;
}
