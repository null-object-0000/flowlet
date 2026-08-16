import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppPreferencesProvider } from "../../app/preferences/AppPreferences";
import type { AgentSessionInteractionEvent } from "../../domains/agent-session/types";
import { SessionConversation } from "./SessionConversation";

function event(overrides: Partial<AgentSessionInteractionEvent>): AgentSessionInteractionEvent {
  return {
    id: "evt",
    kind: "assistant-message",
    source: "agent-native",
    timestamp: null,
    title: null,
    content: null,
    model: null,
    status: null,
    durationMs: null,
    timeToFirstTokenMs: null,
    usage: null,
    ...overrides,
  };
}

function renderConversation(events: AgentSessionInteractionEvent[]) {
  return render(
    <AppPreferencesProvider>
      <SessionConversation events={events} truncated={false} loading={false} error={null} language="zh-CN" onRetry={() => undefined} />
    </AppPreferencesProvider>,
  );
}

describe("SessionConversation", () => {
  it("组出按轮次边界切分的轮次，并保留轮次内事件顺序", () => {
    renderConversation([
      event({ id: "turn-1", kind: "turn", status: "completed", durationMs: 1_200, trace: { turn: 1 } as unknown as AgentSessionInteractionEvent["trace"] }),
      event({ id: "user-1", kind: "user-message", content: "第一个问题" }),
      event({ id: "assistant-1", kind: "assistant-message", content: "第一个回答" }),
      event({ id: "turn-2", kind: "turn", status: "completed", durationMs: 800, trace: { turn: 2 } as unknown as AgentSessionInteractionEvent["trace"] }),
      event({ id: "user-2", kind: "user-message", content: "第二个问题" }),
      event({ id: "assistant-2", kind: "assistant-message", content: "第二个回答" }),
    ]);

    expect(screen.getByText("第一个问题")).toBeInTheDocument();
    expect(screen.getByText("第一个回答")).toBeInTheDocument();
    expect(screen.getByText("第二个问题")).toBeInTheDocument();
    // 第二轮的轮次分隔线。
    expect(screen.getByText("Turn #2")).toBeInTheDocument();
  });

  it("非用户来源消息渲染为可展开的「上下文注入」折叠行，来源 provenance 展示生产者", () => {
    renderConversation([
      event({ id: "turn-1", kind: "turn", status: "completed", durationMs: null }),
      event({
        id: "context-1",
        kind: "context",
        content: "workspace instructions\nvery long body",
        trace: { sourceKind: "agent-instructions", sourceForm: "instructions", producer: "AGENTS.md, CLAUDE.md" } as unknown as AgentSessionInteractionEvent["trace"],
      }),
    ]);

    expect(screen.getByText("Context injection")).toBeInTheDocument();
    // 生产者路径。
    expect(screen.getByText("AGENTS.md, CLAUDE.md")).toBeInTheDocument();
    // 折叠摘要展示首行。
    expect(screen.getByText("workspace instructions")).toBeInTheDocument();
    // 正文为同一 Markdown 段落（换行在文本节点内），用子串匹配。
    expect(screen.getByText(/very long body/)).toBeInTheDocument();
  });

  it("跨会话召回来源使用「跨会话召回」标签", () => {
    renderConversation([
      event({ id: "turn-1", kind: "turn", status: "completed", durationMs: null }),
      event({
        id: "recall-1",
        kind: "context",
        content: "Previous session notes",
        trace: { sourceKind: "session-reference", sourceForm: "recall", producer: "session-xyz" } as unknown as AgentSessionInteractionEvent["trace"],
      }),
    ]);

    expect(screen.getByText("Session recall")).toBeInTheDocument();
    expect(screen.getByText("session-xyz")).toBeInTheDocument();
  });

  it("模型重试行展示次数/延迟/失败原因", () => {
    renderConversation([
      event({ id: "turn-1", kind: "turn", status: "completed", durationMs: null }),
      event({ id: "retry-1", kind: "model-retry", title: "retry 1/2 · 463 ms", content: "RATE_LIMIT" }),
      event({ id: "assistant-1", kind: "assistant-message", content: "done" }),
    ]);

    expect(screen.getByText("retry 1/2 · 463 ms")).toBeInTheDocument();
    expect(screen.getByText("RATE_LIMIT")).toBeInTheDocument();
  });

  it("推理块渲染为 Think 折叠行，摘要取首行", () => {
    renderConversation([
      event({ id: "turn-1", kind: "turn", status: "completed", durationMs: null }),
      event({ id: "think-1", kind: "reasoning", content: "先检查一下实现\n再补充测试" }),
      event({ id: "assistant-1", kind: "assistant-message", content: "完成" }),
    ]);

    expect(screen.getByText("Think")).toBeInTheDocument();
    expect(screen.getByText("先检查一下实现")).toBeInTheDocument();
    // 展开后全文（jsdom 不应用 hidden：直接断言内容存在）。
    expect(screen.getByText(/再补充测试/)).toBeInTheDocument();
  });

  it("压缩标记行展示「上下文已压缩」与总结正文", () => {
    renderConversation([
      event({ id: "turn-1", kind: "turn", status: "completed", durationMs: null }),
      event({ id: "compact-1", kind: "compacted", content: "## Primary Request\n- original goal", durationMs: 9_000 }),
    ]);

    expect(screen.getByText("Context compacted")).toBeInTheDocument();
    expect(screen.getByText(/original goal/)).toBeInTheDocument();
    expect(screen.getByText(/9 s/)).toBeInTheDocument();
  });

  it("按 turn 状态渲染运行中 / 失败 / max-tokens / 中断提示", () => {
    renderConversation([
      event({ id: "turn-running", kind: "turn", status: "running" }),
      event({ id: "turn-error", kind: "turn", status: "error", content: "boom code" }),
      event({ id: "turn-max", kind: "turn", status: "max-tokens" }),
      event({ id: "turn-cancelled-with-output", kind: "turn", status: "cancelled" }),
      event({ id: "assistant-1", kind: "assistant-message", content: "已有输出" }),
      event({ id: "turn-cancelled-empty", kind: "turn", status: "cancelled" }),
    ]);

    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByText("This turn failed")).toBeInTheDocument();
    expect(screen.getByText("boom code")).toBeInTheDocument();
    expect(screen.getByText("Output token limit reached")).toBeInTheDocument();
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText("This turn was interrupted before a reply was generated.")).toBeInTheDocument();
  });

  it("已完成轮次展示用时 + 首 token + 解码吞吐", () => {
    renderConversation([
      event({
        id: "turn-1",
        kind: "turn",
        status: "completed",
        durationMs: 5_000,
      }),
      event({
        id: "assistant-1",
        kind: "assistant-message",
        content: "回答",
        durationMs: 3_000,
        timeToFirstTokenMs: 800,
        usage: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 120, reasoningTokens: 0, cost: null, costCurrency: null, apiEquivalent: null },
      }),
    ]);

    expect(screen.getByText("Duration 5 s")).toBeInTheDocument();
    expect(screen.getByText("First token 800 ms")).toBeInTheDocument();
    // 120 tokens / 2200 ms ≈ 54.5 tok/s
    expect(screen.getByText(/54\.5 tok\/s/)).toBeInTheDocument();
  });
});