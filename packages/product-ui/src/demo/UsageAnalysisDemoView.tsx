import { useState } from "react";
import { UsageAnalysisView } from "../desktop/UsageAnalysisView";
import { createUsageAnalysisFixture, type UsageAnalysisDemoDimension } from "./fixtures";
import { DemoPageScaffold, DemoRefreshControl } from "./DemoPageScaffold";

export function UsageAnalysisDemoView({ zh, density = "default" }: { zh: boolean; density?: "default" | "compact" }) {
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [dimension, setDimension] = useState<UsageAnalysisDemoDimension>("model");
  const fixture = createUsageAnalysisFixture(zh, dimension, metric);
  const [selected, setSelected] = useState<string | null>(fixture.entries[0]?.key ?? null);
  const detail = fixture.entries.find((entry) => entry.key === selected) ? fixture.detail : null;
  return <DemoPageScaffold
    title={zh ? "用量洞察" : "Usage insights"}
    subtitle={zh ? "合并 Flowlet 请求与可识别模型的 Agent 原生用量，拆解 Token、费用与性能" : "Combine Flowlet requests and native agent usage across tokens, cost and performance"}
    controls={<DemoRefreshControl zh={zh} range={zh ? "今日 · 8/10" : "Today · Aug 10"} />}
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
