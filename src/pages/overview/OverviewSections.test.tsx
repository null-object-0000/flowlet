import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ChannelAccount } from "../../domains/account/types";
import type { RouteCandidate } from "../../domains/model/types";
import type { ChannelPreset } from "../../domains/channel/types";
import { OverviewSections } from "./OverviewSections";

vi.mock("lottie-web", () => ({
  default: {
    loadAnimation: vi.fn(() => ({ destroy: vi.fn() })),
  },
}));

vi.mock("../../features/agent-access/useAgentEnvironment", () => ({
  useClaudeCodeEnvironment: () => ({ data: { installed: false, installations: [] }, isLoading: false, isError: false }),
  useOpenCodeEnvironment: () => ({ data: { installed: false, installations: [] }, isLoading: false, isError: false }),
  useChatGptDesktopEnvironment: () => ({ data: { installed: false, installations: [] }, isLoading: false, isError: false }),
  useCodexAccounts: () => ({ data: undefined, error: null, isFetching: false, refetch: vi.fn() }),
  useClaudeCodeGlobalConfig: () => ({
    query: { data: undefined, error: null, isLoading: false, refetch: vi.fn() },
    apply: { isPending: false, mutateAsync: vi.fn() },
    restore: { isPending: false, mutateAsync: vi.fn() },
  }),
  useOpenCodeGlobalConfig: () => ({
    query: { data: undefined, error: null, isLoading: false, refetch: vi.fn() },
    apply: { isPending: false, mutateAsync: vi.fn() },
    restore: { isPending: false, mutateAsync: vi.fn() },
  }),
}));

describe("OverviewSections", () => {
  it("renders the four independent business modules", () => {
    const account = {
      id: "account-1",
      name: "主账号",
      channel_id: "longcat",
      enabled: true,
      api_key: "configured",
      credential_status: "healthy",
    } as ChannelAccount;
    const route = {
      id: "route-1",
      account_id: account.id,
      virtual_model_id: "LongCat-2.0",
      upstream_model: "LongCat-2.0",
      channel_id: "longcat",
      client_protocol: "openai",
      enabled: true,
    } as RouteCandidate;
    const channel = { id: "longcat", name: "LongCat" } as ChannelPreset;

    render(
      <MemoryRouter>
        <OverviewSections
          accounts={[account]}
          channels={[channel]}
          balanceSnapshots={[]}
          routes={[route]}
          baseUrl="http://127.0.0.1:18640"
          bindConfig={{ host: "127.0.0.1", port: 18640, allow_lan: false, default_client_token: "token" }}
          proxyRunning
          onAccountRequest={vi.fn()}
          onToggleModel={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("共 1 个账号")).toBeInTheDocument();
    expect(screen.getByText("共 1 个模型")).toBeInTheDocument();
    expect(screen.getByText("客户端访问信息")).toBeInTheDocument();
    expect(screen.getByText("AI Agent 接入")).toBeInTheDocument();
  });
});
