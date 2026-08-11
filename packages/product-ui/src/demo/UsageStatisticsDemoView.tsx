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
  const confidence = createConfidence(zh, 0.994, 0.551, 0.443, 0.006);
  return (
    <DemoPageScaffold
      title={zh ? "用量统计" : "Usage"}
      subtitle={zh ? "按设备和时间查看 Token 使用规模与活跃节奏" : "Review token volume and activity by device and time"}
      controls={<div className={styles.controls}>
        <button type="button" className={styles.device}>{zh ? "全部设备" : "All devices"}<span>⌄</span></button>
        <div className={styles.periods} aria-label={zh ? "统计周期" : "Usage period"}>
          {PERIODS.map((item) => <button key={item} type="button" aria-pressed={period === item} onClick={() => { setPeriod(item); setSelectedKey(`${item}-${item === "month" ? 4 : 14}`); }}>{item === "day" ? (zh ? "日" : "Day") : item === "week" ? (zh ? "周" : "Week") : (zh ? "月" : "Month")}</button>)}
        </div>
        <button type="button" className={styles.range}>‹</button><span className={styles.rangeLabel}>{labels.range}</span><button type="button" className={styles.range} disabled>›</button>
        <span className={styles.live}><i />{zh ? "实时更新中" : "Live"}</span>
        <button type="button" className={styles.refresh} aria-label={zh ? "刷新" : "Refresh"}>↻</button>
      </div>}
    >
      <UsageStatisticsView
        stats={[
          { key: "tokens", label: "Tokens", value: "1.92亿", hint: zh ? "输入 1.54亿 · 输出 3800万" : "154M input · 38M output", expandable: true, title: zh ? "点击查看完整 Token 明细" : "View token details" },
          { key: "requests", label: zh ? "请求量" : "Requests", value: "12,486", hint: zh ? "代理 12,341 · 原生 145" : "12,341 proxy · 145 native" },
          { key: "cache", label: zh ? "缓存输入" : "Cached input", value: "6,284万", hint: zh ? "缓存命中率 40.8%" : "40.8% cache hit", expandable: true, title: zh ? "点击查看完整 Token 明细" : "View token details" },
          { key: "cost", label: zh ? "预估费用" : "Estimated cost", value: "¥726.43", hint: zh ? "Flowlet 可统计用量" : "Flowlet measurable usage" },
        ]}
        confidence={confidence}
        cells={cells}
        period={period}
        metric={metric}
        selectedKey={selected?.key ?? null}
        onMetricChange={setMetric}
        onSelect={setSelectedKey}
        detail={selected ? {
          title: period === "month" ? `2026-08-${selected.label.padStart(2, "0")}` : `${period === "week" ? (zh ? "周五 " : "Fri ") : ""}${selected.label.padStart(2, "0")}:00–${selected.label.padStart(2, "0")}:59`,
          contextLabel: zh ? "指定时间点" : "Selected time",
          metrics: [
            { key: "tokens", label: "Tokens", value: metric === "tokens" ? selected.displayValue : "8.62M", hint: zh ? "输入 6.81M · 输出 1.81M" : "6.81M input · 1.81M output", expandable: true },
            { key: "requests", label: zh ? "请求量" : "Requests", value: "898", hint: zh ? "代理 842 · 原生 56" : "842 proxy · 56 native" },
            { key: "cache", label: zh ? "缓存输入" : "Cached input", value: "3.14M", hint: zh ? "缓存命中率 46.1%" : "46.1% cache hit", expandable: true },
            { key: "cost", label: zh ? "预估费用" : "Estimated cost", value: metric === "cost" ? selected.displayValue : "¥32.18", hint: zh ? "Flowlet 可统计用量" : "Flowlet measurable usage" },
          ],
          confidence: createConfidence(zh, 1, 1, 0, 0),
        } : null}
        labels={{
          statsAria: zh ? "用量汇总" : "Usage summary",
          confidenceTitle: zh ? "当前周期数据可信度" : "Current period confidence",
          confidencePeriod: labels.range,
          chartTitle,
          chartHint: labels.hint,
          metricAria: zh ? "热力图指标" : "Chart metric",
          tokens: "Token",
          cost: zh ? "预估费用" : "Est. cost",
          selectHint: zh ? "点击图表中的时段查看用量明细" : "Select a time range in the chart",
          emptyTitle: zh ? "暂无选定时间数据" : "No selected time data",
          emptyLabel: "Token",
          emptyPeriod: zh ? "当前周期暂无数据" : "No data in this period",
          low: zh ? "少" : "Low",
          high: zh ? "多" : "High",
          weekdayLabels: zh ? ["一", "二", "三", "四", "五", "六", "日"] : ["M", "T", "W", "T", "F", "S", "S"],
          dailyMaxLabel: cells.reduce((best, cell) => cell.value > best.value ? cell : best, cells[0])?.displayValue,
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
      hasData: true,
      adjacent: period === "month" && index < 4,
      weekend: period === "month" && index % 7 >= 5,
    };
  });
}

function createConfidence(zh: boolean, score: number, proxy: number, native: number, unknown: number) {
  const percent = (value: number) => `${(value * 100).toFixed(value === 0 || value === 1 ? 0 : 1)}%`;
  return {
    scoreLabel: percent(score),
    scoreDegrees: score * 360,
    recognizedLabel: zh ? "Token 已识别" : "Tokens identified",
    recognizedHint: zh ? "当前按可统计请求覆盖计算" : "Calculated from measurable request coverage",
    proxyLabel: zh ? "Flowlet 可统计用量" : "Flowlet measurable usage",
    proxyValue: percent(proxy),
    nativeLabel: zh ? "Agent 原生用量" : "Agent native usage",
    nativeValue: percent(native),
    unknownLabel: zh ? "未知 / 待识别" : "Unknown / pending",
    unknownValue: percent(unknown),
    notice: unknown > 0 ? (zh ? "11 次请求暂未识别 Token，可在数据完整性检查中尝试修复。" : "11 requests have unidentified tokens and may be repairable.") : (zh ? "当前范围内所有请求均包含可统计 Token；来源级评分将在同步数据支持后进一步细分。" : "All requests in this range include measurable tokens."),
    noticeActionable: unknown > 0,
    ariaLabel: zh ? `Token 已识别 ${percent(score)}` : `${percent(score)} of tokens identified`,
  };
}
