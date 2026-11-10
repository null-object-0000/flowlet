// Agent 会话标题 / 项目路径的服务端派生（docs/agent-session-metadata.md §4）。
//
// 纯函数：只读已经读入内存的请求体，不落盘、不取当前时间、不依赖 Agent 客户端插件。
// 派生值是**近似值**：标题取会话里第一条合格的人类消息，项目路径取请求体里的工作目录。
// 它由 proxy 侧在识别出 (agent_type, session_id) 之后 upsert，失败不得影响转发主链路。
//
// 权威契约是 docs/agent-session-metadata.md §4，这里的匹配顺序与阈值不要“顺手”调整：
// 标题 / 项目路径会进入会话聚合的搜索与项目筛选，改阈值会改变历史会话的命中语义。
import { asArray, isRecord, str, type JsonRow } from "./util.ts";

/** body 上限：超过即视为与派生无关的巨大请求体（如内联大图），不解析。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_TITLE_BYTES = 120;
const MAX_TITLE_CODE_POINTS = 60;
const MAX_PROJECT_PATH_CODE_POINTS = 1024;

/**
 * 标题候选要整块丢弃的 XML 风格环境块（文档 §4.1 / §4.2）。
 *
 * 按块丢弃而不是按消息丢弃：Claude Code 把 `<system-reminder>`、OpenCode 把 `<env>`
 * 与真实用户问题放在同一条 user 消息的两个 text 块里，丢整条消息会连同真正的标题一起丢掉。
 * 判定用“以 `<` 开头”的通用形态而不是枚举标签：各 Agent 的环境块标签并不统一
 * （`<env>`、`<environment_context>`、`<system-reminder>`），枚举漏一个就会把整段环境
 * 文本当成会话标题。文档 §4.1 同样以“以 `<` 开头的 XML 风格环境块”表述。
 */
const XML_BLOCK_PREFIX = "<";

/** 成对引号 / 反引号：命令行与 Markdown 里的 cwd 经常被包起来。 */
const PAIRED_QUOTES: Record<string, string> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "“": "”",
  "‘": "’",
};

/** 行尾标点（路径后常跟句号 / 列表逗号 / 全角标点）。 */
const TRAILING_PATH_PUNCTUATION = /[\s.,;:!?，。；:！？、]+$/u;
/** C0/C1 控制字符；换行、制表符也算，路径里出现即视为解析噪声。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
/** 标题首尾要剥掉的标点与空白。只剥标点（P）不剥符号（S）：emoji、`~`、`+` 常是标题语义的一部分。 */
const LEADING_EDGE = /^[\p{P}\s]+/u;
/** 逐个判断尾部字符是否属于要剥掉的标点 / 空白。 */
const TRAILING_EDGE_CHAR = /[\p{P}\s]/u;
/** 收尾字符是闭括号时，若前面还有配对的开口括号就保留：`fix bug (v2)` 不该变成 `fix bug (v2`。 */
const CLOSING_TO_OPENING: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
  "）": "（",
  "】": "【",
  "」": "「",
  "』": "『",
  "》": "《",
  "”": "“",
  "’": "‘",
};
/** 标题至少要有一个字母或数字，否则视为“纯符号”输入并跳过。 */
const TITLE_MEANINGFUL_CHAR = /[\p{L}\p{N}]/u;

export interface DerivedSessionMetadata {
  title: string | null;
  projectPath: string | null;
}

/**
 * 按 docs/agent-session-metadata.md §4 从请求体派生会话标题与项目路径。
 *
 * 任何异常输入（空 body、非 JSON、非 UTF-8、超大 body、结构不认识）都只返回全 null，
 * 不抛错：调用方在转发链路上，派生失败不应影响模型请求。
 */
export function deriveSessionMetadata(
  agentType: string,
  body: Buffer,
): DerivedSessionMetadata {
  // 派生规则只依赖请求体的协议结构（文档 §4.2），与具体 Agent 无关；agent_type 由调用方
  // 随行写入元数据表。参数保留是为了将来按 Agent 细化时调用方无需改签名。
  void agentType;
  const none: DerivedSessionMetadata = { title: null, projectPath: null };
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_BODY_BYTES) return none;

  const text = body.toString("utf8");
  // Node 解码非法 UTF-8 字节时会替换成 U+FFFD；重新编码后字节不一致即说明 body 不是合法
  // UTF-8。先挡掉，避免替换字符混进标题或项目路径。
  if (!Buffer.from(text, "utf8").equals(body)) return none;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return none;
  }
  if (!isRecord(parsed)) return none;

  const collected = collectRequestTexts(parsed);
  return {
    title: firstQualifiedTitle(collected.userMessages),
    projectPath: firstProjectPath(collected.environmentTexts),
  };
}

// ─── 标题 ───────────────────────────────────────────────────────────────────

/**
 * 标题清洗：折叠空白 → 去首尾标点 → 按码点截断。
 *
 * 返回 null 表示这条文本不能当标题（空、纯符号、XML 风格环境块），调用方应继续看下一条
 * 用户消息，而不是把 null 当成“本会话没有标题”。
 */
export function sanitizeSessionTitle(raw: string): string | null {
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (collapsed === "") return null;
  // XML 风格环境块不是人类输入。必须在去标点之前判断：否则前导 "<" 会被当标点剥掉，
  // 环境块内容反而“看起来”像标题。
  if (collapsed.startsWith("<")) return null;
  const trimmed = trimEdgePunctuation(collapsed);
  if (trimmed === "" || !TITLE_MEANINGFUL_CHAR.test(trimmed)) return null;
  return truncateTitle(trimmed);
}

/**
 * 去掉标题首尾的标点与空白。
 *
 * 尾部逐字符判断而不是整段删除：闭括号只有在前面没有配对开口括号时才剥掉，避免把
 * `修复登录 (v2)` 剥成 `修复登录 (v2`。前导标点直接去掉（没人用开口括号开头提问）。
 */
function trimEdgePunctuation(value: string): string {
  let result = value.replace(LEADING_EDGE, "").trim();
  // 逐码点从尾部剥：尾部常常是“标点 + 空格”的组合（`... )`），整段正则替换无法区分
  // “该保留的配对右括号”和“该剥掉的句末标点”。
  for (;;) {
    const points = Array.from(result);
    const last = points.at(-1);
    if (last === undefined || !TRAILING_EDGE_CHAR.test(last)) break;
    const opener = CLOSING_TO_OPENING[last];
    if (opener !== undefined) {
      const before = points.slice(0, -1).join("");
      if (before.includes(opener)) break;
    }
    result = points.slice(0, -1).join("").trimEnd();
  }
  return result;
}

/**
 * 标题截断：同时满足 ≤120 UTF-8 字节与 ≤60 个 Unicode 码点。
 *
 * 用码点而不是 UTF-16 单元做单位，保证不会切出半个代理对；中文标题通常先撞字节上限
 * （40 个汉字即 120 字节），英文标题先撞码点上限。两者都按码点回退。
 */
function truncateTitle(value: string): string {
  let points = Array.from(value);
  if (points.length > MAX_TITLE_CODE_POINTS) points = points.slice(0, MAX_TITLE_CODE_POINTS);
  while (points.length > 0 && Buffer.byteLength(points.join(""), "utf8") > MAX_TITLE_BYTES) {
    points = points.slice(0, -1);
  }
  // 折叠后的空白可能正好落在截断点上，去掉尾部残留空格。
  return points.join("").trimEnd();
}

/** 依次看用户消息，返回第一条能清洗出标题的消息文本。 */
function firstQualifiedTitle(messages: MessageText[]): string | null {
  for (const message of messages) {
    const title = sanitizeSessionTitle(message.title);
    if (title !== null) return title;
  }
  return null;
}

// ─── 项目路径 ───────────────────────────────────────────────────────────────

/**
 * 项目路径清洗：去装饰（引号 / 行尾标点）→ 校验。
 *
 * 文档 §4.1 要求“不满足则丢弃（不截断）”：截断会改变路径身份，破坏按项目筛选的语义，
 * 所以超长路径直接放弃，而不是留一个近似前缀。
 */
export function sanitizeProjectPath(raw: string): string | null {
  const value = stripPathDecorations(raw);
  if (value === "") return null;
  if (CONTROL_CHARS.test(value)) return null;
  if (Array.from(value).length > MAX_PROJECT_PATH_CODE_POINTS) return null;
  // 只接受绝对路径形态（/、~/、X:\、X:/）。没有 cwd 上下文时不做 resolve / 相对路径拼接：
  // 猜出来的路径会把不同项目错并成同一个项目。
  return isAbsoluteProjectPath(value) ? value : null;
}

function isAbsoluteProjectPath(value: string): boolean {
  if (value.startsWith("/")) return true;
  if (value.startsWith("~/")) return true;
  return /^[A-Za-z]:[\\/]/u.test(value);
}

/**
 * 去掉成对引号 / 反引号与行尾标点；两者可能交替出现（如 `Working directory: "/path".`），
 * 循环几轮直到稳定即可，不需要真正的语法解析。
 */
function stripPathDecorations(raw: string): string {
  let value = raw.trim();
  for (let round = 0; round < 3; round += 1) {
    const before = value;
    const first = value.at(0);
    const last = value.at(-1);
    if (
      first !== undefined &&
      last !== undefined &&
      value.length >= 2 &&
      PAIRED_QUOTES[first] === last
    ) {
      value = value.slice(1, -1).trim();
    }
    value = value.replace(TRAILING_PATH_PUNCTUATION, "");
    if (value === before) break;
  }
  return value;
}

type PathFeature = (text: string) => string | null;

/**
 * 项目路径特征的固定优先级（文档 §4.3）：先在所有候选文本里找高优先特征，再降级。
 * 这样 Codex 用户侧的 `<cwd>` 不会被 system 里的 `Primary working directory` 抢先。
 */
const PROJECT_PATH_FEATURES: PathFeature[] = [
  (text) => tagContent(text, "cwd"),
  workspaceRoot,
  (text) => lineRemainder(text, "Primary working directory:"),
  (text) => lineRemainder(text, "Current working directory:"),
  (text) => lineRemainder(text, "Working directory:"),
  (text) => lineRemainder(text, "Workspace root folder:"),
];

function firstProjectPath(texts: string[]): string | null {
  for (const feature of PROJECT_PATH_FEATURES) {
    for (const text of texts) {
      const raw = feature(text);
      if (raw === null) continue;
      const path = sanitizeProjectPath(raw);
      if (path !== null) return path;
    }
  }
  return null;
}

/** 匹配 `<tag>value</tag>`；各行以 ^ 锚定并允许前导空白（文档 §4.3）。 */
function tagContent(text: string, tag: string): string | null {
  const pattern = new RegExp(`^[ \\t]*<${tag}>([^<\\r\\n]*)</${tag}>`, "m");
  const match = pattern.exec(text);
  return match === null ? null : match[1];
}

/** `<workspace_roots>` 块里的第一个 `<root>…</root>`。 */
function workspaceRoot(text: string): string | null {
  const block = /<workspace_roots>([\s\S]*?)<\/workspace_roots>/u.exec(text);
  if (block === null) return null;
  return tagContent(block[1], "root");
}

/** 匹配 “标签: 同行剩余内容”；同一行只取到换行为止。 */
function lineRemainder(text: string, label: string): string | null {
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(label)}[ \\t]*([^\\r\\n]+)`, "m");
  const match = pattern.exec(text);
  return match === null ? null : match[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── 请求体文本抽取 ─────────────────────────────────────────────────────────

interface MessageText {
  /** 消息内全部文本块：项目路径检测要用到首个用户消息里的环境块。 */
  all: string;
  /** 去掉 XML 环境块后的文本：只用于标题候选。 */
  title: string;
}

interface CollectedRequestTexts {
  /** 按出现顺序的用户消息文本。 */
  userMessages: MessageText[];
  /** 文档 §4.3 的候选环境文本，已按优先级排好。 */
  environmentTexts: string[];
}

function collectRequestTexts(parsed: JsonRow): CollectedRequestTexts {
  const userMessages: MessageText[] = [];
  const environmentTexts: string[] = [];

  // Anthropic 顶层 system：字符串或 text 块数组，只用于项目路径检测。
  const system = textBlocks(parsed.system, false);
  if (system.length > 0) environmentTexts.push(system.join("\n"));

  // Responses 顶层 instructions：同上，不参与标题。
  const instructions = textBlocks(parsed.instructions, true);
  if (instructions.length > 0) environmentTexts.push(instructions.join("\n"));

  // OpenAI chat / Anthropic Messages 共用 messages[]，角色语义一致。
  for (const message of asArray<JsonRow>(parsed.messages)) {
    const role = (str(message.role) ?? "").toLowerCase();
    const blocks = textBlocks(message.content, false);
    if (role === "user") {
      userMessages.push(messageText(blocks));
    } else if (role === "system" || role === "developer") {
      // Codex / Claude Code 的环境上下文可能落在 system/developer 消息里，只喂给路径检测。
      environmentTexts.push(blocks.join("\n"));
    }
  }

  // Responses 的 input：字符串即单条用户输入；数组项的 role 语义与 messages 一致。
  // 真实 body 只会用其中一种结构；两种都处理是为了让派生规则只依赖“出现了什么”，
  // 不依赖调用方是哪个协议入口（同一个 Agent 的两种接入路径都走得到）。
  const input = parsed.input;
  if (typeof input === "string") {
    userMessages.push({ all: input, title: input });
  } else {
    for (const item of asArray<JsonRow>(input)) {
      const role = (str(item.role) ?? "").toLowerCase();
      const blocks = textBlocks(item.content, true);
      if (role === "user") {
        userMessages.push(messageText(blocks));
      } else if (role === "system" || role === "developer") {
        environmentTexts.push(blocks.join("\n"));
      }
    }
  }

  // 文档 §4.3 的候选顺序：system → instructions → system/developer 消息 → 首个用户消息。
  const firstUser = userMessages[0];
  if (firstUser !== undefined && firstUser.all !== "") environmentTexts.push(firstUser.all);

  return { userMessages, environmentTexts };
}

/**
 * 取一个 content 字段里的文本块。`responses` 为 true 时接受 `input_text` / `output_text`，
 * 对应 Responses API 的 content 形状；chat / Anthropic 只接受 `text`。
 */
function textBlocks(content: unknown, responses: boolean): string[] {
  const direct = str(content);
  if (direct !== undefined) return [direct];
  const texts: string[] = [];
  for (const block of asArray(content)) {
    if (!isRecord(block)) continue;
    const type = str(block.type);
    if (type === undefined) continue;
    const isText =
      type === "text" || (responses && (type === "input_text" || type === "output_text"));
    if (!isText) continue;
    const text = str(block.text);
    if (text !== undefined) texts.push(text);
  }
  return texts;
}

function messageText(blocks: string[]): MessageText {
  return {
    all: blocks.join("\n"),
    title: blocks.filter((block) => !isEnvironmentBlock(block)).join("\n"),
  };
}

function isEnvironmentBlock(text: string): boolean {
  return text.trimStart().startsWith(XML_BLOCK_PREFIX);
}