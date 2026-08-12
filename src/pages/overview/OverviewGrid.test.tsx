import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  useAgentEnvironments: () => new Map(["claude-code", "opencode", "pi", "codex"].map((id) => [id, {
    data: { agent_id: id, agent_name: id, installed: false, installations: [] },
    error: null,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }])),
  useAgentLatestVersions: () => ({ data: { agents: [] }, isLoading: false, isFetching: false, isError: false, error: null, refetch: vi.fn() }),
  useAgentGlobalConfig: () => ({
    query: { data: undefined, error: null, isLoading: false, refetch: vi.fn() },
    apply: { isPending: false, mutateAsync: vi.fn() },
    restore: { isPending: false, mutateAsync: vi.fn() },
  }),
}));

function makeAccount(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: "acc-1",
    workspace_account_id: null,
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
    workspace_default_base_url: null,
    workspace_default_anthropic_base_url: null,
    last_used_at: null,
    last_error: null,
    credential_status: "healthy",
    synced_models: null,
    models_synced_at: null,
    exposed_models: null,
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
          onAccountRequest={vi.fn()}
          onToggleAccount={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("已启用 1 / 共 1 个账号")).toBeInTheDocument();
    expect(screen.getByText("聚合模型")).toBeInTheDocument();
    expect(screen.getByText("共 2 个聚合模型")).toBeInTheDocument();
    expect(screen.getByText("AI Agent 接入")).toBeInTheDocument();
  });

  it("keeps the full overview and routes empty account actions when there are no accounts", async () => {
    const user = userEvent.setup();
    const onAccountRequest = vi.fn();
    render(
      <MemoryRouter>
        <OverviewGrid
          accounts={[]}
          channels={channels}
          balanceSnapshots={snapshots}
          routes={[]}
          baseUrl="http://127.0.0.1:18640"
          bindConfig={bindConfig}
          onAccountRequest={onAccountRequest}
          onToggleAccount={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("已启用 0 / 共 0 个账号")).toBeInTheDocument();
    expect(screen.getByText("选择一个渠道添加首个账号")).toBeInTheDocument();
    expect(screen.getByText("聚合模型")).toBeInTheDocument();
    expect(screen.getByText("添加渠道账号并配置聚合路由后，这里会显示可用状态。")).toBeInTheDocument();
    expect(screen.getByText("AI Agent 接入")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "添加 DeepSeek" }));
    expect(onAccountRequest).toHaveBeenCalledWith({ kind: "create", channelId: "deepseek" });
  });
});
