// 「AI 生成环境前缀」：用已开放模型把名称/备注概括成一小段大写英文片段。Owner: node-web.
//
// 设计：
// - 只由管理台按钮显式触发（不随输入自动请求），因此每次生成 = 一次真实模型调用（会计费/写请求日志）；
// - 服务端只返回**片段**（如 `NA_PROD`），`{provider 默认前缀}_{片段}` 拼接与冲突避让仍由前端
//   同一套规则完成，保证 AI 结果与手写结果格式一致；
// - 服务端调本地模型入口（`FLOWLET_BIND_ADDR` 的 `/v1/chat/completions`），复用代理的路由、
//   日志与出口策略；浏览器永远拿不到渠道 Key；
// - 调用失败/模型不可用/输出不合规时抛可读错误，前端回退到规则建议。
import { CommandError } from "../types.ts";
import type { JsonRow } from "../types.ts";
import type { WebContext } from "./context.ts";

/** 片段只允许大写字母/数字/下划线，最多 20 字符（拼上默认前缀后仍 ≤24）。 */
const SEGMENT_PATTERN = /^[A-Z0-9_]{1,20}$/;
const MAX_INPUT_CHARS = 200;
const MODEL_TIMEOUT_MS = 20_000;
// 推理模型（deepseek-v4.x 等）会先输出 reasoning_content：预算太小会被截断成空 content，
// 因此这里给足 512 token（输出本身很短，成本可忽略）。
const MAX_TOKENS = 512;

/** 优先用轻量模型做这种短任务；找不到时退回第一个已开放模型。 */
const PREFERRED_MODEL = /flash|air|lightning|luna|terra|mini|small|haiku/i;

export interface EnvPrefixAiInput {
  provider: string;
  providerDefault: string;
  name: string;
  note?: string | null;
  /** 其它凭据已占用的前缀，避免生成重复片段。 */
  used?: string[];
}

export interface EnvPrefixAiResult {
  segment: string;
  model: string;
}

function trim(value: unknown, limit = MAX_INPUT_CHARS): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * 当前实例真正开放、且支持 OpenAI chat 的模型名（去重、保序）。
 *
 * 注意：`virtual_models` 表可能为空——对外模型实际由路由行（`virtual_model_routes`）
 * 的 `virtual_model_id` 决定，`/v1/models` 也是这么算的。因此优先取路由，再回退表。
 */
export function exposedModelNames(snapshot: JsonRow): string[] {
  const names: string[] = [];
  const push = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const name = raw.trim();
    if (name !== "" && !names.includes(name)) names.push(name);
  };
  const routes = Array.isArray(snapshot.routes) ? (snapshot.routes as JsonRow[]) : [];
  for (const route of routes) {
    if (route === null || typeof route !== "object") continue;
    if (route.enabled === false || route.enabled === 0) continue;
    const protocol = route.client_protocol;
    // 只选支持 OpenAI chat 的候选（本项目调用 /v1/chat/completions）。
    if (typeof protocol === "string" && protocol !== "" && protocol !== "openai") continue;
    push(route.virtual_model_id);
  }
  const models = Array.isArray(snapshot.virtual_models) ? (snapshot.virtual_models as JsonRow[]) : [];
  for (const model of models) {
    if (model === null || typeof model !== "object") continue;
    if (model.enabled === false || model.enabled === 0) continue;
    push(model.name);
  }
  return names;
}

/** 从开放模型里挑一个适合短任务的模型名；识别不到轻量模型时用第一个。 */
export function pickSuggestionModel(names: readonly string[]): string | null {
  const usable = names.map((name) => name.trim()).filter((name) => name !== "");
  if (usable.length === 0) return null;
  return usable.find((name) => PREFERRED_MODEL.test(name)) ?? usable[0]!;
}

const SYSTEM_PROMPT = [
  "你是环境变量命名助手。根据用户给出的「实例名称」和「备注」，输出一个用于区分同类服务不同实例的大写英文片段。",
  "要求：",
  "1. 只输出片段本身，可用字符为 A-Z、0-9、下划线；",
  "2. 1-3 个短词，总长不超过 20 个字符，例如 NA_PROD、SELF、STAGING；",
  "3. 用常见英文缩写表达语义：个人/自用=self，正式/生产=prod，测试=test，预发=staging，北美=na，欧洲=eu，新加坡=sg，日本=jp，自建=self；",
  "4. 不要输出解释、标点、反引号或代码块；",
  "5. 避免与用户给出的「已占用前缀」重复。",
].join("\n");

/** 把模型输出清洗成合法片段；无法清洗时返回 null（由调用方回退规则）。 */
export function parseSegment(raw: string): string | null {
  const text = raw
    .replace(/```[a-z]*\n?/gi, " ")
    .replace(/[`"'“”‘’]/g, " ")
    .toUpperCase();
  // 优先取第一个纯大写标识符；中文答案不会有匹配，自然回落规则。
  const match = /[A-Z][A-Z0-9_]{0,19}/.exec(text);
  if (match === null) return null;
  const segment = match[0].replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (segment === "" || !SEGMENT_PATTERN.test(segment)) return null;
  return segment;
}

function proxyBaseUrl(ctx: WebContext): string {
  const bind = ctx.proxy.bindConfig();
  const host = bind.host;
  const usableHost = host === "" || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${usableHost}:${bind.port}`;
}

/** 调本地模型入口；返回文本内容（错误含状态码，便于前端提示）。 */
async function callLocalModel(
  ctx: WebContext,
  model: string,
  userPrompt: string,
): Promise<string> {
  const url = `${proxyBaseUrl(ctx)}/v1/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ctx.clientToken}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: MAX_TOKENS,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CommandError(502, "command_failed", `调用模型失败：${detail}`);
  }
  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim().slice(0, 200);
    throw new CommandError(
      502,
      "command_failed",
      `模型返回 HTTP ${response.status}${detail === "" ? "" : `：${detail}`}`,
    );
  }
  let payload: JsonRow;
  try {
    payload = JSON.parse(text) as JsonRow;
  } catch {
    throw new CommandError(502, "command_failed", "模型返回的不是合法 JSON");
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new CommandError(502, "command_failed", "模型返回缺少 choices");
  }
  const message = (choices[0] as JsonRow).message;
  const content =
    message !== null && typeof message === "object" && typeof (message as JsonRow).content === "string"
      ? ((message as JsonRow).content as string)
      : "";
  return content;
}

/**
 * 生成环境前缀片段。管理鉴权命令（CLI token 作用域不允许）。
 * 失败时抛 `CommandError`，由前端回退到规则建议并提示原因。
 */
export async function suggestEnvPrefixSegment(
  ctx: WebContext,
  input: EnvPrefixAiInput,
): Promise<EnvPrefixAiResult> {
  const name = trim(input.name);
  if (name === "") {
    throw CommandError.badRequest("请先填写名称，再让 AI 生成环境前缀");
  }
  const note = trim(input.note);
  const provider = trim(input.provider, 64);
  const providerDefault = trim(input.providerDefault, 32);
  const used = Array.isArray(input.used)
    ? input.used.map((item) => trim(item, 32)).filter((item) => item !== "").slice(0, 20)
    : [];

  const snapshot = ctx.runtimeConfig.snapshot();
  const model = pickSuggestionModel(exposedModelNames(snapshot));
  if (model === null) {
    throw new CommandError(
      409,
      "command_failed",
      "没有可用的开放模型；请先在「模型服务」开放一个模型，或直接使用规则建议",
    );
  }

  const userPrompt = [
    `服务类型：${provider}${providerDefault === "" ? "" : `（环境变量默认前缀 ${providerDefault}）`}`,
    `实例名称：${name}`,
    note === "" ? "备注：（空）" : `备注：${note}`,
    used.length === 0 ? "已占用前缀：（无）" : `已占用前缀：${used.join("、")}`,
  ].join("\n");

  const content = await callLocalModel(ctx, model, userPrompt);
  const segment = parseSegment(content);
  if (segment === null) {
    throw new CommandError(
      502,
      "command_failed",
      content.trim() === ""
        ? "模型没有返回文本（可能被截断），已回退规则建议"
        : "模型没有给出可用的英文片段，已回退规则建议",
    );
  }
  return { segment, model };
}