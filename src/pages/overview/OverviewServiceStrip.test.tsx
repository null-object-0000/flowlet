import { render, screen } from "@testing-library/react";
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
        onOpenDetails={vi.fn()}
      />,
    );

    expect(screen.getByText("客户端接入")).toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:18640/v1")).toBeInTheDocument();
    expect(screen.getByText("客户端 Token")).toBeInTheDocument();
    expect(screen.getByText("••••••••••••••••")).toBeInTheDocument();
  });
});
