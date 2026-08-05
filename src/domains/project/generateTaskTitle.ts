import type { ProjectTaskType } from "./types";

/** 自动生成任务标题所需的最小任务描述字数（去除首尾空白后）。 */
export const MIN_TITLE_GENERATION_DESCRIPTION_LENGTH = 10;

/** 标题生成请求携带的 Flowlet 专属 User-Agent，使请求日志按 config.json 的
 *  `ua_rules`（`pattern: "Flowlet/"`）识别客户端为 Flowlet。 */
const FLOWLET_USER_AGENT = "Flowlet/0.1.0";

/** 任务描述为空或过短时，不支持自动生成任务标题。 */
export function canAutoGenerateTaskTitle(description: string): boolean {
  return description.trim().length >= MIN_TITLE_GENERATION_DESCRIPTION_LENGTH;
}

type GenerateTaskTitleInput = {
  /** 本地代理 Base URL，如 `http://127.0.0.1:18640`。 */
  baseUrl: string;
  /** 客户端 Token，用于本地代理鉴权归属（可选，缺失时仍可路由到上游）。 */
  clientToken: string | null | undefined;
  description: string;
  taskType: ProjectTaskType;
};

type ChatRequest = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens: number;
  temperature: number;
  stream: boolean;
  response_format: { type: string };
};

/**
 * 调用本地代理的 flowlet-flash 模型，基于任务描述与任务类型自动生成任务标题。
 *
 * 请求路由由本地代理完成（flowlet-flash 是聚合模型，无单一上游）；请求通过
 * `User-Agent: Flowlet/…` 与 `x-flowlet-client` 标记头让请求日志识别为 Flowlet。
 *
 * 用 `response_format: { type: "json_object" }` 约束模型**结构化输出**，要求返回
 * `{"title": "…"}`，从根上避免模型回显自由文本或请求体：
 * 1. 主路径：JSON 输出，解析 `title` 字段；无有效 `title`（含回显/非法 JSON）即失败；
 * 2. 首轮失败时用更强调「必须输出 JSON」的提示词重试一次；
 * 3. 仍失败则回退到从任务描述提取的可读标题，保证功能始终可用。
 *
 * 真实错误（代理未运行、上游 4xx/5xx、网络失败、上游返回 error 体）会直接抛出，
 * 不回退掩盖。
 * 前置条件：已经校验 `canAutoGenerateTaskTitle(description)`。
 */
export async function generateTaskTitle(input: GenerateTaskTitleInput): Promise<string> {
  const { baseUrl, clientToken, description, taskType } = input;
  const taskTypeLabel = taskType === "code" ? "代码修改" : "只读分析";
  const requests = [
    buildChatRequest(taskTypeLabel, description, false),
    buildChatRequest(taskTypeLabel, description, true),
  ];

  for (const request of requests) {
    // 真实错误（HTTP / 网络 / 错误体）在此抛出，不进入重试与回退。
    const content = await callProxy(baseUrl, clientToken, request);
    if (content) {
      const title = extractTitle(content);
      if (title && isPlausibleTitle(title)) {
        return title;
      }
    }
  }

  // 模型仍不可靠（回显 / 非 JSON / 无 title），回退到从描述生成的可读标题。
  return fallbackTitle(description);
}

/** 组装发给本地代理的 chat completions 请求：JSON 结构化输出，`retry=true` 时更强调整必须 JSON。 */
function buildChatRequest(taskTypeLabel: string, description: string, retry: boolean): ChatRequest {
  const system = retry
    ? "你是任务标题生成助手。必须用 JSON 输出任务标题，格式为 {\"title\": \"简短准确的中文标题\"}。要求：标题一句话、不超过 30 字；不要回显或复述任务描述。只输出一个 JSON 对象，不要输出任何 JSON 之外的纯文本、解释或请求体。"
    : "你是任务标题生成助手。用 JSON 输出任务标题，格式为 {\"title\": \"简短准确的中文标题\"}。要求：标题一句话、不超过 30 字；不要回显或复述任务描述。只输出 JSON，不要输出任何其他内容。";
  return {
    model: "flowlet-flash",
    messages: [
      { role: "system", content: system },
      { role: "user", content: `请为下面的任务生成一个简短准确的任务标题。\n\n任务类型：${taskTypeLabel}\n任务描述：${description.trim()}\n\n用 JSON 输出：{"title": "标题"}` },
    ],
    // 给足 token 并对推理类模型置零温度，降低被截断 / 变体输出导致回显的概率。
    max_tokens: 512,
    temperature: 0,
    stream: false,
    response_format: { type: "json_object" },
  };
}

/** 发起一次请求并取回模型文本内容；HTTP / 网络 / 错误体时抛出，无有效文本返回 null。 */
async function callProxy(baseUrl: string, clientToken: string | null | undefined, request: ChatRequest): Promise<string | null> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": FLOWLET_USER_AGENT,
      // 标记头兜底：部分 WebView 会强制剥离 fetch 的 User-Agent，标记头保证日志识别；
      // 代理会在识别后、转发上游前剥离该头，不向外泄露。
      "x-flowlet-client": "Flowlet",
      ...(clientToken ? { Authorization: `Bearer ${clientToken}` } : {}),
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(`标题生成失败（HTTP ${response.status}）`);
  }
  const data = (await response.json()) as {
    error?: { message?: unknown };
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  if (data.error) {
    throw new Error(`标题生成失败：${typeof data.error.message === "string" ? data.error.message : "模型返回错误"}`);
  }
  return extractTextContent(data.choices?.[0]?.message?.content);
}

/** 从模型 message.content 中提取纯文本：兼容字符串、内容分片数组与 { text } 对象。 */
function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string") return text;
        }
        return "";
      })
      .join("")
      .trim();
    return text || null;
  }
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text.trim() || null;
  }
  return null;
}

/** 从模型文本中提取标题：JSON 输出时严格读取 `title` 字段，无有效 title 返回 null。 */
function extractTitle(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
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
      return null; // 是 JSON 但没有可用标题字段（如回显的请求体）
    } catch {
      return null; // 非法 JSON，视为失败
    }
  }
  const cleaned = cleanTitle(trimmed);
  return cleaned || null;
}

/** 标题合理性校验：排除回显、超长等异常内容（对不走 JSON 的纯文本输出兜底）。 */
function isPlausibleTitle(title: string): boolean {
  if (title.length > 60) return false;
  if (/messages|"model"\s*:|任务类型|任务描述/.test(title)) return false;
  return true;
}

/** 模型不可靠时的回退标题：取任务描述的第一句（按常见标点切分），截断到 30 字。 */
function fallbackTitle(description: string): string {
  const first = description
    .split(/[\n\r,，。、；;.!！?？]+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .find((s) => s.length > 0);
  const base = (first ?? description.trim()) || "新任务";
  return base.length > 30 ? `${base.slice(0, 30)}…` : base;
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