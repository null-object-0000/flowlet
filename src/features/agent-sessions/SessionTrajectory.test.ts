import { describe, expect, it } from "vitest";
import type { AgentSessionInteractionEvent } from "../../domains/agent-session/types";
import { deriveTrajectoryRows } from "./SessionTrajectory";

function event(overrides: Partial<AgentSessionInteractionEvent>): AgentSessionInteractionEvent {
  return {
    id: "event",
    kind: "assistant-message",
    source: "agent-native",
    timestamp: "2026-08-16T00:00:00Z",
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

describe("deriveTrajectoryRows", () => {
  it("preserves DSH turn, step and sequence coordinates", () => {
    const rows = deriveTrajectoryRows([
      event({
        id: "request",
        kind: "request",
        title: "Request #2",
        model: "flowlet-pro",
        trace: {
          sequence: 42,
          eventType: "request/header",
          turn: 3,
          step: 2,
          callId: null,
          parentCallId: null,
          provider: "flowlet",
          requestReason: "initial",
          input: "{}",
          output: null,
          systemPrompt: "system",
          tools: "[]",
        },
      }),
    ]);

    expect(rows).toMatchObject([{ index: 42, turn: 3, step: 2, kind: "system", label: "SYSTEM" }]);
  });

  it("keeps reasoning in conversation but omits it from the compact ledger", () => {
    const rows = deriveTrajectoryRows([
      event({ id: "user", kind: "user-message", content: "question" }),
      event({ id: "reasoning", kind: "reasoning", content: "thinking" }),
      event({ id: "answer", kind: "assistant-message", content: "answer" }),
    ]);

    expect(rows.map((row) => row.id)).toEqual(["user", "answer"]);
    expect(rows.every((row) => row.turn === 1)).toBe(true);
  });

  it("marks nested tool calls as subtool rows", () => {
    const rows = deriveTrajectoryRows([
      event({
        id: "subtool",
        kind: "tool-call",
        title: "read_file",
        content: "{}",
        trace: {
          sequence: 9,
          eventType: "tool/call",
          turn: 1,
          step: 1,
          callId: "child",
          parentCallId: "parent",
          provider: null,
          requestReason: null,
          input: "{}",
          output: null,
          systemPrompt: null,
          tools: null,
        },
      }),
    ]);

    expect(rows[0].kind).toBe("subtool");
  });

  it("folds a tool call and its result into one DSH-style row", () => {
    const trace = {
      sequence: 10,
      eventType: "tool/call",
      turn: 2,
      step: 3,
      callId: "call-1",
      parentCallId: null,
      provider: null,
      requestReason: null,
      input: '{"pattern":"*.tsx"}',
      output: null,
      systemPrompt: null,
      tools: null,
    };
    const rows = deriveTrajectoryRows([
      event({ id: "call", kind: "tool-call", title: "glob", content: trace.input, trace }),
      event({
        id: "result",
        kind: "tool-result",
        title: "glob",
        content: "src/App.tsx",
        durationMs: 42,
        trace: { ...trace, sequence: 11, eventType: "tool/result", input: null, output: "src/App.tsx" },
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "glob", index: 10, turn: 2 });
    expect(rows[0].preview).toContain("→");
    expect(rows[0].outputEvent?.id).toBe("result");
  });
});
