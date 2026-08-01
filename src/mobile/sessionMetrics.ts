import type { SharedAgentSession } from "../domains/device-sync/types";

export type MobileSessionMetrics =
  | { source: "flowlet"; tokens: number; count: number; failures: number; truncated: false }
  | { source: "agent-native"; tokens: number | null; count: number | null; failures: null; truncated: boolean };

/** 原生轮次不等于 HTTP 请求，且原生文件没有可靠失败数；不可把缺失指标展示成 0。 */
export function mobileSessionMetrics(session: SharedAgentSession): MobileSessionMetrics {
  if (session.flowletObserved) {
    return {
      source: "flowlet",
      tokens: session.knownTokens,
      count: session.requestCount,
      failures: session.errorCount,
      truncated: false,
    };
  }
  return {
    source: "agent-native",
    tokens: session.nativeTotalTokens ?? null,
    count: session.nativeTurnCount ?? null,
    failures: null,
    truncated: session.nativeTruncated ?? false,
  };
}
