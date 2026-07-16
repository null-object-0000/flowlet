import { describe, expect, it } from "vitest";
import { formatCapturedBody, formatCapturedJson, safeLogText } from "./logPresentation";

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
});
