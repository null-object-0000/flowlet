import {
  createFlowletAi,
  FlowletAiError,
  flowletAiTextFromContent,
  type FlowletAiChatCompletionRequest,
} from "../../shared/llm";
import type { ProjectTaskType } from "./types";

/** 自动生成任务标题所需的最小任务描述字数（去除首尾空白后）。 */
export const MIN_TITLE_GENERATION_DESCRIPTION_LENGTH = 10;

/** 标题生成的总时限；超时后主动中断流式请求，避免推理模型持续消耗 Token。 */
export const TASK_TITLE_GENERATION_TIMEOUT_MS = 30_000;

/** 任务描述为空或过短时，不支持自动生成任务标题。 */
export function canAutoGenerateTaskTitle(description: string): boolean {
  return description.trim().length >= MIN_TITLE_GENERATION_DESCRIPTION_LENGTH;
}

/** 流式生成过程中的实时进度，供 UI 缓解等待焦虑（展示在任务标题名称右侧）。 */
export type TitleGenerationProgress = {
  /** 已累计的模型输出文本（推理类模型含 reasoning_content 推理过程）。 */
  text: string;
  /** 粗略估算的已输出 token 数。 */
  tokenEstimate: number;
  /** 自请求发起以来经过的时间（毫秒）。 */
  elapsedMs: number;
};

export type TitleGenerationProgressHandler = (progress: TitleGenerationProgress) => void;

type GenerateTaskTitleInput = {
  /** 本地代理 Base URL，如 `http://127.0.0.1:18640`。 */
  baseUrl: string;
  /** 客户端 Token，用于本地代理鉴权归属（可选，缺失时仍可路由到上游）。 */
  clientToken: string | null | undefined;
  description: string;
  taskType: ProjectTaskType;
};

/**
 * 调用本地代理的 flowlet-flash 模型，基于任务描述与任务类型自动生成任务标题。
 *
 * 请求路由由本地代理完成（flowlet-flash 是聚合模型，无单一上游）。Flowlet 身份
 * 标记头（`User-Agent: Flowlet/…` 与 `x-flowlet-client`）由内置 flowlet-ai SDK
 * 默认携带，使请求日志识别为 Flowlet；LLM 请求经 `src/shared/llm` 发起，与前端
 * 其它 LLM 调用共用同一套请求/流式解析逻辑。
 *
 * 采用**流式调用**（`stream: true`）并**不设 max_tokens**，避免推理类模型（如
 * LongCat-2.0）在输出完成前被 token 上限截断（`finish_reason: "length"`）。整次调用
 * 受 30 秒总时限约束，超时会主动中断请求；流式过程中通过 `onProgress` 回调把已累计
 * 输出文本、token 估算与耗时实时回报给 UI。
 *
 * 用 `response_format: { type: "json_object" }` 约束模型结构化输出 `{"title": "…"}`；
 * 解析时同时兼容普通 `content` 与推理类模型的 `reasoning_content`（推理模型可能把
 * 结构化结果放在该字段，或把它放在推理过程末尾）。拿不到有效标题或上游调用失败时
 * 直接抛出用户可读错误，不做任何兜底。
 * 前置条件：已经校验 `canAutoGenerateTaskTitle(description)`。
 */
export async function generateTaskTitle(
  input: GenerateTaskTitleInput,
  onProgress?: TitleGenerationProgressHandler,
): Promise<string> {
  const { baseUrl, clientToken, description, taskType } = input;
  const taskTypeLabel = taskType === "code" ? "代码修改" : "只读分析";
  const request = buildChatRequest(taskTypeLabel, description);

  const ai = createFlowletAi({
    baseUrl,
    apiKey: clientToken,
  });
  const abortController = new AbortController();
  const timeoutId = globalThis.setTimeout(
    () => abortController.abort(),
    TASK_TITLE_GENERATION_TIMEOUT_MS,
  );

  // SDK 抛出的真实错误（HTTP / 网络 / 缺失流式响应体）统一转换为用户可读文案。
  let text: string;
  try {
    text = await streamAccumulate(ai, request, abortController.signal, onProgress);
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error(`标题生成超时（${TASK_TITLE_GENERATION_TIMEOUT_MS / 1000} 秒），请重试`);
    }
    if (error instanceof FlowletAiError) {
      if (error.status != null && error.status >= 400) {
        throw new Error(`标题生成失败（HTTP ${error.status}）`);
      }
      throw new Error(`标题生成失败：${error.message}`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }

  const title = extractTitle(text);
  if (title && isPlausibleTitle(title)) {
    return title;
  }
  throw new Error("标题生成失败：模型未返回有效标题，请重试");
}

/** 组装发给本地代理的 chat completions 请求：JSON 结构化输出 + 流式，不设 max_tokens。 */
function buildChatRequest(taskTypeLabel: string, description: string): FlowletAiChatCompletionRequest {
  return {
    model: "flowlet-flash",
    messages: [
      {
        role: "system",
        content:
          "你是任务标题生成助手。用 JSON 输出任务标题，格式为 {\"title\": \"简短准确的中文标题\"}。要求：标题一句话、不超过 30 字；不要回显或复述任务描述。只输出 JSON，不要输出任何其他内容。",
      },
      {
        role: "user",
        content: `请为下面的任务生成一个简短准确的任务标题。\n\n任务类型：${taskTypeLabel}\n任务描述：${description.trim()}\n\n用 JSON 输出：{"title": "标题"}`,
      },
    ],
    // 推理类模型可能先输出较长推理过程再给出结果，因此不设 max_tokens 上限，
    // 避免在输出完成前被截断；对确定性任务置零温度。
    temperature: 0,
    stream: true,
    response_format: { type: "json_object" },
  };
}

/** 消费 SDK 流式 chunk，累积模型文本（content 与 reasoning_content 均计入）。 */
async function streamAccumulate(
  ai: ReturnType<typeof createFlowletAi>,
  request: FlowletAiChatCompletionRequest,
  signal: AbortSignal,
  onProgress?: TitleGenerationProgressHandler,
): Promise<string> {
  const startedAt = Date.now();
  let accumulated = "";

  const emit = (piece: string) => {
    if (!piece) return;
    accumulated += piece;
    onProgress?.({
      text: accumulated,
      tokenEstimate: estimateTokens(accumulated),
      elapsedMs: Date.now() - startedAt,
    });
  };

  for await (const chunk of ai.chatCompletionsStream(request, { signal })) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? choice.message;
    if (!delta) continue;
    const piece =
      extractTextContent(delta.content) ?? extractTextContent(delta.reasoning_content) ?? "";
    emit(piece);
  }
  return accumulated;
}

/** 从模型 message 字段中提取纯文本：兼容字符串、内容分片数组与 { text } 对象。 */
function extractTextContent(content: unknown): string | null {
  const text = flowletAiTextFromContent(content).trim();
  return text || null;
}

/** 从模型累计文本中提取标题：整段为 JSON 时读 `title` 字段；否则从推理文本末尾找 `"title"` 字段。 */
function extractTitle(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const whole = titleFromJsonObject(trimmed);
    if (whole) return whole;
  }
  // 推理类模型可能把最终 JSON 放在推理过程末尾，取最后一个 "title" 字段。
  const matches = [...trimmed.matchAll(/"title"\s*:\s*"([^"]*)"/g)];
  if (matches.length > 0) {
    const cleaned = cleanTitle(matches[matches.length - 1][1]);
    return cleaned || null;
  }
  // 若模型直接输出纯文本标题（未走 JSON），也接受；合理性仍由 isPlausibleTitle 把关。
  const cleaned = cleanTitle(trimmed);
  return cleaned || null;
}

/** 尝试把整段内容当作 JSON 对象解析并读取标题字段。 */
function titleFromJsonObject(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    const candidate =
      typeof parsed === "string"
        ? parsed
        : parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>).title
            ?? (parsed as Record<string, unknown>).name
            ?? (parsed as Record<string, unknown>).result
          : undefined;
    if (typeof candidate === "string") {
      const cleaned = cleanTitle(candidate);
      return cleaned || null;
    }
  } catch {
    // 非法 JSON，忽略。
  }
  return null;
}

/** 标题合理性校验：只限制极端超长结果，内容本身交由 JSON 结构化输出约束。 */
function isPlausibleTitle(title: string): boolean {
  if (title.length > 60) return false;
  return true;
}

/** 粗略估算已输出文本的 token 数：中文每字约 1 token，其余字符约每 4 字符 1 token。 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    if (/[一-鿿]/.test(ch)) cjk++;
  }
  const other = text.length - cjk;
  return Math.ceil(cjk + other / 4);
}

/** 清理标题文本：去掉包裹的引号、首尾句号与多余空白。 */
function cleanTitle(raw: string): string {
  let title = raw.trim().replace(/[。．.!！?？…]+$/g, "").trim();
  const quoteChars = ['"', "'", "“", "”", "‘", "’", "「", "」", "『", "』"];
  while (
    title.length > 0 &&
    quoteChars.includes(title.charAt(0)) &&
    quoteChars.includes(title.charAt(title.length - 1))
  ) {
    title = title.slice(1, -1).trim();
  }
  title = title.replace(/[。．.!！?？…]+$/g, "").trim();
  return title;
}
