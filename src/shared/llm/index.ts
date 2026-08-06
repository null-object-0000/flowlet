/**
 * flowlet-ai 内置 SDK。
 *
 * 供 Flowlet 前端内部公共调用 LLM API 使用，第一版只支持 OpenAI-compatible
 * （OpenAI Chat Completions）。前端所有直连 LLM API 的调用都应通过本 SDK 发起，
 * 而不是各自手写 fetch + SSE 解析。
 *
 * 用法：
 * ```ts
 * import { createFlowletAi } from "../../shared/llm";
 *
 * const ai = createFlowletAi({
 *   baseUrl: "http://127.0.0.1:18640",
 *   apiKey: clientToken,
 *   headers: { "x-flowlet-client": "Flowlet" },
 * });
 *
 * // 非流式
 * const completion = await ai.chatCompletions({ model, messages });
 *
 * // 流式（SSE）
 * for await (const chunk of ai.chatCompletionsStream({ model, messages, stream: true })) {
 *   const piece = flowletAiTextFromContent(chunk.choices?.[0]?.delta?.content);
 * }
 * ```
 */
export {
  createFlowletAi,
  FlowletAiClient,
  FlowletAiError,
  FLOWLET_USER_AGENT,
  flowletAiTextFromContent,
} from "./client";
export type { FlowletAiClientOptions, FlowletAiFetch } from "./client";
export type {
  FlowletAiChatChunk,
  FlowletAiChatChunkChoice,
  FlowletAiChatChunkDelta,
  FlowletAiChatCompletion,
  FlowletAiChatCompletionRequest,
  FlowletAiChatMessage,
  FlowletAiChatMessageContent,
  FlowletAiChatRole,
  FlowletAiChatUsage,
} from "./types";
