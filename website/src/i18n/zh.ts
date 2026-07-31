export const zh = {
  meta: {
    title: "Flowlet — 给 AI Agent 一个本地、可观测、可切换的模型入口",
    description:
      "Flowlet 是面向 AI Agent 的本地桌面模型服务控制台:统一管理模型渠道与账号,把 Claude Code、OpenCode、Pi 等 Agent 接入本地代理,并在一个桌面应用里查看请求、会话、Token、费用和资源余量。",
  },
  nav: {
    features: "功能",
    channels: "渠道",
    agents: "Agent 接入",
    quickstart: "快速开始",
    github: "GitHub",
  },
  hero: {
    badge: "Early Preview · 早期预览",
    title: "给 AI Agent 一个本地、可观测、可切换的模型入口。",
    subtitle:
      "统一管理模型渠道与账号,把 Claude Code、OpenCode、Pi 等 Agent 接入本地代理,并在一个桌面应用里查看请求、会话、Token、费用和资源余量。",
    ctaGithub: "GitHub 仓库",
    ctaQuickstart: "3 分钟启动",
    note: "免费开源 · MIT License · Tauri 2 桌面应用",
  },
  features: {
    title: "为什么是 Flowlet",
    subtitle:
      "AI Agent 越来越多,但模型渠道、账号、套餐、请求日志和会话数据往往散落在不同地方。Flowlet 把这些日常操作收敛到本地桌面。",
    items: [
      {
        title: "一个本地入口",
        desc: "OpenAI-compatible 与 Anthropic-compatible 客户端使用固定的 Base URL 和 Client Token,不必在每个 Agent 中反复更换上游密钥。",
      },
      {
        title: "多个渠道与账号",
        desc: "管理 LongCat、DeepSeek、Kimi、千问 Qwen 和自定义中转服务,为同一模型配置多个候选账号和优先级。",
      },
      {
        title: "明确开放哪些模型",
        desc: "从上游 /models 拉取真实列表,只开放 Flowlet 支持且由你明确选择的模型,白名单外模型可见但不可误开放。",
      },
      {
        title: "Agent 不再是黑盒",
        desc: "统一查看经过 Flowlet 的请求,以及 Claude Code、OpenCode、Pi、Codex Desktop / CLI 的本地原生会话和时间线。",
      },
      {
        title: "用量与费用更容易核对",
        desc: "查看 Token、缓存命中、模型价格、渠道费用、套餐余量和 Codex credits;不同币种和不同成本语义不会被强行相加。",
      },
      {
        title: "本地优先",
        desc: "代理、配置、SQLite 数据库和请求捕获默认保存在本机;多设备共享是可选能力。",
      },
    ],
  },
  channels: {
    title: "渠道与账号",
    subtitle:
      "同一渠道添加多个账号,测试连接、启用/停用和调整路由优先级;支持官方余额、资源包和套餐余量查询。",
    table: {
      channel: "渠道",
      openai: "OpenAI Chat",
      anthropic: "Anthropic Messages",
      models: "模型同步",
      balance: "余额 / 资源",
    },
    rows: [
      {
        name: "LongCat",
        openai: "✅",
        anthropic: "✅",
        models: "✅",
        balance: "资源包与按量余额",
      },
      {
        name: "DeepSeek",
        openai: "✅",
        anthropic: "✅",
        models: "✅",
        balance: "官方余额",
      },
      {
        name: "Kimi / Moonshot",
        openai: "✅",
        anthropic: "✅",
        models: "✅",
        balance: "官方余额",
      },
      {
        name: "千问 Qwen",
        openai: "✅",
        anthropic: "✅",
        models: "✅",
        balance: "Token Plan 套餐余量",
      },
      {
        name: "自定义渠道",
        openai: "取决于上游",
        anthropic: "取决于上游",
        models: "标准 OpenAI /models",
        balance: "—",
      },
    ],
    note: "自定义渠道用于连接标准 OpenAI-compatible / Anthropic-compatible 中转服务,模型必须来自该账号 /models 的真实返回。",
  },
  agents: {
    title: "一键接入 AI Agent",
    subtitle:
      "检测安装、写入全局配置、复制 Base URL 与 Client Token;点击 Agent 卡片打开完整接入说明,而不是只复制一个地址。",
    table: {
      agent: "Agent",
      detect: "安装探测",
      connect: "一键接入 Flowlet",
      session: "原生会话",
    },
    rows: [
      { name: "Claude Code", detect: "✅", connect: "✅", session: "✅" },
      { name: "OpenCode CLI / Desktop", detect: "✅", connect: "✅", session: "✅" },
      { name: "Pi", detect: "✅", connect: "✅", session: "✅" },
      { name: "ChatGPT(Codex)/ Codex CLI", detect: "✅", connect: "暂未开放", session: "✅" },
    ],
    note: "支持 Claude Code 主模型、快速模型、子 Agent 模型和可选 [1m] 长上下文;OpenCode 同时识别 CLI 与 Desktop。",
  },
  quickstart: {
    title: "3 分钟启动",
    subtitle: "Flowlet 仍处于早期预览阶段,当前推荐从源码运行或自行构建。",
    requirements: "环境要求:Node.js 22+、Rust stable、Tauri 2 系统依赖。",
    stepsTitle: "首次启动后",
    steps: [
      "Flowlet 会自动尝试启动本地代理;",
      "在概览页添加渠道账号并填写上游 API Key;",
      "点击“拉取模型列表”,选择需要开放的模型并保存;",
      "在“AI Agent 接入”中选择 Claude Code、OpenCode 或 Pi,一键写入全局配置;",
      "回到你的 Agent 发起请求,在 Flowlet 中查看日志、会话和用量。",
    ],
    endpointsTitle: "本地访问地址",
    endpointsNote: "默认代理地址为 http://127.0.0.1:18640。客户端鉴权使用概览页展示的 Client Token,不是渠道 API Key。",
    endpoints: {
      usage: "用途",
      address: "地址",
      rows: [
        { usage: "健康检查", address: "http://127.0.0.1:18640/health" },
        { usage: "OpenAI Base URL", address: "http://127.0.0.1:18640/v1" },
        { usage: "OpenAI 模型列表", address: "http://127.0.0.1:18640/v1/models" },
        { usage: "OpenAI Chat Completions", address: "http://127.0.0.1:18640/v1/chat/completions" },
        { usage: "Anthropic Base URL", address: "http://127.0.0.1:18640/anthropic" },
        { usage: "Anthropic Messages", address: "http://127.0.0.1:18640/anthropic/v1/messages" },
      ],
    },
  },
  security: {
    title: "数据与安全",
    items: [
      "渠道 API Key、Client Token、配置和使用数据默认只保存在本机;",
      "请求日志是否脱敏由 log_capture.redact_sensitive_headers 控制,当前默认关闭;",
      "默认状态下,请求捕获可能原样保存 Authorization、x-api-key、Cookie、Header 和 Body;",
      "如果不需要排查完整请求,请在“设置 → 数据捕获”中开启敏感 Header 脱敏,或关闭对应 Header / Body 捕获;",
      "可选 S3 设备同步只发送最小用量与会话摘要,不发送请求正文、凭据或渠道账号;",
      "Flowlet 的费用主要是基于官方价格目录的估算,不等同于账单实付或订阅成本分摊。",
    ],
  },
  boundaries: {
    title: "Flowlet 不做什么",
    subtitle: "Flowlet 是面向 AI Agent 的本地模型服务控制台,不是通用企业 LLM Gateway。",
    items: [
      "不做不同模型服务协议之间的转换;",
      "不随意改写上游响应结构;",
      "不提供企业多租户、复杂权重调度或大规模网关控制面;",
      "fallback 只处理适合重试的网络错误、429 和部分 5xx,不会用换模型掩盖参数错误;",
      "Agent 原生用量与经过 Flowlet 的请求分开统计,不重复相加。",
    ],
  },
  footer: {
    tagline: "给 AI Agent 一个本地、可观测、可切换的模型入口。",
    links: "链接",
    docs: "文档",
    license: "License",
    copyright: "© {year} Flowlet. MIT License.",
  },
  languageName: "简体中文",
};

export type Messages = typeof zh;
