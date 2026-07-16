import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProxyStatusCard } from "./ProxyStatusCard";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

describe("ProxyStatusCard", () => {
  it("presents the primary service information and keeps restart actionable", async () => {
    const onAction = vi.fn();
    render(
      <ProxyStatusCard
        status={{ running: true, bind_addr: "127.0.0.1:18640", started_at: "2026-07-15T00:00:00.000Z" }}
        bindConfig={{ host: "127.0.0.1", port: 18640, allow_lan: false }}
        phase="running"
        autoStartAttempted
        configurationStatus="ready"
        actionLabel="重启服务"
        actionBusy={false}
        actionDisabled={false}
        onAction={onAction}
      />,
    );

    expect(screen.getByText("服务运行正常")).toBeInTheDocument();
    expect(screen.getByText("本地代理正在监听请求")).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:18640")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重启服务" }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});
