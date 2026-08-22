import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelsServiceDemoView } from "./ModelsServiceDemoView";

describe("ModelsServiceDemoView", () => {
  it("matches the real split workspace and keeps its main interactions live", () => {
    render(<ModelsServiceDemoView zh={false} />);

    expect(screen.getByText("16")).toBeTruthy();
    expect(screen.getByText("2 aggregate · 13 direct")).toBeTruthy();
    const kimiLogo = document.querySelector('img[src="/icons/lobe/kimi-color.svg"]');
    expect(kimiLogo?.parentElement?.tagName).toBe("SPAN");
    expect(screen.getByRole("tab", { name: "Basics" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Context window")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /kimi-k3/i }));
    expect(screen.getByRole("tabpanel").textContent).toContain("Kimi");

    fireEvent.click(screen.getByRole("button", { name: /flowlet-pro/i }));

    fireEvent.click(screen.getByRole("tab", { name: "Pricing" }));
    expect(screen.getByText("$0.28")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Routes" }));
    expect(screen.getByText("DeepSeek · Work account")).toBeTruthy();
    expect(screen.queryByText(/17625895863/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /deepseek-v4-pro/i }));
    expect(screen.getAllByText("deepseek-v4-pro").length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("switch", { name: "Expose deepseek-v4-pro" }));
    expect(screen.getByText("3")).toBeTruthy();
  });
});
