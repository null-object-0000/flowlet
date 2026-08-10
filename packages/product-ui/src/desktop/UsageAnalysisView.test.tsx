import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageAnalysisView, type UsageAnalysisLabels } from "./UsageAnalysisView";

const labels: UsageAnalysisLabels = {
  dimensionTitle: "多维归因",
  dimensionSubtitle: "切换主维度",
  rankObject: "对象",
  rankToken: "Token / 占比",
  rankCost: "预估费用",
  matrixTitle: "交叉归因矩阵",
  matrixSubtitle: "模型 × 渠道账号",
  metricTokens: "Token",
  metricCost: "预估费用",
  selected: "已选中",
  inputOutput: "输入 / 输出",
  outputSpeed: "输出速度",
  cacheHitRate: "缓存命中率",
  heatLow: "少",
  heatHigh: "多",
  emptyCell: "暂无数据",
};

const columns = Array.from({ length: 5 }, (_, index) => ({
  key: `column-${index + 1}`,
  label: `渠道 ${index + 1}`,
  shortLabel: `C${index + 1}`,
}));

const entries = [{
  key: "model-1",
  label: "model-1",
  badge: { letter: "M" },
  tokenValue: "1M",
  tokenShare: "100%",
  costValue: "¥1",
  costShare: "100%",
}];

const rows = [{
  key: "model-1",
  label: "model-1",
  cells: columns.map((_, index) => ({ value: `V${index + 1}`, level: 1 as const })),
}];

describe("UsageAnalysisView compact matrix", () => {
  it("shows at most four columns and places the expansion action in the matrix footer", () => {
    render(
      <UsageAnalysisView
        entries={entries}
        columns={columns}
        rows={rows}
        selectedKey="model-1"
        detail={null}
        labels={labels}
        metric="tokens"
        matrixFooterAction={<button type="button">展开全部 5 项</button>}
      />,
    );

    expect(screen.getByText("C4")).toBeTruthy();
    expect(screen.queryByText("C5")).toBeNull();
    expect(screen.queryByText("V5")).toBeNull();
    const expandAction = screen.getByRole("button", { name: "展开全部 5 项" });
    expect(expandAction).toBeTruthy();
    expect(within(expandAction.parentElement as HTMLElement).getByText("少")).toBeTruthy();
    expect(within(expandAction.parentElement as HTMLElement).getByText("多")).toBeTruthy();
  });

  it("does not show the expansion action when all columns fit", () => {
    render(
      <UsageAnalysisView
        entries={entries}
        columns={columns.slice(0, 4)}
        rows={[{ ...rows[0], cells: rows[0].cells.slice(0, 4) }]}
        selectedKey="model-1"
        detail={null}
        labels={labels}
        metric="tokens"
        matrixFooterAction={<button type="button">展开全部 4 项</button>}
      />,
    );

    expect(screen.getByText("C4")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "展开全部 4 项" })).toBeNull();
  });
});
