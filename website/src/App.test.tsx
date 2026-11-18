import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { projectLinks } from "./projectLinks";

function CurrentLocation() {
  const { pathname, hash } = useLocation();
  return <output aria-label="Current location">{pathname}{hash}</output>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Flowlet landing page", () => {
  it("keeps the demo link on language detection and language switch", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("en-US");
    render(<MemoryRouter initialEntries={["/#demo"]}><App /><CurrentLocation /></MemoryRouter>);
    expect(screen.getByLabelText("Current location")).toHaveTextContent("/en#demo");
    expect(screen.getByRole("heading", { name: "Start with a failed request." })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Switch to Chinese" }));
    expect(screen.getByLabelText("Current location")).toHaveTextContent("/zh#demo");
    expect(screen.getByRole("heading", { name: "先看一次请求是怎么失败的。" })).toBeInTheDocument();
  });

  it.each([
    ["en", "Download desktop", "Self-host with Docker", "Product demo", "Failed", /429 · Rate limited/],
    ["zh", "下载桌面版", "自托管 Web / Docker", "产品演示", "失败", /429 · 请求限流/],
  ] as const)("links both install paths and filters sample failures in %s", (lang, download, docker, demoLink, failureLabel, error) => {
    render(<MemoryRouter initialEntries={[`/${lang}`]}><App /></MemoryRouter>);
    const main = within(screen.getByRole("main"));
    expect(main.getAllByRole("link", { name: download })[0]).toHaveAttribute("href", projectLinks.releases);
    expect(main.getAllByRole("link", { name: docker })[0]).toHaveAttribute("href", projectLinks.docker);
    expect(screen.getByRole("link", { name: demoLink })).toHaveAttribute("href", "#demo");

    const demo = within(screen.getByRole("region", { name: lang === "zh" ? "先看一次请求是怎么失败的。" : "Start with a failed request." }));
    expect(demo.getByText("qwen3.8-max")).toBeInTheDocument();
    fireEvent.click(demo.getByRole("button", { name: failureLabel }));
    expect(demo.getByText(error)).toBeInTheDocument();
    expect(demo.queryByText("qwen3.8-max")).not.toBeInTheDocument();
  });
});
