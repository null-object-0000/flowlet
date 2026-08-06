/**
 * flowlet-ai 内置 SDK 的 OpenAI-compatible 类型定义。
 *
 * 第一版只支持 OpenAI Chat Completions 协议；Anthropic / Responses 等协议
 * 后续按需扩展。类型采用「核心字段 + 透传索引」设计：模型方新增的扩展字段
 * （如 `reasoning_content`、`thinking`）不会被类型抹掉，消费者可安全读取。
 */

/** Chat 消息角色。 */
export type FlowletAiChatRole = "system" | "user" | "assistant" | "tool";

/** 消息内容：字符串，或 OpenAI 多段内容数组（如 `[{ type: "text", text }]`）。 */
export type FlowletAiChatMessageContent =
  | string
  | ReadonlyArray<{ type: string; text?: string; [key: string]: unknown }>;

export interface FlowletAiChatMessage {
  role: FlowletAiChatRole;
  content: FlowletAiChatMessageContent;
}

/** OpenAI-compatible chat completion 请求体。未知字段原样透传。 */
export interface FlowletAiChatCompletionRequest {
  model: string;
  messages: FlowletAiChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  response_format?: { type: "text" | "json_object" };
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  tools?: ReadonlyArray<Record<string, unknown>>;
  tool_choice?: unknown;
  [key: string]: unknown;
}

/** 流式 chunk 中单个 choice 的增量字段（`delta` 或 `message`）。 */
export interface FlowletAiChatChunkDelta {
  role?: FlowletAiChatRole;
  /** 文本内容；兼容字符串 / 多段内容数组 / `{ text }` 对象。 */
  content?: unknown;
  /** 推理类模型（如 DeepSeek Reasoner 系）的推理过程字段，非 OpenAI 标准字段。 */
  reasoning_content?: unknown;
  refusal?: unknown;
  tool_calls?: unknown;
  [key: string]: unknown;
}

export interface FlowletAiChatChunkChoice {
  index?: number;
  /** 流式增量：OpenAI 标准为 `delta`；部分兼容服务使用 `message`。 */
  delta?: FlowletAiChatChunkDelta;
  message?: FlowletAiChatChunkDelta;
  finish_reason?: string | null;
}

export interface FlowletAiChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** 流式 chat completion 的一个 chunk。 */
export interface FlowletAiChatChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: FlowletAiChatChunkChoice[];
  usage?: FlowletAiChatUsage;
  [key: string]: unknown;
}

/** 非流式 chat completion 的完整响应。 */
export interface FlowletAiChatCompletion {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: Array<{
    index?: number;
    message?: FlowletAiChatChunkDelta;
    finish_reason?: string | null;
  }>;
  usage?: FlowletAiChatUsage;
  [key: string]: unknown;
}
