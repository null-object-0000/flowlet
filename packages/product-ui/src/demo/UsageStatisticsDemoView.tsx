import { useMemo, useState } from "react";
import { UsageStatisticsView, type UsageStatisticsCellModel, type UsageStatisticsMetric, type UsageStatisticsPeriod } from "../desktop/UsageStatisticsView";
import { DemoPageScaffold } from "./DemoPageScaffold";
import styles from "./UsageStatisticsDemoView.module.css";

const PERIODS: UsageStatisticsPeriod[] = ["day", "week", "month"];

export function UsageStatisticsDemoView({ zh }: { zh: boolean }) {
  const [period, setPeriod] = useState<UsageStatisticsPeriod>("day");
  const [metric, setMetric] = useState<UsageStatisticsMetric>("tokens");
  const cells = useMemo(() => createCells(period, metric), [period, metric]);
  const [selectedKey, setSelectedKey] = useState<string | null>("day-14");
  const selected = cells.find((cell) => cell.key === selectedKey) ?? null;
  const labels = period === "day"
    ? { title: zh ? "24 小时 Token 柱状图" : "24-hour token chart", hint: zh ? "横轴为小时，点击柱查看对应时段" : "Click a bar to inspect that hour", range: zh ? "今日 · 8/10" : "Today · Aug 10" }
    : period === "week"
      ? { title: zh ? "星期 × 小时 Token 热力图" : "Weekday × hour heatmap", hint: zh ? "纵轴为星期、横轴为小时，点击查看对应时段" : "Click a cell to inspect that hour", range: zh ? "本周 · 8/4–8/10" : "This week · Aug 4–10" }
      : { title: zh ? "每日 Token 热力图" : "Daily token heatmap", hint: zh ? "点击日期查看当天汇总" : "Click a date to inspect its totals", range: zh ? "本月 · 2026/08" : "This month · Aug 2026" };
  const chartTitle = metric === "tokens" ? labels.title : zh
    ? labels.title.replace(" Token ", "预估费用")
    : labels.title.replace("token", "estimated cost");
  return (
    <DemoPageScaffold
      title={zh ? "用量统计" : "Usage"}
      subtitle={zh ? "按设备和时间查看 Token 使用规模与活跃节奏" : "Review token volume and activity by device and time"}
      controls={<div className={styles.controls}>
        <button type="button" className={styles.device}>{zh ? "全部设备" : "All devices"}<span>⌄</span></button>
        <div className={styles.periods} aria-label={zh ? "统计周期" : "Usage period"}>
          {PERIODS.map((item) => <button key={item} type="button" aria-pressed={period === item} onClick={() => { setPeriod(item); setSelectedKey(null); }}>{item === "day" ? (zh ? "日" : "Day") : item === "week" ? (zh ? "周" : "Week") : (zh ? "月" : "Month")}</button>)}
        </div>
        <button type="button" className={styles.range}>‹</button><span className={styles.rangeLabel}>{labels.range}</span><button type="button" className={styles.range} disabled>›</button>
        <span className={styles.live}><i />{zh ? "实时更新中" : "Live"}</span>
        <button type="button" className={styles.refresh} aria-label={zh ? "刷新" : "Refresh"}>↻</button>
      </div>}
    >
      <UsageStatisticsView
        stats={[
          { key: "tokens", label: "Tokens", value: "1.92亿", hint: zh ? "输入 1.54亿 · 输出 3800万" : "154M input · 38M output" },
          { key: "requests", label: zh ? "请求量" : "Requests", value: "12,486", hint: zh ? "代理 12,341 · 原生 145" : "12,341 proxy · 145 native" },
          { key: "cache", label: zh ? "缓存输入" : "Cached input", value: "6,284万", hint: zh ? "缓存命中率 40.8%" : "40.8% cache hit" },
          { key: "cost", label: zh ? "预估费用" : "Estimated cost", value: "¥726.43", hint: zh ? "Flowlet 可统计用量" : "Flowlet measurable usage" },
        ]}
        cells={cells}
        period={period}
        metric={metric}
        selectedKey={selected?.key ?? null}
        onMetricChange={setMetric}
        onSelect={setSelectedKey}
        detail={selected ? {
          title: period === "month" ? `2026-08-${selected.label.padStart(2, "0")}` : `${period === "week" ? (zh ? "周五 " : "Fri ") : ""}${selected.label.padStart(2, "0")}:00–${selected.label.padStart(2, "0")}:59`,
          tokenValue: metric === "tokens" ? selected.displayValue : "8.62M",
          requestValue: "898",
          cacheValue: "3.14M",
          costValue: metric === "cost" ? selected.displayValue : "¥32.18",
          sourceHint: zh ? "全部设备 · 聚合用量" : "All devices · Combined usage",
        } : null}
        labels={{
          confidenceTitle: zh ? "当前周期数据可信度" : "Current period confidence",
          confidenceValue: "94.2%",
          confidenceHint: zh ? "绝大部分请求已识别 Token，少量原生事件仅包含聚合用量。" : "Most requests have identified tokens; a few native events are aggregate-only.",
          chartTitle,
          chartHint: labels.hint,
          tokens: "Token",
          cost: zh ? "预估费用" : "Est. cost",
          selected: zh ? "已选中" : "Selected",
          selectHint: zh ? "点击图表中的时段查看用量明细" : "Select a time range in the chart",
          requests: zh ? "请求量" : "Requests",
          cacheInput: zh ? "缓存输入" : "Cached input",
          estimatedCost: zh ? "预估费用" : "Est. cost",
          low: zh ? "少" : "Low",
          high: zh ? "多" : "High",
        }}
      />
    </DemoPageScaffold>
  );
}

function createCells(period: UsageStatisticsPeriod, metric: UsageStatisticsMetric): UsageStatisticsCellModel[] {
  const count = period === "day" ? 24 : period === "week" ? 168 : 42;
  return Array.from({ length: count }, (_, index) => {
    const raw = ((index * 37 + index * index * 11 + 23) % 91) + 9;
    const level = Math.min(4, Math.floor(raw / 21)) as 0 | 1 | 2 | 3 | 4;
    const label = period === "month" ? String(index < 4 ? 28 + index : ((index - 4) % 31) + 1) : String(index % 24).padStart(2, "0");
    const value = metric === "tokens" ? raw * 112000 : raw * 0.34;
    return {
      key: `${period}-${index}`,
      label,
      value,
      level,
      displayValue: metric === "tokens" ? `${(value / 1_000_000).toFixed(2)}M` : `¥${value.toFixed(2)}`,
      disabled: period === "month" && index > 34,
    };
  });
}
