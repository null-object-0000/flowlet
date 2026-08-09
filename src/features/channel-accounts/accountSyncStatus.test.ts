import { describe, expect, it } from "vitest";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { CodexAccountReport } from "../../domains/agent/types";
import { CHANNEL_RESOURCE_SYNC_INTERVAL_MS } from "../background-tasks/ChannelResourceAutoSync";
import { CODEX_ACCOUNT_SYNC_INTERVAL_MS } from "../background-tasks/CodexAccountAutoSync";
import { accountSyncStatus, codexSyncStatus, hasChannelAutoSync } from "./accountSyncStatus";

const NOW = new Date("2026-07-29T10:00:00Z").getTime();

function makeAccount(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: "acc-1",
    workspace_account_id: null,
    channel_id: "longcat",
    name: "账号",
    api_key: "configured",
    enabled: true,
    priority: 1,
    remark: null,
    resource_mode: "hybrid",
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

function makePreset(overrides: Partial<ChannelPreset> = {}): ChannelPreset {
  return {
    id: "longcat",
    name: "LongCat",
    vendor: "longcat",
    supported_protocols: ["openai"],
    openai_base_url: "",
    anthropic_base_url: "",
    openai_auth: "bearer",
    anthropic_auth: "bearer",
    default_model: "",
    small_model: null,
    platform_url: null,
    supports_model_list: true,
    supports_model_detail: false,
    supports_balance_query: false,
    supports_quota_query: false,
    supports_usage_query: false,
    supports_scrape_balance: true,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<AccountBalanceSnapshot> = {}): AccountBalanceSnapshot {
  return {
    id: "balance-1",
    account_id: "acc-1",
    balance: null,
    currency: null,
    token_pack_total: null,
    token_pack_used: null,
    token_pack_remaining: null,
    token_pack_expire_at: null,
    token_packs: null,
    raw_scraped_json: null,
    source: "scrape",
    synced_at: "2026-07-29T09:59:00Z",
    remark: null,
    created_at: "2026-07-29T09:59:00Z",
    updated_at: "2026-07-29T09:59:00Z",
    ...overrides,
  };
}

describe("hasChannelAutoSync", () => {
  it("auto-syncs LongCat console-scrape accounts only in auto mode", () => {
    const longcat = makePreset();
    expect(hasChannelAutoSync(makeAccount({ resource_sync_mode: "auto" }), longcat)).toBe(true);
    expect(hasChannelAutoSync(makeAccount({ resource_sync_mode: "manual" }), longcat)).toBe(false);
  });

  it("auto-syncs Qwen Token Plan subscription accounts only, not pay-as-you-go API accounts", () => {
    const qwen = makePreset({ id: "qwen" });
    expect(
      hasChannelAutoSync(makeAccount({ channel_id: "qwen", resource_mode: "token_plan", resource_sync_mode: "auto" }), qwen),
    ).toBe(true);
    expect(
      hasChannelAutoSync(makeAccount({ channel_id: "qwen", resource_mode: "token_plan", resource_sync_mode: "manual" }), qwen),
    ).toBe(false);
    // Qwen API 按量付费账号没有官方余额接口也没有可用的控制台抓取模式，
    // 即使标记 auto 也不参与自动同步。
    expect(
      hasChannelAutoSync(makeAccount({ channel_id: "qwen", resource_mode: "pay_as_you_go", resource_sync_mode: "auto" }), qwen),
    ).toBe(false);
  });

  it("auto-syncs DeepSeek / Kimi official-balance-api accounts regardless of sync mode", () => {
    const deepseek = makePreset({ id: "deepseek", supports_balance_query: true, supports_scrape_balance: false });
    expect(
      hasChannelAutoSync(makeAccount({ channel_id: "deepseek", resource_sync_mode: "manual" }), deepseek),
    ).toBe(true);
    const kimi = makePreset({ id: "kimi", supports_balance_query: true, supports_scrape_balance: false });
    expect(hasChannelAutoSync(makeAccount({ channel_id: "kimi", resource_sync_mode: "manual" }), kimi)).toBe(true);
  });

  it("skips official-balance-api accounts with a custom OpenAI endpoint override", () => {
    const deepseek = makePreset({ id: "deepseek", supports_balance_query: true, supports_scrape_balance: false });
    expect(
      hasChannelAutoSync(
        makeAccount({ channel_id: "deepseek", resource_sync_mode: "auto", base_url_override: "https://relay.example.com/v1" }),
        deepseek,
      ),
    ).toBe(false);
  });

  it("skips disabled accounts", () => {
    expect(hasChannelAutoSync(makeAccount({ enabled: false, resource_sync_mode: "auto" }), makePreset())).toBe(false);
  });

  it("skips accounts whose channel preset does not participate in auto sync", () => {
    const custom = makePreset({ id: "custom", supports_balance_query: false, supports_scrape_balance: false });
    expect(hasChannelAutoSync(makeAccount({ channel_id: "custom", resource_sync_mode: "auto" }), custom)).toBe(false);
  });
});

describe("accountSyncStatus", () => {
  it("returns null for accounts without auto sync", () => {
    expect(accountSyncStatus(makeAccount({ resource_sync_mode: "manual" }), makeSnapshot(), makePreset(), NOW)).toBeNull();
  });

  it("is fresh when the last sync is within one sync cycle", () => {
    const freshSnapshot = makeSnapshot({ synced_at: new Date(NOW - CHANNEL_RESOURCE_SYNC_INTERVAL_MS + 1_000).toISOString() });
    expect(accountSyncStatus(makeAccount(), freshSnapshot, makePreset(), NOW)).toBe("fresh");
  });

  it("is still fresh when the last sync is between one and two sync cycles", () => {
    const betweenRounds = makeSnapshot({ synced_at: new Date(NOW - CHANNEL_RESOURCE_SYNC_INTERVAL_MS - 1_000).toISOString() });
    expect(accountSyncStatus(makeAccount(), betweenRounds, makePreset(), NOW)).toBe("fresh");
  });

  it("is stale when the last sync exceeds two sync cycles", () => {
    const staleSnapshot = makeSnapshot({ synced_at: new Date(NOW - CHANNEL_RESOURCE_SYNC_INTERVAL_MS * 2 - 1_000).toISOString() });
    expect(accountSyncStatus(makeAccount(), staleSnapshot, makePreset(), NOW)).toBe("stale");
  });

  it("is stale when the account has never been synced", () => {
    expect(accountSyncStatus(makeAccount(), undefined, makePreset(), NOW)).toBe("stale");
  });

  it("is stale when the snapshot timestamp cannot be parsed", () => {
    expect(accountSyncStatus(makeAccount(), makeSnapshot({ synced_at: "not-a-date" }), makePreset(), NOW)).toBe("stale");
  });

  it("marks DeepSeek official-balance-api accounts stale when sync is overdue by more than two cycles", () => {
    const deepseek = makePreset({ id: "deepseek", supports_balance_query: true, supports_scrape_balance: false });
    const account = makeAccount({ channel_id: "deepseek", resource_sync_mode: "manual" });
    const stale = makeSnapshot({ synced_at: new Date(NOW - CHANNEL_RESOURCE_SYNC_INTERVAL_MS * 2 - 1_000).toISOString() });
    expect(accountSyncStatus(account, stale, deepseek, NOW)).toBe("stale");
  });
});

function makeCodexReport(overrides: Partial<CodexAccountReport> = {}): CodexAccountReport {
  return {
    account_id: "codex-1",
    signed_in: true,
    auth_mode: "chatgpt",
    email: "one@example.com",
    plan_type: "plus",
    primary: null,
    secondary: null,
    credits: null,
    rate_limit_reset_credits: null,
    rate_limit_reached_type: null,
    source: "oauth",
    updated_at: new Date(NOW - 60_000).toISOString(),
    stale: false,
    error: null,
    ...overrides,
  };
}

describe("codexSyncStatus", () => {
  it("is fresh when the last successful update is within one sync cycle", () => {
    expect(codexSyncStatus(makeCodexReport(), NOW)).toBe("fresh");
  });

  it("is still fresh when the last successful update is between one and two sync cycles", () => {
    const report = makeCodexReport({ updated_at: new Date(NOW - CODEX_ACCOUNT_SYNC_INTERVAL_MS - 1_000).toISOString() });
    expect(codexSyncStatus(report, NOW)).toBe("fresh");
  });

  it("is stale when the last successful update exceeds two sync cycles", () => {
    const report = makeCodexReport({ updated_at: new Date(NOW - CODEX_ACCOUNT_SYNC_INTERVAL_MS * 2 - 1_000).toISOString() });
    expect(codexSyncStatus(report, NOW)).toBe("stale");
  });

  it("is stale immediately when the report is marked stale (last refresh failed)", () => {
    const report = makeCodexReport({ stale: true, updated_at: new Date(NOW - 10_000).toISOString() });
    expect(codexSyncStatus(report, NOW)).toBe("stale");
  });

  it("is stale when the updated_at timestamp cannot be parsed", () => {
    expect(codexSyncStatus(makeCodexReport({ updated_at: "not-a-date" }), NOW)).toBe("stale");
  });
});
