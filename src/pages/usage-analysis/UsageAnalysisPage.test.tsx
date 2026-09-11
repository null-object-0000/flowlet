import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { UsageSummaryRow } from "../../domains/usage/types";
import { groupConsumption } from "./consumptionAnalysisPresentation";
import { DimensionBadge } from "./UsageAnalysisPage";

/**
 * 用量洞察页徽标回归：用户报告过两类错误——
 * 1. 客户端维度下 DeepSeek Harness / Hermes Agent 没有品牌图标；
 * 2. 渠道账号维度下 Agent 原生账号（Codex Desktop、Codex CLI、Claude Code 原生等）
 *    落到了伪渠道 `agent-native` 上，全部退化成首字母徽标。
 * 这里从 usage_summary 行走到真实渲染结果，避免只验证中间字段。
 */
function row(partial: Partial<UsageSummaryRow>): UsageSummaryRow {
  return {
    date: "2026-07-30",
    client_id: null,
    client_name: null,
    channel_id: null,
    channel_name: null,
    account_id: null,
    account_name: null,
    upstream_model: null,
    request_count: 1,
    known_tokens: 0,
    input_tokens: 0,
    input_cached_tokens: 0,
    input_uncached_tokens: 0,
    cache_measured_input_tokens: 0,
    output_tokens: 0,
    unknown_count: 0,
    estimated_cost: 0,
    elapsed_total_ms: 0,
    elapsed_measured_count: 0,
    generation_total_ms: 0,
    generation_output_tokens: 0,
    device_id: null,
    ...partial,
  };
}

/** 未经过 Flowlet 的 Agent 原生行：channel_id 固定为伪渠道，account_id 保存 Agent 类型。 */
function nativeRow(agentType: string, clientId: string, name: string): UsageSummaryRow {
  return row({
    client_id: clientId,
    client_name: name,
    channel_id: "agent-native",
    channel_name: "Agent 原生（未经过 Flowlet）",
    account_id: agentType,
    account_name: name,
    upstream_model: "deepseek-v4-pro",
    request_count: 0,
    native_event_count: 1,
    known_tokens: 100,
  });
}

const NATIVE_ROWS = [
  nativeRow("codex-desktop", "codex-desktop", "Codex Desktop"),
  nativeRow("codex-cli", "codex", "Codex CLI"),
  nativeRow("claude-code", "claude-code", "Claude Code"),
  nativeRow("deepseek-harness", "deepseek-harness", "DeepSeek Harness"),
  nativeRow("hermes", "hermes", "Hermes Agent"),
];

function renderedClass(entry: Parameters<typeof DimensionBadge>[0]["entry"]): { className: string; hasImage: boolean } {
  const { container } = render(<DimensionBadge entry={entry} />);
  const badge = container.firstElementChild as HTMLElement;
  return { className: badge.className, hasImage: container.querySelector("img") != null };
}

describe("DimensionBadge", () => {
  it("renders the Agent brand mark for every Agent-native channel account", () => {
    const entries = groupConsumption(NATIVE_ROWS, "account");
    const expected: Array<[string, string]> = [
      ["agent-native::codex-desktop", "openai"],
      ["agent-native::codex-cli", "openai"],
      ["agent-native::claude-code", "claude-code"],
      ["agent-native::deepseek-harness", "deepseek"],
      ["agent-native::hermes", "hermes"],
    ];
    for (const [key, brand] of expected) {
      const entry = entries.find((candidate) => candidate.key === key);
      expect(entry, key).toBeTruthy();
      const { className, hasImage } = renderedClass(entry!);
      // ChannelBrandLogo 会渲染 <img> 或圆形首字母徽标；Agent 标记是纯 mask 图标。
      expect(hasImage, key).toBe(false);
      expect(className, key).toContain(brand);
      expect(className, key).not.toContain("logo");
    }
  });

  it("renders the Agent brand mark for the client dimension", () => {
    const entries = groupConsumption(NATIVE_ROWS, "client");
    const deepseekHarness = entries.find((entry) => entry.key === "deepseek-harness");
    expect(renderedClass(deepseekHarness!).className).toContain("deepseek");
    const hermes = entries.find((entry) => entry.key === "hermes");
    expect(renderedClass(hermes!).className).toContain("hermes");
    // Codex CLI 的 client_id 是 `codex`，与 Codex Desktop 共用 OpenAI 标记。
    const codex = entries.find((entry) => entry.key === "codex");
    expect(renderedClass(codex!).className).toContain("openai");
  });

  it("keeps channel logos for real channel accounts and the letter badge for unknown clients", () => {
    const accountEntries = groupConsumption([
      row({ channel_id: "deepseek", channel_name: "DeepSeek", account_id: "acc-1", account_name: "主账号", upstream_model: "deepseek-v4-pro" }),
    ], "account");
    // 真实渠道账号仍走 ChannelBrandLogo（圆形渠道徽标），不被 Agent 标记替换。
    const channel = renderedClass(accountEntries[0]);
    expect(channel.className).toContain("logo");
    expect(channel.className).toContain("deepseek");

    const clientEntries = groupConsumption([row({ channel_id: "deepseek", account_id: "acc-1", upstream_model: "deepseek-v4-pro" })], "client");
    const unknown = renderedClass(clientEntries[0]);
    expect(unknown.className).toContain("badgeLetter");
    expect(unknown.hasImage).toBe(false);
  });
});
