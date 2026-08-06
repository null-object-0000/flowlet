import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFlowletAi, FlowletAiError, flowletAiTextFromContent } from "./index";

/** 构建/测试时注入的版本号（来源 package.json），与 SDK User-Agent 用同一来源校验。 */
const pkgVersion = __FLOWLET_APP_VERSION__;

/** 构造一个按条产出 SSE 事件的 Response 对象。 */
function sseResponse(dataLines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of dataLines) controller.enqueue(encoder.encode(`${line}\n\n`));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const deltaChunk = (part: Record<string, unknown>) =>
  `data: ${JSON.stringify({ choices: [{ delta: part }] })}`;

describe("flowletAiTextFromContent", () => {
  it("extracts plain strings unchanged", () => {
    expect(flowletAiTextFromContent("你好")).toBe("你好");
  });

  it("joins multi-part text arrays", () => {
    expect(
      flowletAiTextFromContent([
        { type: "text", text: "你好" },
        { type: "text", text: "世界" },
      ]),
    ).toBe("你好世界");
  });

  it("reads a single { text } object", () => {
    expect(flowletAiTextFromContent({ text: "你好" })).toBe("你好");
  });

  it("returns empty string for unreadable content", () => {
    expect(flowletAiTextFromContent(null)).toBe("");
    expect(flowletAiTextFromContent(undefined)).toBe("");
    expect(flowletAiTextFromContent(42)).toBe("");
    expect(flowletAiTextFromContent([])).toBe("");
  });
});

describe("createFlowletAi().chatCompletionsStream", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it("yields parsed chunks from an SSE stream and stops at [DONE]", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        deltaChunk({ content: "你" }),
        deltaChunk({ content: "好" }),
        "data: [DONE]",
      ]),
    );

    const ai = createFlowletAi({ baseUrl: "http://127.0.0.1:18640" });
    const pieces: string[] = [];
    for await (const chunk of ai.chatCompletionsStream({ model: "flowlet-flash", messages: [{ role: "user", content: "hi" }] })) {
      pieces.push(flowletAiTextFromContent(chunk.choices?.[0]?.delta?.content));
    }
    expect(pieces).toEqual(["你", "好"]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:18640/v1/chat/completions");
    const body = JSON.parse(String(init.body)) as { stream: boolean };
    expect(body.stream).toBe(true);
  });

  it("reads delta.message when a service does not emit delta", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ message: { content: "来自 message 字段" } }] })}`,
        "data: [DONE]",
      ]),
    );

    const ai = createFlowletAi({ baseUrl: "http://127.0.0.1:18640" });
    const texts: string[] = [];
    for await (const chunk of ai.chatCompletionsStream({ model: "m", messages: [] })) {
      const choice = chunk.choices?.[0];
      const text = flowletAiTextFromContent(choice?.delta?.content) || flowletAiTextFromContent(choice?.message?.content);
      if (text) texts.push(text);
    }
    expect(texts).toEqual(["来自 message 字段"]);
  });

  it("sends Authorization only when apiKey is provided", async () => {
    fetchMock.mockResolvedValue(sseResponse([deltaChunk({ content: "ok" }), "data: [DONE]"]));
    const ai = createFlowletAi({ baseUrl: "http://127.0.0.1:18640", apiKey: "sk-test" });
    for await (const _ of ai.chatCompletionsStream({ model: "m", messages: [] })) { /* consume */ }
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");

    fetchMock.mockResolvedValue(sseResponse([deltaChunk({ content: "ok" }), "data: [DONE]"]));
    const anonymous = createFlowletAi({ baseUrl: "http://127.0.0.1:18640" });
    for await (const _ of anonymous.chatCompletionsStream({ model: "m", messages: [] })) { /* consume */ }
    const headers2 = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(headers2.Authorization).toBeUndefined();
  });

  it("calls the global fetch with globalThis as its receiver (avoids Illegal invocation)", async () => {
    fetchMock.mockResolvedValue(sseResponse([deltaChunk({ content: "ok" }), "data: [DONE]"]));
    const ai = createFlowletAi({ baseUrl: "http://127.0.0.1:18640" });
    for await (const _ of ai.chatCompletionsStream({ model: "m", messages: [] })) { /* consume */ }
    // 解绑后以自由函数调用 fetch 会丢 this 抛 "Illegal invocation"；
    // 客户端必须绑定 globalThis 作为接收者。
    expect(fetchMock.mock.contexts[0]).toBe(globalThis);
  });

  it("sends built-in Flowlet identity headers with the real version by default", async () => {
    fetchMock.mockResolvedValue(sseResponse([deltaChunk({ content: "ok" }), "data: [DONE]"]));
    const ai = createFlowletAi({ baseUrl: "http://127.0.0.1:18640" });
    for await (const _ of ai.chatCompletionsStream({ model: "m", messages: [] })) { /* consume */ }
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:18640/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    // User-Agent 版本号必须来自 package.json，而不是写死的常量。
    expect(headers["User-Agent"]).toBe(`Flowlet/${pkgVersion}`);
    expect(headers["x-flowlet-client"]).toBe("Flowlet");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("lets callers override the built-in identity headers and normalizes a trailing slash", async () => {
    fetchMock.mockResolvedValue(sseResponse([deltaChunk({ content: "ok" }), "data: [DONE]"]));
    const ai = createFlowletAi({
      baseUrl: "http://127.0.0.1:18640/",
      headers: { "x-flowlet-client": "Custom" },
    });
    for await (const _ of ai.chatCompletionsStream({ model: "m", messages: [] })) { /* consume */ }
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:18640/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(`Flowlet/${pkgVersion}`);
    expect(headers["x-flowlet-client"]).toBe("Custom");
  });

  it("throws FlowletAiError with the HTTP status on non-2xx", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 } as unknown as Response);
    const ai = createFlowletAi({ baseUrl: "http://127.0.0.1:18640" });
    let caught: unknown = null;
    try {
      for await (const _ of ai.chatCompletionsStream({ model: "m", messages: [] })) { /* consume */ }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FlowletAiError);
    expect((caught as FlowletAiError).status).toBe(502);
  });

  it("throws a readable error when the stream body is missing", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: null } as unknown as Response);
    const ai = createFlowletAi({ baseUrl: "http://127.0.0.1:18640" });
    await expect(
      (async () => {
        for await (const _ of ai.chatCompletionsStream({ model: "m", messages: [] })) { /* consume */ }
      })(),
    ).rejects.toThrow("未返回流式响应");
  });

  it("ignores unparseable SSE fragments and keeps consuming", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        "data: not-json",
        deltaChunk({ content: "好" }),
        "data: [DONE]",
      ]),
    );
    const ai = createFlowletAi({ baseUrl: "http://127.0.0.1:18640" });
    const pieces: string[] = [];
    for await (const chunk of ai.chatCompletionsStream({ model: "m", messages: [] })) {
      pieces.push(flowletAiTextFromContent(chunk.choices?.[0]?.delta?.content));
    }
    expect(pieces).toEqual(["好"]);
  });

  it("handles the final SSE event without a trailing blank line", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(deltaChunk({ content: "结尾" })));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200, body } as unknown as Response);
    const ai = createFlowletAi({ baseUrl: "http://127.0.0.1:18640" });
    const pieces: string[] = [];
    for await (const chunk of ai.chatCompletionsStream({ model: "m", messages: [] })) {
      pieces.push(flowletAiTextFromContent(chunk.choices?.[0]?.delta?.content));
    }
    expect(pieces).toEqual(["结尾"]);
  });
});

describe("createFlowletAi().chatCompletions", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it("posts with stream:false and returns the parsed completion", async () => {
    const completion = { id: "cmpl-1", choices: [{ message: { role: "assistant", content: "你好" }, finish_reason: "stop" }] };
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => completion } as unknown as Response);

    const ai = createFlowletAi({ baseUrl: "http://127.0.0.1:18640", apiKey: "sk-test" });
    const result = await ai.chatCompletions({ model: "flowlet-flash", messages: [{ role: "user", content: "hi" }] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).stream).toBe(false);
    expect(result).toEqual(completion);
  });
});
