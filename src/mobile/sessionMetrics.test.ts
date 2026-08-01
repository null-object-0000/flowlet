import { describe, expect, it } from "vitest";
import type { SharedAgentSession } from "../domains/device-sync/types";
import { mobileSessionMetrics } from "./sessionMetrics";

function session(overrides: Partial<SharedAgentSession>): SharedAgentSession {
  return {
    deviceId: "device-1",
    deviceDisplayName: "Work PC",
    devicePlatform: "windows",
    agentType: "codex-cli",
    sessionId: "session-1",
    parentSessionId: null,
    runtimeStatus: "idle",
    title: "Codex task",
    clientName: "Codex CLI",
    activityAt: "2026-08-01T12:00:00Z",
    flowletObserved: false,
    requestCount: 0,
    errorCount: 0,
    knownTokens: 0,
    lastInteraction: null,
    ...overrides,
  };
}

describe("mobileSessionMetrics", () => {
  it("uses native tokens and turns for a session that bypassed Flowlet", () => {
    expect(mobileSessionMetrics(session({
      nativeTotalTokens: 12_345,
      nativeTurnCount: 8,
      nativeTruncated: true,
    }))).toEqual({
      source: "agent-native",
      tokens: 12_345,
      count: 8,
      failures: null,
      truncated: true,
    });
  });

  it("keeps missing native evidence unavailable instead of rendering zero", () => {
    expect(mobileSessionMetrics(session({}))).toMatchObject({
      source: "agent-native",
      tokens: null,
      count: null,
      failures: null,
    });
  });

  it("keeps Flowlet request metrics for an observed session", () => {
    expect(mobileSessionMetrics(session({
      flowletObserved: true,
      knownTokens: 500,
      requestCount: 3,
      errorCount: 1,
      nativeTotalTokens: 900,
      nativeTurnCount: 4,
    }))).toEqual({
      source: "flowlet",
      tokens: 500,
      count: 3,
      failures: 1,
      truncated: false,
    });
  });
});
