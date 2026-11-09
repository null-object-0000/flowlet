import { describe, expect, it } from "vitest";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";
import { computeAvailableModels } from "./availableModels";

const channels: ChannelPreset[] = [
  {
    id: "deepseek", name: "DeepSeek", vendor: "deepseek",
    supported_protocols: ["openai", "anthropic"], openai_base_url: "", anthropic_base_url: "",
    openai_auth: "bearer", anthropic_auth: "x_api_key", default_model: "", small_model: null,
    platform_url: null, supports_model_list: true, supports_model_detail: true,
    supports_balance_query: true, supports_quota_query: false, supports_usage_query: false,
    supports_scrape_balance: false, supports_files_api: false, created_at: "", updated_at: "",
  },
  {
    id: "openai-api", name: "ChatGPT API", vendor: "openai",
    supported_protocols: ["openai", "responses"], openai_base_url: "", anthropic_base_url: "",
    openai_auth: "bearer", anthropic_auth: "bearer", default_model: "", small_model: null,
    platform_url: null, supports_model_list: false, supports_model_detail: false,
    supports_balance_query: false, supports_quota_query: false, supports_usage_query: false,
    supports_scrape_balance: false, supports_files_api: false, created_at: "", updated_at: "",
  },
  {
    id: "kimi", name: "Kimi", vendor: "moonshot",
    supported_protocols: ["openai"], openai_base_url: "", anthropic_base_url: "",
    openai_auth: "bearer", anthropic_auth: "bearer", default_model: "", small_model: null,
    platform_url: null, supports_model_list: true, supports_model_detail: true,
    supports_balance_query: true, supports_quota_query: false, supports_usage_query: false,
    supports_scrape_balance: false, supports_files_api: false, created_at: "", updated_at: "",
  },
];

function account(overrides: Partial<ChannelAccount>): ChannelAccount {
  return {
    id: "a1",
    workspace_account_id: null,
    channel_id: "deepseek",
    name: "账号",
    api_key: "sk-test",
    enabled: true,
    priority: 0,
    remark: null,
    resource_mode: null,
    resource_sync_mode: "manual",
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
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as ChannelAccount;
}

function route(overrides: Partial<RouteCandidate> & Pick<RouteCandidate, "id">): RouteCandidate {
  return {
    virtual_model_id: "deepseek-v4-pro",
    upstream_model: "deepseek-v4-pro",
    channel_id: "deepseek",
    account_id: "a1",
    client_protocol: "openai",
    priority: 0,
    enabled: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const accounts = [
  account({ id: "a1" }),
  account({ id: "a2", credential_status: "invalid_key" }),
  account({ id: "a3", enabled: false }),
  account({ id: "a4", channel_id: "openai-api" }),
];

describe("computeAvailableModels", () => {
  it("merges protocols per canonical model and ignores unusable candidates", () => {
    const routes = [
      route({ id: "openai-pro", client_protocol: "openai" }),
      route({ id: "anthropic-pro", client_protocol: "anthropic" }),
      route({
        id: "flash-alias",
        virtual_model_id: "deepseek-v4-flash",
        upstream_model: "deepseek-v4-flash-0731",
      }),
      route({ id: "responses-sol", virtual_model_id: "gpt-6-sol", upstream_model: "gpt-6-sol", channel_id: "openai-api", account_id: "a4", client_protocol: "responses" }),
      // 停用路由
      route({ id: "disabled", virtual_model_id: "qwen3.8-max", upstream_model: "qwen3.8-max", enabled: false }),
      // 凭证不健康的账号
      route({ id: "invalid-key", virtual_model_id: "qwen3.8-max", upstream_model: "qwen3.8-max", account_id: "a2" }),
      // 渠道不支持该协议
      route({ id: "kimi-anthropic", virtual_model_id: "kimi-k3", upstream_model: "kimi-k3", channel_id: "kimi", account_id: "a1", client_protocol: "anthropic" }),
    ];

    expect(computeAvailableModels(routes, accounts, channels)).toEqual([
      { model: "deepseek-v4-flash", protocols: ["openai"] },
      { model: "deepseek-v4-pro", protocols: ["openai", "anthropic"] },
      { model: "gpt-6-sol", protocols: ["responses"] },
    ]);
  });

  it("skips legacy aggregate identities and unmapped non-canonical routes", () => {
    const routes = [
      // 旧聚合路由：对外名与上游模型不是同一规范身份。
      route({ id: "legacy-pro", virtual_model_id: "flowlet-pro", upstream_model: "deepseek-v4-pro" }),
      // 上游模型不在本地目录，无法校验规范身份。
      route({ id: "unknown-upstream", virtual_model_id: "kimi-k3", upstream_model: "kimi-custom-x" }),
      route({ id: "valid", virtual_model_id: "qwen3.8-max", upstream_model: "qwen3.8-max" }),
    ];

    expect(computeAvailableModels(routes, [account({ id: "a1" })], channels)).toEqual([
      { model: "qwen3.8-max", protocols: ["openai"] },
    ]);
  });

  it("skips disabled channels", () => {
    const disabledChannel = { ...channels[0], id: "disabled", enabled: false } as ChannelPreset;
    const routes = [
      route({ id: "disabled-channel", channel_id: "disabled" }),
      route({ id: "valid", virtual_model_id: "qwen3.8-max", upstream_model: "qwen3.8-max" }),
    ];

    expect(computeAvailableModels(routes, [account({ id: "a1" })], [...channels, disabledChannel])).toEqual([
      { model: "qwen3.8-max", protocols: ["openai"] },
    ]);
  });

  it("returns an empty list when there is no data yet", () => {
    expect(computeAvailableModels(undefined, undefined, undefined)).toEqual([]);
  });
});
