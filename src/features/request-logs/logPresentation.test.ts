import { describe, expect, it } from "vitest";
import { calculateCacheHitRate, calculateOutputTokenRate, formatCapturedBody, formatCapturedJson, formatDuration, safeLogText } from "./logPresentation";

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
});
