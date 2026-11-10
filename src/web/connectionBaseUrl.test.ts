import { describe, expect, it } from "vitest";
import { pickConnectionBaseUrl } from "./connectionBaseUrl";

describe("pickConnectionBaseUrl", () => {
  it("按当前 origin 挑候选里的同名入口", () => {
    expect(
      pickConnectionBaseUrl(
        ["http://10.100.217.60:20135", "https://flowlet.example.com"],
        "http://10.100.217.60:20135",
        "https://flowlet.example.com",
      ),
    ).toBe("https://flowlet.example.com");
  });

  it("没有同名入口时用服务端默认值", () => {
    expect(
      pickConnectionBaseUrl(
        ["http://10.100.217.60:20135"],
        "http://10.100.217.60:20135",
        "http://127.0.0.1:8080",
      ),
    ).toBe("http://10.100.217.60:20135");
  });

  it("服务端没给默认值时退回第一条", () => {
    expect(
      pickConnectionBaseUrl(["http://a.example.com", "http://b.example.com"], undefined, "http://c.example.com"),
    ).toBe("http://a.example.com");
  });

  it("老服务端没有 base_urls 时行为不变", () => {
    expect(pickConnectionBaseUrl(undefined, "http://10.0.0.5:18640", "http://x")).toBe(
      "http://10.0.0.5:18640",
    );
  });

  it("忽略尾斜杠差异与空串", () => {
    expect(
      pickConnectionBaseUrl(["", "https://flowlet.example.com/"], "", "https://flowlet.example.com"),
    ).toBe("https://flowlet.example.com/");
  });
});
