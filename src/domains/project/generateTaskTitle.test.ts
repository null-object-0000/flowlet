import { beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_TITLE_GENERATION_DESCRIPTION_LENGTH, canAutoGenerateTaskTitle, generateTaskTitle } from "./generateTaskTitle";

describe("canAutoGenerateTaskTitle", () => {
  it("rejects empty or whitespace-only descriptions", () => {
    expect(canAutoGenerateTaskTitle("")).toBe(false);
    expect(canAutoGenerateTaskTitle("   ")).toBe(false);
  });

  it("rejects descriptions shorter than the minimum length", () => {
    expect(canAutoGenerateTaskTitle("字".repeat(MIN_TITLE_GENERATION_DESCRIPTION_LENGTH - 1))).toBe(false);
  });

  it("accepts descriptions at or above the minimum length (ignoring surrounding whitespace)", () => {
    expect(canAutoGenerateTaskTitle("字".repeat(MIN_TITLE_GENERATION_DESCRIPTION_LENGTH))).toBe(true);
    expect(canAutoGenerateTaskTitle(`  ${"字".repeat(MIN_TITLE_GENERATION_DESCRIPTION_LENGTH)}  `)).toBe(true);
  });
});

describe("generateTaskTitle", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it("requests JSON output once and returns the extracted title", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"title": "修复登录页空白"}' } }] }),
    });

    const title = await generateTaskTitle({
      baseUrl: "http://127.0.0.1:18640",
      clientToken: "sk-test",
      description: "修复登录页在窄屏下出现空白的问题",
      taskType: "code",
    });

    expect(title).toBe("修复登录页空白");
    // 单次请求，不做重试。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:18640/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    // 请求日志识别为 Flowlet：User-Agent 命中 ua_rules 的 "Flowlet/"，标记头兜底。
    expect(headers["User-Agent"]).toMatch(/^Flowlet\//);
    expect(headers["x-flowlet-client"]).toBe("Flowlet");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("flowlet-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[1].content).toContain("代码修改");
  });

  it("reads the title from reasoning_content when content is empty (reasoning model)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: "assistant",
            content: "",
            reasoning_content: '{  "title": "优化父任务信息展示与关联任务交互"  }',
          },
        }],
      }),
    });

    const title = await generateTaskTitle({ baseUrl: "http://127.0.0.1:18640", clientToken: null, description: "分状态任务列表里展示父任务信息，改为展示父任务 id", taskType: "code" });
    expect(title).toBe("优化父任务信息展示与关联任务交互");
  });

  it("parses content returned as an array of text parts", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: [{ type: "text", text: "梳理请求日志链路" }] } }] }),
    });

    const title = await generateTaskTitle({ baseUrl: "http://127.0.0.1:18640", clientToken: null, description: "梳理请求日志的存储与查询链路", taskType: "readonly" });
    expect(title).toBe("梳理请求日志链路");
  });

  it("throws when the model echoes the request body instead of a title (no retry)", async () => {
    const echo = JSON.stringify({
      model: "LongCat-2.0",
      messages: [{ role: "system", content: "你是任务标题生成助手" }],
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: echo } }] }) });

    await expect(generateTaskTitle({ baseUrl: "http://127.0.0.1:18640", clientToken: null, description: "分状态任务列表里展示父任务信息，改为展示父任务 id", taskType: "code" }))
      .rejects.toThrow("模型未返回有效标题");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when the model returns no usable content", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) });
    await expect(generateTaskTitle({ baseUrl: "http://127.0.0.1:18640", clientToken: null, description: "梳理当前请求日志的存储与查询链路", taskType: "readonly" }))
      .rejects.toThrow("模型未返回有效标题");
  });

  it("treats JSON without a usable title field as a failure", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '{"foo": "bar"}' } }] }) });
    await expect(generateTaskTitle({ baseUrl: "http://127.0.0.1:18640", clientToken: null, description: "整理当前项目的目录结构说明", taskType: "readonly" }))
      .rejects.toThrow("模型未返回有效标题");
  });

  it("omits the Authorization header when no client token is provided", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '{"title": "梳理接口耗时"}' } }] }) });

    await generateTaskTitle({ baseUrl: "http://127.0.0.1:18640", clientToken: null, description: "整理 dashboard 上报接口的耗时数据", taskType: "readonly" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("throws a readable error when the proxy responds with a non-2xx status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 });
    await expect(generateTaskTitle({ baseUrl: "http://127.0.0.1:18640", clientToken: null, description: "检查 nginx 日志中 5xx 的分布情况", taskType: "readonly" }))
      .rejects.toThrow("HTTP 502");
  });

  it("throws a readable error when the proxy returns an error body", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ error: { message: "insufficient_quota" } }) });
    await expect(generateTaskTitle({ baseUrl: "http://127.0.0.1:18640", clientToken: null, description: "整理当前项目的目录结构说明", taskType: "readonly" }))
      .rejects.toThrow("insufficient_quota");
  });
});