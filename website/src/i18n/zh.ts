export const zh = {
  meta: {
    title: "Flowlet — 多个 AI Agent 共用一个本地模型入口",
    description:
      "Flowlet 是面向 AI Agent 的开源桌面客户端：统一接入模型渠道，把 Agent 会话、实际请求、路由结果、Token 与费用关联起来。",
  },
  nav: {
    demo: "产品演示",
    trace: "可追溯",
    ecosystem: "支持范围",
    start: "开始使用",
    github: "GitHub",
    download: "下载",
  },
  hero: {
    badge: "v0.1.0 · 开源桌面应用",
    title: "一个入口，连接你的 AI Agent。",
    subtitle: "统一切换模型，追踪每次请求与成本。",
    primary: "获取 Flowlet",
    secondary: "查看 GitHub",
    platform: "Windows 11 原生环境已完整回归 · macOS / Linux 提供自动构建产物",
    endpoint: "一个本地端点",
    agents: "4 个 Agent",
    protocols: "3 类原生协议",
  },
  demo: {
    eyebrow: "交互式产品预览",
    title: "这不是一张静态截图。",
    subtitle: "点击左侧菜单，查看 Flowlet 如何管理模型、执行项目任务，并把请求、会话与用量串在一起。",
    hint: "点击菜单切换页面",
  },
  value: {
    eyebrow: "你实际得到什么",
    title: "一个本地入口，接住 Agent 工作的完整链路。",
    subtitle: "模型接入、故障排查、成本归因和本机任务不再分散在不同客户端与平台里。",
    items: [
      {
        kicker: "统一",
        title: "模型变化，Agent 不用跟着改",
        desc: "Agent 始终连接同一个本地地址。新增账号、切换模型或调整候选，不必逐个重配客户端。",
      },
      {
        kicker: "排查",
        title: "失败能定位到具体一层",
        desc: "从 Agent 会话追到真实上游请求、路由账号、响应和错误，直接判断问题发生在哪里。",
      },
      {
        kicker: "核算",
        title: "每笔消耗都有出处",
        desc: "按 Agent、模型、账号和设备查看 Token、缓存、延迟与预估费用，并保留不同成本语义。",
      },
      {
        kicker: "执行",
        title: "本机 Agent 可以持续执行",
        desc: "把代码修改或分析任务加入项目看板，排队执行、人工审核、退回续跑，并保留过程。",
      },
    ],
  },
  trace: {
    eyebrow: "Flowlet 的差异",
    title: "每次 Agent 工作，都有一条证据链。",
    subtitle: "从会话、请求和实际路由，一直看到上游结果、Token 与费用，而不是只看到成功或失败。",
    steps: ["Agent 会话", "本地请求", "路由账号与模型", "上游结果", "Token 与费用"],
    resultTitle: "一条完整证据链",
    resultDesc: "知道谁发起、用了哪个模型、走了哪个账号、上游如何响应，以及最终消耗了多少。",
    logTitle: "请求 #A8F3",
    logStatus: "已完成",
    logRows: [
      ["客户端", "Claude Code"],
      ["虚拟模型", "flowlet-pro"],
      ["实际路由", "DeepSeek · 工作账号"],
      ["首 Token", "842 ms"],
      ["总消耗", "18,420 tokens"],
    ],
  },
  ecosystem: {
    eyebrow: "接入你已经在用的工具",
    title: "接入现有 Agent 和模型账号，不改变工作方式。",
    subtitle: "检测本机安装，检查、备份、写入或恢复全局配置；接管入口，但不接管你的工具选择。",
    agents: [
      { name: "Claude Code", detail: "接入 · 会话 · 任务" },
      { name: "Codex", detail: "CLI / Desktop / VS Code" },
      { name: "OpenCode", detail: "CLI / Desktop · 交互确认" },
      { name: "Pi", detail: "接入 · 会话 · 任务" },
    ],
    channelsTitle: "连接多个模型渠道",
    channels: ["LongCat", "DeepSeek", "Kimi", "Qwen", "Z.AI", "OpenRouter", "自定义渠道"],
    mobileTitle: "实验性 Android 辅助端",
    mobileDesc: "从手机查看多设备用量、会话和项目，局域网内提交任务或处理 Agent 交互确认。当前需自行构建。",
  },
  local: {
    eyebrow: "本地优先",
    title: "密钥、请求证据和控制权，默认留在本机。",
    items: [
      { title: "本地代理", desc: "代理、配置和 SQLite 数据默认保存在本机，关闭窗口后也可继续在托盘运行。" },
      { title: "响应零改写", desc: "原生转发 OpenAI Chat、Anthropic Messages 与无状态 Responses，不做跨协议转换。" },
      { title: "同步由你决定", desc: "多设备能力使用你自己的 S3-compatible 存储；请求捕获和敏感 Header 脱敏均可配置。" },
    ],
  },
  start: {
    eyebrow: "三步开始",
    title: "三步接入第一个 Agent。",
    steps: [
      { number: "01", title: "添加模型账号", desc: "填写上游 API Key，连接真实模型服务。" },
      { number: "02", title: "选择开放模型", desc: "从上游列表明确选择要提供给 Agent 的模型。" },
      { number: "03", title: "一键接入 Agent", desc: "写入本地地址与 Client Token，然后照常工作。" },
    ],
    ctaTitle: "给你的 AI Agent 一个共同入口。",
    ctaDesc: "免费开源，MIT License。先从一台 Windows 11 电脑和一个 Agent 开始。",
    primary: "前往 Releases",
    secondary: "阅读 README",
    noticeTitle: "平台验证说明",
    notice: "当前主要开发与完整回归环境为 Windows 11 原生环境，未启用 WSL。macOS 与 Linux 产物由 GitHub Actions 自动构建，尚未完成作者真机回归；桌面产物目前未签名。",
  },
  footer: {
    tagline: "多个 AI Agent，共用一个可控、可追溯的本地模型入口。",
    product: "产品",
    project: "项目",
    copyright: "© {year} Flowlet · MIT License",
  },
  languageName: "简体中文",
};

export type Messages = typeof zh;
