import { useState } from "react";
import { UsageAnalysisView } from "../desktop/UsageAnalysisView";
import { createUsageAnalysisFixture } from "./fixtures";

export function UsageAnalysisDemoView({ zh, density = "default" }: { zh: boolean; density?: "default" | "compact" }) {
  const fixture = createUsageAnalysisFixture(zh);
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [selected, setSelected] = useState<string | null>("flowlet-pro");
  const detail = fixture.entries.find((entry) => entry.key === selected) ? fixture.detail : null;
  return (
    <UsageAnalysisView
      entries={fixture.entries}
      columns={fixture.columns}
      rows={fixture.rows}
      selectedKey={selected}
      detail={selected ? detail : null}
      labels={fixture.labels}
      metric={metric}
      density={density}
      onSelect={(key) => setSelected((current) => current === key ? null : key)}
    />
  );
}
