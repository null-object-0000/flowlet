import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentGatewayAccess } from "./AgentGatewayAccess";
import { proxyCommands } from "../../domains/proxy/commands";
import { copyText } from "../../shared/ui/copyText";
import type { A2aAgent } from "../../domains/a2a/types";
vi.mock("../../domains/proxy/commands", () => ({
  proxyCommands: {
    bindConfig: vi.fn(async () => ({
      default_client_token: "test-shared-client-token",
    })),
  },
}));
vi.mock("../../shared/ui/copyText", () => ({
  copyText: vi.fn(async () => {}),
}));
const agent = {
  id: "test",
  name: "Test Agent",
  gatewayPath: "/a2a/test",
} as A2aAgent;
describe("Shared Client Token access", () => {
  it("masks by default, fills copied config on demand, and clears revealed text on close", async () => {
    const view = render(
      <AgentGatewayAccess
        agent={agent}
        origin="https://host.example"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("••••••••••••••••")).toBeInTheDocument();
    expect(
      screen.queryByText("test-shared-client-token"),
    ).not.toBeInTheDocument();
    expect(proxyCommands.bindConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "复制完整 ACP 配置" }));
    await waitFor(() => expect(copyText).toHaveBeenCalled());
    const value = JSON.parse(vi.mocked(copyText).mock.calls[0][0]);
    expect(Object.values(value.env)).toContain("test-shared-client-token");
    expect(value.args).toContain("--ignore-client-mcp");
    fireEvent.click(screen.getByRole("button", { name: "查看 Token" }));
    expect(
      await screen.findByText("test-shared-client-token"),
    ).toBeInTheDocument();
    view.rerender(
      <AgentGatewayAccess
        agent={null}
        origin="https://host.example"
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByText("test-shared-client-token"),
      ).not.toBeInTheDocument(),
    );
  });
});
