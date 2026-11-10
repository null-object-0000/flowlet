// session-derive 纯函数契约测试（docs/agent-session-metadata.md §4 / §5）。
//
// 样本按各 Agent 的真实请求体形状构造：三类协议结构（OpenAI chat、Anthropic Messages、
// OpenAI Responses）各自的环境块 / 用户消息布局。不依赖任何 mock 上游，也不需要 SQLite。
// 运行：node --test packages/flowlet-core/src/proxy/__tests__/session-derive.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveSessionMetadata,
  sanitizeProjectPath,
  sanitizeSessionTitle,
} from "../session-derive.ts";

// ─── fixtures ───────────────────────────────────────────────────────────────

/** 把 JSON 对象序列化成请求体；所有样本都走同一条 Buffer 入口。 */
function derive(agentType: string, value: unknown) {
  return deriveSessionMetadata(agentType, Buffer.from(JSON.stringify(value), "utf8"));
}

const BOTH_NULL = { title: null, projectPath: null };

// ─── Claude Code ────────────────────────────────────────────────────────────

test("Claude Code 新版：system 的 Primary working directory + 首条 user 的 system-reminder 块", () => {
  const metadata = derive("claude-code", {
    model: "claude-sonnet",
    system: [
      {
        type: "text",
        text:
          "You are Claude Code, Anthropic's official CLI for Claude.\n" +
          "Primary working directory: /home/nichangen/代码/self-code/flowlet\n" +
          "Is directory a git repo: Yes",
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nAs you answer, remember the user's preferences.\n</system-reminder>",
          },
          { type: "text", text: "  修复登录页面的 bug  " },
        ],
      },
    ],
  });
  assert.deepEqual(metadata, {
    title: "修复登录页面的 bug",
    projectPath: "/home/nichangen/代码/self-code/flowlet",
  });
});

test("Claude Code 旧版：system 的 Working directory + 整条 system-reminder 消息被跳过", () => {
  // 旧版 Claude Code 把环境写成 `<env>...Working directory: ...</env>`；首条 user 消息
  // 可能只有 system-reminder，此时标题要取后面第一条真正的用户消息。
  const metadata = derive("claude-code", {
    model: "claude-sonnet",
    system:
      "You are Claude Code.\n<env>\n  Working directory: /home/me/项目/仓库\n  Is directory a git repo: Yes\n</env>",
    messages: [
      {
        role: "user",
        content: "<system-reminder>\nThe user has opened the file src/main.rs.\n</system-reminder>",
      },
      { role: "assistant", content: "我需要先看看文件。" },
      { role: "user", content: "重构日志模块的错误处理" },
    ],
  });
  assert.deepEqual(metadata, {
    title: "重构日志模块的错误处理",
    projectPath: "/home/me/项目/仓库",
  });
});

// ─── Codex ──────────────────────────────────────────────────────────────────

test("Codex Responses：input 里的 <environment_context><cwd> 与中文标题", () => {
  const metadata = derive("codex", {
    model: "gpt-6-sol",
    instructions: "You are a coding agent.",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "<environment_context>\n  <cwd>/home/me/flowlet</cwd>\n  <shell>bash</shell>\n" +
              "  <current_date>2026-11-10</current_date>\n</environment_context>",
          },
          { type: "input_text", text: "新增一个健康检查接口" },
        ],
      },
    ],
  });
  assert.deepEqual(metadata, {
    title: "新增一个健康检查接口",
    projectPath: "/home/me/flowlet",
  });
});

test("Codex Windows 路径：<cwd>D:\\work\\repo</cwd> 原样保留反斜杠", () => {
  const metadata = derive("codex-desktop", {
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<environment_context>\n<cwd>D:\\work\\repo</cwd>\n</environment_context>",
          },
          { type: "input_text", text: "修复编译错误" },
        ],
      },
    ],
  });
  assert.deepEqual(metadata, {
    title: "修复编译错误",
    projectPath: "D:\\work\\repo",
  });
});

test("Codex 无 <cwd> 时回退 <workspace_roots> 内的第一个 <root>", () => {
  const metadata = derive("codex", {
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "<environment_context>\n<workspace_roots>\n<root>/home/me/first-repo</root>\n" +
              "<root>/home/me/second-repo</root>\n</workspace_roots>\n</environment_context>",
          },
          { type: "input_text", text: "检查依赖" },
        ],
      },
    ],
  });
  assert.deepEqual(metadata, {
    title: "检查依赖",
    projectPath: "/home/me/first-repo",
  });
});

// ─── OpenCode ───────────────────────────────────────────────────────────────

test("OpenCode：<env> 里的 Working directory 与 Workspace root folder", () => {
  const metadata = derive("opencode", {
    model: "glm-5.3",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "<env>\n  Working directory: /home/me/shop\n" +
              "  Workspace root folder: /home/me/shop\n  Is directory a git repo: yes\n</env>",
          },
          { type: "text", text: "实现购物车结算" },
        ],
      },
    ],
  });
  assert.deepEqual(metadata, {
    title: "实现购物车结算",
    projectPath: "/home/me/shop",
  });
});

test("OpenCode：只有 Workspace root folder 时也能取到项目路径", () => {
  const metadata = derive("opencode", {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<env>\n  Workspace root folder: /home/me/workspace-root\n</env>",
          },
          { type: "text", text: "给这个目录加 CI" },
        ],
      },
    ],
  });
  assert.deepEqual(metadata, {
    title: "给这个目录加 CI",
    projectPath: "/home/me/workspace-root",
  });
});

test("Working directory 优先于 Workspace root folder（文档 §4.3 顺序）", () => {
  const metadata = derive("opencode", {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "<env>\n  Working directory: /wd/path\n" +
              "  Workspace root folder: /ws/path\n</env>",
          },
          { type: "text", text: "整理目录结构" },
        ],
      },
    ],
  });
  assert.equal(metadata.projectPath, "/wd/path");
});

// ─── Pi / Hermes ────────────────────────────────────────────────────────────

test("Pi：system 里的 Current working directory", () => {
  const metadata = derive("pi", {
    model: "qwen3.8-max",
    messages: [
      {
        role: "system",
        content: "You are Pi.\nCurrent working directory: /home/me/pi-project",
      },
      { role: "user", content: "帮我写一个测试" },
    ],
  });
  assert.deepEqual(metadata, {
    title: "帮我写一个测试",
    projectPath: "/home/me/pi-project",
  });
});

test("Hermes：developer 消息里的 Current working directory", () => {
  const metadata = derive("hermes", {
    messages: [
      { role: "developer", content: "Current working directory: /srv/hermes-work" },
      { role: "user", content: "汇总本周变更" },
    ],
  });
  assert.deepEqual(metadata, {
    title: "汇总本周变更",
    projectPath: "/srv/hermes-work",
  });
});

// ─── DSH ────────────────────────────────────────────────────────────────────

test("DSH：只有标题，请求体里没有 cwd", () => {
  const metadata = derive("deepseek-harness", {
    messages: [
      { role: "system", content: "You are DeepSeek Harness." },
      { role: "user", content: "解释这段 TypeScript 代码" },
    ],
  });
  assert.deepEqual(metadata, {
    title: "解释这段 TypeScript 代码",
    projectPath: null,
  });
});

// ─── 三类协议结构 ───────────────────────────────────────────────────────────

test("Anthropic Messages：content 为 [{type:text}]，system 只用于项目路径", () => {
  const metadata = derive("claude-code", {
    system: "You are Claude.\nPrimary working directory: /srv/anthropic-app",
    messages: [{ role: "user", content: [{ type: "text", text: "把这段翻译成英文" }] }],
  });
  assert.deepEqual(metadata, {
    title: "把这段翻译成英文",
    projectPath: "/srv/anthropic-app",
  });
});

test("Responses：instructions 只用于项目路径，input 字符串作为标题", () => {
  const metadata = derive("deepseek-harness", {
    instructions: "Follow the rules.\nPrimary working directory: /srv/app",
    input: "解释一下这个函数",
  });
  assert.deepEqual(metadata, {
    title: "解释一下这个函数",
    projectPath: "/srv/app",
  });
});

test("OpenAI chat/completions：content 为字符串", () => {
  const metadata = derive("opencode", {
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "生成一份提交说明" },
    ],
  });
  assert.deepEqual(metadata, {
    title: "生成一份提交说明",
    projectPath: null,
  });
});

// ─── 标题选择规则 ───────────────────────────────────────────────────────────

test("developer / system / assistant / tool 消息都不当标题", () => {
  const metadata = derive("opencode", {
    messages: [
      { role: "developer", content: "You are a coding agent. Always be concise." },
      {
        role: "system",
        content: "Primary working directory: /srv/tool-app\nExplain the repo layout",
      },
      { role: "assistant", content: "我可以解释仓库结构。" },
      { role: "tool", content: "some tool output" },
      { role: "user", content: "解释一下这个仓库的结构" },
    ],
  });
  assert.deepEqual(metadata, {
    title: "解释一下这个仓库的结构",
    projectPath: "/srv/tool-app",
  });
});

test("没有用户消息时标题为 null，但项目路径仍可派生", () => {
  const metadata = derive("pi", {
    system: "Current working directory: /srv/no-user",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "assistant", content: "先说明一下背景。" },
    ],
  });
  assert.deepEqual(metadata, {
    title: null,
    projectPath: "/srv/no-user",
  });
});

test("首个用户消息是纯符号时跳到下一条合格用户消息", () => {
  const metadata = derive("opencode", {
    messages: [
      { role: "user", content: "？？？" },
      { role: "assistant", content: "请补充信息。" },
      { role: "user", content: "第二个问题：如何部署？" },
    ],
  });
  // 文档 §4.1：标题要去掉首尾标点，句末问号不计入标题。
  assert.equal(metadata.title, "第二个问题：如何部署");
});

test("纯符号用户消息不产生标题", () => {
  const metadata = derive("opencode", { messages: [{ role: "user", content: "!!! ... ~~~" }] });
  assert.equal(metadata.title, null);
});

test("<cwd> 的优先级高于 system 的 Primary working directory", () => {
  const metadata = derive("codex", {
    system: "Primary working directory: /from/primary",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<environment_context>\n  <cwd>/from/cwd</cwd>\n</environment_context>",
          },
          { type: "input_text", text: "运行测试" },
        ],
      },
    ],
  });
  assert.deepEqual(metadata, {
    title: "运行测试",
    projectPath: "/from/cwd",
  });
});

// ─── 清洗与截断 ─────────────────────────────────────────────────────────────

test("标题折叠空白并去除首尾标点", () => {
  assert.equal(sanitizeSessionTitle("  Hello   \n world  "), "Hello world");
  assert.equal(sanitizeSessionTitle("“修复  bug。”"), "修复 bug");
  assert.equal(sanitizeSessionTitle("...继续"), "继续");
  assert.equal(
    sanitizeSessionTitle("<environment_context><cwd>/a</cwd></environment_context>"),
    null,
  );
  assert.equal(sanitizeSessionTitle("<system-reminder>x</system-reminder>"), null);
});

test("标题去尾标点保留配对括号与 emoji", () => {
  // 收尾句号被剥掉，但配对的右括号保留，避免把 `(v2)` 剥成 `(v2`。
  assert.equal(sanitizeSessionTitle("修复登录 (v2)."), "修复登录 (v2)");
  assert.equal(sanitizeSessionTitle("修复登录）"), "修复登录");
  assert.equal(sanitizeSessionTitle("写个测试 🚀"), "写个测试 🚀");
  // 纯符号 / 无字母数字的输入继续视为无效标题。
  assert.equal(sanitizeSessionTitle("🎉🎉"), null);
});

test("标题截断：≤60 码点且 ≤120 字节（ASCII / 中文 / emoji）", () => {
  const ascii = sanitizeSessionTitle("a".repeat(500));
  assert.equal(ascii, "a".repeat(60));

  const chinese = sanitizeSessionTitle("中".repeat(200));
  assert.ok(chinese !== null);
  assert.equal(Array.from(chinese).length, 40);
  assert.equal(Buffer.byteLength(chinese, "utf8"), 120);

  // emoji 是 4 字节码点：先撞字节上限，且截断不能切出半个代理对。
  const emoji = sanitizeSessionTitle("标题" + "😀".repeat(50));
  assert.ok(emoji !== null);
  assert.ok(Array.from(emoji).length <= 60);
  assert.ok(Buffer.byteLength(emoji, "utf8") <= 120);
  assert.equal(Array.from(emoji).join(""), emoji);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(emoji));
});

test("超长标题经由 derive 也按同样规则截断，且不切半个字符", () => {
  const metadata = derive("opencode", {
    messages: [{ role: "user", content: "部署 流程 " + "说明".repeat(120) }],
  });
  assert.ok(metadata.title !== null);
  assert.ok(Array.from(metadata.title).length <= 60);
  assert.ok(Buffer.byteLength(metadata.title, "utf8") <= 120);
  // Array.from 回拼与截断结果一致，说明没有留下孤立代理对。
  assert.equal(Array.from(metadata.title).join(""), metadata.title);
});

test("项目路径清洗：成对引号、行尾标点、绝对路径形态", () => {
  assert.equal(sanitizeProjectPath('"/home/me/repo".'), "/home/me/repo");
  assert.equal(sanitizeProjectPath("`/home/me/repo`"), "/home/me/repo");
  assert.equal(sanitizeProjectPath("~/work"), "~/work");
  assert.equal(sanitizeProjectPath("D:\\work\\repo"), "D:\\work\\repo");
  assert.equal(sanitizeProjectPath("D:/work/repo"), "D:/work/repo");
  assert.equal(sanitizeProjectPath("/home/me/repo，"), "/home/me/repo");
  // 相对路径、纯文件名、空串都丢弃（没有 cwd 上下文时不能猜）。
  assert.equal(sanitizeProjectPath("src/project"), null);
  assert.equal(sanitizeProjectPath("repo"), null);
  assert.equal(sanitizeProjectPath(""), null);
  assert.equal(sanitizeProjectPath("~"), null);
  // 控制字符 / 换行会被当作解析噪声丢弃。
  assert.equal(sanitizeProjectPath("/home/me/repo\nrm -rf /"), null);
  assert.equal(sanitizeProjectPath("/home/me/repo\u0007"), null);
});

test("项目路径超长丢弃而不是截断（边界 1024 / 1025 码点）", () => {
  assert.equal(sanitizeProjectPath("/" + "a".repeat(1023)), "/" + "a".repeat(1023));
  assert.equal(sanitizeProjectPath("/" + "a".repeat(1024)), null);

  const metadata = derive("claude-code", {
    system: "Primary working directory: /" + "a".repeat(1100),
    messages: [{ role: "user", content: "检查构建" }],
  });
  assert.deepEqual(metadata, {
    title: "检查构建",
    projectPath: null,
  });
});

// ─── 非法请求体 ─────────────────────────────────────────────────────────────

test("空 body / 非 JSON / 非 UTF-8 / 非对象 JSON 都返回全 null", () => {
  assert.deepEqual(deriveSessionMetadata("claude-code", Buffer.alloc(0)), BOTH_NULL);
  assert.deepEqual(
    deriveSessionMetadata("claude-code", Buffer.from("not json at all", "utf8")),
    BOTH_NULL,
  );
  // 0xff 不是合法 UTF-8 序列：解码会出现替换字符，不能让它混进标题。
  assert.deepEqual(
    deriveSessionMetadata("claude-code", Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d])),
    BOTH_NULL,
  );
  assert.deepEqual(deriveSessionMetadata("claude-code", Buffer.from("[1,2,3]", "utf8")), BOTH_NULL);
  assert.deepEqual(deriveSessionMetadata("claude-code", Buffer.from("null", "utf8")), BOTH_NULL);
});

test("超过 4 MiB 的 body 直接返回全 null", () => {
  const huge = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);
  assert.deepEqual(deriveSessionMetadata("claude-code", huge), BOTH_NULL);
});

test("结构不认识（无 messages / input）时返回全 null", () => {
  assert.deepEqual(derive("opencode", { model: "glm-5.3", prompt: "hi" }), BOTH_NULL);
});