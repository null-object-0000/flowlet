import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OverviewAgentAccessCard } from "./OverviewAgentAccessCard";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

describe("OverviewAgentAccessCard", () => {
  it("marks every listed agent as coming soon and disables interaction", () => {
    render(<OverviewAgentAccessCard />);

    const buttons = [
      screen.getByRole("button", { name: "Claude Code CLI 即将支持" }),
      screen.getByRole("button", { name: "OpenCode CLI 即将支持" }),
      screen.getByRole("button", { name: "Codex Desktop 即将支持" }),
    ];
    buttons.forEach((button) => expect(button).toBeDisabled());
    expect(screen.getAllByText("即将支持")).toHaveLength(3);
  });
});
