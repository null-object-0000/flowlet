import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DesktopOverviewDemoView } from "./DesktopOverviewDemoView";

describe("DesktopOverviewDemoView", () => {
  it("matches the real overview account and Agent row structure", () => {
    render(<DesktopOverviewDemoView zh={false} />);

    expect(screen.getByText("7 of 11 enabled")).toBeTruthy();
    expect(screen.getByText("DeepSeek · 工作账号")).toBeTruthy();
    expect(screen.getByText("demo@flowlet.local")).toBeTruthy();
    expect(screen.queryByText(/nichangen@/)).toBeNull();
    expect(screen.queryByText(/17625895863/)).toBeNull();
    expect(screen.queryByText("DeepSeek · 备用账号")).toBeNull();
    expect(screen.getByRole("button", { name: "Configure Codex" })).toBeTruthy();
    expect(screen.getAllByText("Desktop")).toHaveLength(2);
    expect(screen.getByText("26.803.5235.0")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Show disabled" }));
    expect(screen.getByText("DeepSeek · 备用账号")).toBeTruthy();
    expect(screen.getAllByText("Disabled")).toHaveLength(4);
  });
});
