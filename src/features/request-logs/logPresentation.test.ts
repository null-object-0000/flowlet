import { describe, expect, it } from "vitest";
import { calculateCacheHitRate, calculateOutputTokenRate, formatCapturedBody, formatCapturedJson, safeLogText } from "./logPresentation";

describe("request log privacy presentation", () => {
  it("redacts sensitive headers and nested JSON values", () => {
    const rendered = formatCapturedJson(JSON.stringify({
      Authorization: "Bearer sk-secret",
      nested: { api_key: "secret", model: "LongCat-2.0" },
    }));
    expect(rendered).not.toContain("sk-secret");
    expect(rendered).not.toContain('"secret"');
    expect(rendered).toContain("LongCat-2.0");
  });

  it("decodes UTF-8 request bodies and redacts token fields", () => {
    const body = btoa(unescape(encodeURIComponent(JSON.stringify({ prompt: "你好", client_token: "private" }))));
    const rendered = formatCapturedBody(body);
    expect(rendered).toContain("你好");
    expect(rendered).not.toContain("private");
  });

  it("redacts credentials embedded in error text", () => {
    expect(safeLogText("authorization=Bearer abcdef")).not.toContain("abcdef");
  });

  it("derives generation rate and cache hit rate from recorded metrics", () => {
    expect(calculateOutputTokenRate({ output_tokens: 90, ttft_ms: 500, duration_ms: 2_000 })).toBe(60);
    expect(calculateOutputTokenRate({ output_tokens: 90, ttft_ms: null, duration_ms: 2_000 })).toBeNull();
    expect(calculateCacheHitRate({ input_tokens: 1_000, input_cached_tokens: 750 })).toBe(0.75);
    expect(calculateCacheHitRate({ input_tokens: 1_000, input_cached_tokens: null })).toBeNull();
  });
});
