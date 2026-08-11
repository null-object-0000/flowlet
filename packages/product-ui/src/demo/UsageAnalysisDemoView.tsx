import { useState } from "react";
import { UsageAnalysisView } from "../desktop/UsageAnalysisView";
import { DesktopCalendarRangeControlView, DesktopCalendarRangePanelView, DesktopTimeScopeView } from "../desktop/DesktopControlsView";
import { createUsageAnalysisFixture, type UsageAnalysisDemoDimension } from "./fixtures";
import { DemoPageScaffold, DemoRefreshControl } from "./DemoPageScaffold";

export function UsageAnalysisDemoView({ zh, density = "default" }: { zh: boolean; density?: "default" | "compact" }) {
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [dimension, setDimension] = useState<UsageAnalysisDemoDimension>("model");
  const fixture = createUsageAnalysisFixture(zh, dimension, metric);
  const [selected, setSelected] = useState<string | null>(fixture.entries[0]?.key ?? null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [range, setRange] = useState(zh ? "今日 · 8/10" : "Today · Aug 10");
  const detail = fixture.entries.find((entry) => entry.key === selected) ? fixture.detail : null;
  return <DemoPageScaffold
    title={zh ? "用量洞察" : "Usage insights"}
    subtitle={zh ? "合并 Flowlet 请求与可识别模型的 Agent 原生用量，拆解 Token、费用与性能" : "Combine Flowlet requests and native agent usage across tokens, cost and performance"}
    controls={<DesktopTimeScopeView>
      <DesktopCalendarRangeControlView
        label={range}
        panel={<DesktopCalendarRangePanelView title={zh ? "时间范围" : "Time range"} allLabel={zh ? "全部时间" : "All time"} allSelected={false} quickLabel={zh ? "快捷选择" : "Quick ranges"} presets={[zh ? "今日" : "Today", zh ? "昨日" : "Yesterday", zh ? "本周" : "This week", zh ? "最近 7 天" : "Last 7 days"].map((label, index) => ({ key: String(index), label, selected: range.startsWith(String(label)) }))} onSelectAll={() => { setRange(zh ? "全部时间" : "All time"); setRangeOpen(false); }} onSelect={(key) => { const labels = zh ? ["今日 · 8/10", "昨日 · 8/9", "本周 · 8/4–8/10", "最近 7 天 · 8/4–8/10"] : ["Today · Aug 10", "Yesterday · Aug 9", "This week · Aug 4–10", "Last 7 days · Aug 4–10"]; setRange(labels[Number(key)]); setRangeOpen(false); }} />}
        open={rangeOpen}
        previousLabel={zh ? "上一个时间范围" : "Previous range"}
        nextLabel={zh ? "下一个时间范围" : "Next range"}
        triggerLabel={zh ? "选择时间范围" : "Choose time range"}
        nextDisabled
        onOpenChange={setRangeOpen}
        onPrevious={() => undefined}
        onNext={() => undefined}
      />
      <DemoRefreshControl zh={zh} />
    </DesktopTimeScopeView>}
  >
    <UsageAnalysisView
      entries={fixture.entries}
      columns={fixture.columns}
      rows={fixture.rows}
      selectedKey={selected}
      detail={selected ? detail : null}
      labels={fixture.labels}
      metric={metric}
      dimensions={[
        { key: "model", label: zh ? "按模型" : "By model" },
        { key: "account", label: zh ? "按渠道账号" : "By account" },
        { key: "client", label: zh ? "按客户端" : "By client" },
        { key: "device", label: zh ? "按设备" : "By device" },
      ]}
      selectedDimension={dimension}
      density={density}
      onSelect={(key) => setSelected((current) => current === key ? null : key)}
      onMetricChange={setMetric}
      onDimensionChange={(next) => {
        const nextDimension = next as UsageAnalysisDemoDimension;
        const nextFixture = createUsageAnalysisFixture(zh, nextDimension, metric);
        setDimension(nextDimension);
        setSelected(nextFixture.entries[0]?.key ?? null);
      }}
    />
  </DemoPageScaffold>;
}
