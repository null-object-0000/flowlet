import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AccountBalanceSnapshot } from "../../domains/account/types";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";
import type { ProxyBindConfig } from "../../domains/proxy/types";
import { OverviewGrid } from "./OverviewGrid";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

vi.mock("../../features/agent-access/useAgentEnvironment", () => ({
  useClaudeCodeEnvironment: () => ({ data: { installed: false, installations: [] }, isLoading: false, isError: false }),
  useOpenCodeEnvironment: () => ({ data: { installed: false, installations: [] }, isLoading: false, isError: false }),
  usePiEnvironment: () => ({ data: { installed: false, installations: [] }, isLoading: false, isError: false }),
  useChatGptDesktopEnvironment: () => ({ data: { installed: false, installations: [] }, isLoading: false, isError: false }),
  useCodexAccounts: () => ({ data: undefined, error: null, isFetching: false, refetch: vi.fn() }),
  useCodexAccountRefresh: () => ({ isPending: false, error: null, mutate: vi.fn() }),
  useCodexAccountAuthorization: () => ({ isPending: false, mutateAsync: vi.fn() }),
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
  usePiGlobalConfig: () => ({
    query: { data: undefined, error: null, isLoading: false, refetch: vi.fn() },
    apply: { isPending: false, mutateAsync: vi.fn() },
    restore: { isPending: false, mutateAsync: vi.fn() },
  }),
}));

function makeAccount(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: "acc-1",
    channel_id: "longcat",
    name: "test-account",
    api_key: "sk-test",
    enabled: true,
    priority: 1,
    remark: null,
    resource_mode: "pay_as_you_go",
    resource_sync_mode: "auto",
    base_url_override: null,
    anthropic_base_url_override: null,
    last_used_at: null,
    last_error: null,
    credential_status: "healthy",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeRoute(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    id: "route-1",
    virtual_model_id: "flowlet-pro",
    channel_id: "longcat",
    account_id: "acc-1",
    upstream_model: "flowlet-pro",
    client_protocol: "openai",
    priority: 1,
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("OverviewGrid", () => {
  const channels: ChannelPreset[] = [];
  const snapshots: AccountBalanceSnapshot[] = [];
  const bindConfig: ProxyBindConfig = { host: "127.0.0.1", port: 18640, allow_lan: false, default_client_token: "sk-demo" };
  const onboarding = <div>onboarding-placeholder</div>;

  it("renders the three business modules when accounts exist", () => {
    render(
      <MemoryRouter>
        <OverviewGrid
          accounts={[makeAccount()]}
          channels={channels}
          balanceSnapshots={snapshots}
          routes={[makeRoute()]}
          baseUrl="http://127.0.0.1:18640"
          bindConfig={bindConfig}
          proxyRunning
          hasAccounts
          onAccountRequest={vi.fn()}
          onToggleModel={vi.fn()}
          onboarding={onboarding}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("已启用 1 / 共 1 个账号")).toBeInTheDocument();
    expect(screen.getByText("已启用 1 / 共 1 个模型")).toBeInTheDocument();
    expect(screen.getByText("AI Agent 接入")).toBeInTheDocument();
    expect(screen.queryByText("onboarding-placeholder")).not.toBeInTheDocument();
  });

  it("renders the onboarding content when there are no accounts", () => {
    render(
      <MemoryRouter>
        <OverviewGrid
          accounts={[]}
          channels={channels}
          balanceSnapshots={snapshots}
          routes={[]}
          baseUrl="http://127.0.0.1:18640"
          bindConfig={bindConfig}
          proxyRunning={false}
          hasAccounts={false}
          onAccountRequest={vi.fn()}
          onToggleModel={vi.fn()}
          onboarding={onboarding}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("onboarding-placeholder")).toBeInTheDocument();
    expect(screen.queryByText("已启用 0 / 共 0 个账号")).not.toBeInTheDocument();
  });
});
