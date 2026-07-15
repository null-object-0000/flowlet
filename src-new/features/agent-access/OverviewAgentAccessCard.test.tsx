import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OverviewAgentAccessCard } from "./OverviewAgentAccessCard";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

describe("OverviewAgentAccessCard", () => {
  it("opens Claude Code instructions and copies the complete configuration", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    render(
      <OverviewAgentAccessCard
        baseUrl="http://127.0.0.1:18640"
        clientToken="flowlet-local-token"
      />,
    );

    expect(screen.getByRole("button", { name: "配置 Claude Code CLI" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "配置 OpenCode CLI" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "配置 Claude Code CLI" }));
    expect(await screen.findByText("Claude Code CLI 接入")).toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:18640/anthropic")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "复制完整配置" }));
    expect(writeText).toHaveBeenCalledWith(
      "export ANTHROPIC_BASE_URL=http://127.0.0.1:18640/anthropic\n" +
        "export ANTHROPIC_AUTH_TOKEN=flowlet-local-token",
    );
    expect(await screen.findByText("Claude Code CLI 完整配置已复制")).toBeInTheDocument();
  });

  it("opens OpenCode instructions and explains a missing client token", async () => {
    const user = userEvent.setup();
    render(<OverviewAgentAccessCard baseUrl="http://127.0.0.1:18640" />);

    await user.click(screen.getByRole("button", { name: "配置 OpenCode CLI" }));

    expect(await screen.findByText("OpenCode CLI 接入")).toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:18640/v1")).toBeInTheDocument();
    expect(screen.getAllByText("<Client Token>").length).toBeGreaterThan(0);
    expect(screen.getByText("当前未配置默认 Client Token，请先在客户端设置中完成配置。")).toBeInTheDocument();
  });
});
