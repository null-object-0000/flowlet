import { describe, expect, it } from "vitest";
import { calculateCacheHitRate, calculateOutputTokenRate, formatCapturedBody, formatCapturedJson, formatDuration, formatEntryRequestUrl, isPreRoutingFailure, safeLogText } from "./logPresentation";

describe("request log presentation", () => {
  it("preserves sensitive headers and nested JSON values", () => {
    const rendered = formatCapturedJson(JSON.stringify({
      Authorization: "Bearer sk-secret",
      nested: { api_key: "secret", model: "LongCat-2.0" },
    }));
    expect(rendered).toContain("sk-secret");
    expect(rendered).toContain('"secret"');
    expect(rendered).toContain("LongCat-2.0");
  });

  it("decodes UTF-8 request bodies without redacting token fields", () => {
    const body = btoa(unescape(encodeURIComponent(JSON.stringify({ prompt: "你好", client_token: "private" }))));
    const rendered = formatCapturedBody(body);
    expect(rendered).toContain("你好");
    expect(rendered).toContain("private");
  });

  it("distinguishes cleaned and pending bodies from content that was never captured", () => {
    expect(formatCapturedBody(null, "zh-CN", { clearedAt: "2026-07-22T10:00:00Z", cleanupReason: "retention" })).toContain("数据过期");
    expect(formatCapturedBody(null, "zh-CN", { clearedAt: "2026-07-22T10:00:00Z", cleanupReason: "size_limit" })).toContain("存储空间");
    expect(formatCapturedBody(null, "zh-CN", { pending: true })).toContain("等待流式响应完成");
    expect(formatCapturedBody(null)).toContain("未捕获");
  });

  it("preserves credentials embedded in error text", () => {
    expect(safeLogText("authorization=Bearer abcdef")).toContain("abcdef");
  });

  it("derives generation rate and cache hit rate from recorded metrics", () => {
    expect(calculateOutputTokenRate({ output_tokens: 90, ttft_ms: 500, duration_ms: 2_000 })).toBe(60);
    expect(calculateOutputTokenRate({ output_tokens: 90, ttft_ms: null, duration_ms: 2_000 })).toBeNull();
    expect(calculateCacheHitRate({ input_tokens: 1_000, input_cached_tokens: 750 })).toBe(0.75);
    expect(calculateCacheHitRate({ input_tokens: 1_000, input_cached_tokens: null })).toBeNull();
  });

  it("rounds averaged millisecond durations without leaking floating-point precision", () => {
    expect(formatDuration(412.8888888888889)).toBe("413 ms");
    expect(formatDuration(2_728.5)).toBe("2.73 s");
  });

  it("reconstructs the inbound URL and identifies failures before routing", () => {
    const row = {
      path: "/v1/chat/completions",
      req_headers_json: JSON.stringify({ host: "127.0.0.1:18640" }),
      route_reason: "model_not_exposed",
      upstream_url: null,
    };
    expect(formatEntryRequestUrl(row)).toBe("http://127.0.0.1:18640/v1/chat/completions");
    expect(isPreRoutingFailure(row)).toBe(true);
  });
});
