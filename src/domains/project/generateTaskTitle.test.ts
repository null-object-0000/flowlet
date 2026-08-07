import { beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_TITLE_GENERATION_DESCRIPTION_LENGTH, canAutoGenerateTaskTitle, generateTaskTitle, type TitleGenerationProgress } from "./generateTaskTitle";

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

/** 构造一个返回 SSE 流的 Response 对象。 */
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

const delta = (part: { content?: string; reasoning_content?: string }) =>
  `data: ${JSON.stringify({ choices: [{ delta: part }] })}`;

describe("generateTaskTitle", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it("streams, does not set max_tokens, and returns the extracted title", async () => {
    fetchMock.mockResolvedValue(sseResponse([
      delta({ content: '{"title": "修复登录页空' }),
      delta({ content: '白"}' }),
      "data: [DONE]",
    ]));

    const title = await generateTaskTitle({
      baseUrl: "http://127.0.0.1:18640",
      clientToken: "sk-test",
      description: "修复登录页在窄屏下出现空白的问题",
      taskType: "code",
    });

    expect(title).toBe("修复登录页空白");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:18640/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    // 请求日志识别为 Flowlet：User-Agent 命中 ua_rules 的 "Flowlet/"，标记头兜底。
    expect(headers["User-Agent"]).toMatch(/^Flowlet\//);
    expect(headers["x-flowlet-client"]).toBe("Flowlet");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      max_tokens?: number;
      stream: boolean;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("flowlet-flash");
    expect(body.stream).toBe(true);
    // 不设 max_tokens，避免推理类模型被截断。
    expect(body.max_tokens).toBeUndefined();
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[1].content).toContain("代码修改");
  });

  it("accumulates reasoning_content from a reasoning model and reports live progress", async () => {
    const progress: TitleGenerationProgress[] = [];
    fetchMock.mockResolvedValue(sseResponse([
      delta({ reasoning_content: "\n1. **分析任务**\n" }),
      delta({ reasoning_content: '{"title": "优化父任务信息展示与关联任务交互"}' }),
      "data: [DONE]",
    ]));

    const title = await generateTaskTitle(
      { baseUrl: "http://127.0.0.1:18640", clientToken: null, description: "分状态任务列表里展示父任务信息，改为展示父任务 id", taskType: "code" },
      (p) => progress.push(p),
    );

    expect(title).toBe("优化父任务信息展示与关联任务交互");
    // 进度回调随流式输出逐步回报，且 token 估算递增。
    expect(progress.length).toBeGreaterThan(1);
    expect(progress[progress.length - 1].elapsedMs).toBeGreaterThanOrEqual(0);
    expect(progress[progress.length - 1].tokenEstimate).toBeGreaterThan(0);
  });

  it("parses content returned as an array of text parts", async () => {
    fetchMock.mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: [{ type: "text", text: "梳理请求日志链路" }] } }] })}`,
      "data: [DONE]",
    ]));

    const title = await generateTaskTitle({ baseUrl: "http://127.0.0.1:18640", clientToken: null, description: "梳理请求日志的存储与查询链路", taskType: "readonly" });
    expect(title).toBe("梳理请求日志链路");
  });

  it("extracts the title from reasoning text that ends with the JSON title", async () => {
    fetchMock.mockResolvedValue(sseResponse([
      delta({ reasoning_content: "\n1. 分析任务要求\n2. 草拟标题\n候选：开发 Flowlet 内置 AI SDK 统一前端 LLM API 调用\n" }),
      delta({ reasoning_content: '最终输出：{"title": "开发 Flowlet 内置 AI SDK 统一前端 LLM 调用"}' }),
      "data: [DONE]",
    ]));

    const title = await generateTaskTitle({ baseUrl: "http://127.0.0.1:18640", clientToken: null, description: "开发 Flowlet 前端内置 AI SDK，统一前端 LLM API 调用", taskType: "code" });
    expect(title).toBe("开发 Flowlet 内置 AI SDK 统一前端 LLM 调用");
  });

  it("accepts a structured title containing task description wording", async () => {
    fetchMock.mockResolvedValue(sseResponse([
      delta({ content: '{"title": "调整任务描述框高度并移除前端优先级"}' }),
      "data: [DONE]",
    ]));

    const title = await generateTaskTitle({ baseUrl: "http://127.0.0.1:18640", clientToken: null, description: "调整新建任务中的任务描述框高度，并移除前端优先级功能", taskType: "code" });
    expect(title).toBe("调整任务描述框高度并移除前端优先级");
  });

  it("throws when the model streams only an implausibly long title", async () => {
    fetchMock.mockResolvedValue(sseResponse([
      delta({ reasoning_content: "这是一段很长的推理过程，它没有包含任何可用的标题字段，只是把任务描述里的内容原样复述了很多遍，导致整体长度远超标题合理范围，因此应该被判定为无有效标题并抛出错误。" }),
      "data: [DONE]",
    ]));
    await expect(generateTaskTitle({ baseUrl: "http://127.0.0.1:18640", clientToken: null, description: "梳理当前请求日志的存储与查询链路", taskType: "readonly" }))
      .rejects.toThrow("模型未返回有效标题");
  });

  it("omits the Authorization header when no client token is provided", async () => {
    fetchMock.mockResolvedValue(sseResponse([delta({ content: '{"title": "梳理接口耗时"}' }), "data: [DONE]"]));

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

  it("throws when the proxy returns no streaming body", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: null } as unknown as Response);
    await expect(generateTaskTitle({ baseUrl: "http://127.0.0.1:18640", clientToken: null, description: "整理当前项目的目录结构说明", taskType: "readonly" }))
      .rejects.toThrow("未返回流式响应");
  });
});
