import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

import { OverviewServiceStrip } from "./OverviewServiceStrip";

describe("OverviewServiceStrip", () => {
  it("keeps client access and token visible before an account is configured", () => {
    render(
      <OverviewServiceStrip
        status={{ running: true, bind_addr: "127.0.0.1:18640", started_at: "2026-07-29T00:00:00Z" }}
        phase="running"
        bindConfig={{ host: "127.0.0.1", port: 18640, allow_lan: false, default_client_token: "client-token" }}
        baseUrl="http://127.0.0.1:18640"
        todayUsage={null}
        onOpenUsage={vi.fn()}
        onOpenDetails={vi.fn()}
      />,
    );

    expect(screen.getByText("客户端接入")).toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:18640/v1")).toBeInTheDocument();
    expect(screen.getByText("客户端 Token")).toBeInTheDocument();
    expect(screen.getByText("••••••••••••••••")).toBeInTheDocument();
  });

  it("does not expose a redundant Responses protocol option in the overview", () => {
    render(
      <OverviewServiceStrip
        status={{ running: true, bind_addr: "127.0.0.1:18640", started_at: "2026-07-29T00:00:00Z" }}
        phase="running"
        bindConfig={{ host: "127.0.0.1", port: 18640, allow_lan: false, default_client_token: "client-token" }}
        baseUrl="http://127.0.0.1:18640"
        todayUsage={null}
        onOpenUsage={vi.fn()}
        onOpenDetails={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "OpenAI" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anthropic" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Responses" })).not.toBeInTheDocument();
  });

  it("opens usage statistics when today's consumption is clicked", () => {
    const onOpenUsage = vi.fn();
    render(
      <OverviewServiceStrip
        status={{ running: true, bind_addr: "127.0.0.1:18640", started_at: "2026-07-29T00:00:00Z" }}
        phase="running"
        bindConfig={{ host: "127.0.0.1", port: 18640, allow_lan: false, default_client_token: "client-token" }}
        baseUrl="http://127.0.0.1:18640"
        todayUsage={{ total_tokens: 123, input_tokens: 100, input_cached_tokens: 20, input_uncached_tokens: 80, cache_measured_input_tokens: 100, output_tokens: 23 }}
        onOpenUsage={onOpenUsage}
        onOpenDetails={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "今日消耗，打开用量统计" }));
    expect(onOpenUsage).toHaveBeenCalledOnce();
  });
});
