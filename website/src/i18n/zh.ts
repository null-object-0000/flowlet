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
    eyebrow: "真正解决什么",
    title: "Agent 可以越来越多，模型入口不必越来越乱。",
    subtitle: "Flowlet 把分散在客户端、模型平台和日志里的日常操作，收进一个本地桌面控制台。",
    items: [
      {
        kicker: "统一",
        title: "一次接入，随时切换",
        desc: "Agent 只连接固定的本地地址。新增账号、更换模型或调整候选，不必逐个重配客户端。",
      },
      {
        kicker: "排查",
        title: "失败不再靠猜",
        desc: "从 Agent 会话追到真实上游请求、路由账号、响应和错误，快速判断问题发生在哪一层。",
      },
      {
        kicker: "核算",
        title: "消耗有明确出处",
        desc: "按 Agent、模型、账号和设备查看 Token、缓存、延迟与预估费用，不把不同成本语义混成一个数字。",
      },
      {
        kicker: "执行",
        title: "任务交给本机 Agent",
        desc: "把代码修改或分析任务加入项目看板，排队执行、人工审核、退回续跑，并保留完整历史。",
      },
    ],
  },
  trace: {
    eyebrow: "Flowlet 的差异",
    title: "从一句提示词，一路追到真实成本。",
    subtitle: "不是只告诉你请求成功或失败，而是把一次 Agent 工作背后的关键证据串在一起。",
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
    title: "Agent、模型账号和项目，统一从这里出发。",
    subtitle: "检测本机安装，一键检查、备份、写入或恢复全局配置；无需改变原本的工作方式。",
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
    title: "模型密钥、请求证据和控制权，默认留在你的电脑上。",
    items: [
      { title: "本地代理", desc: "代理、配置和 SQLite 数据默认保存在本机，关闭窗口后也可继续在托盘运行。" },
      { title: "响应零改写", desc: "原生转发 OpenAI Chat、Anthropic Messages 与无状态 Responses，不做跨协议转换。" },
      { title: "同步由你决定", desc: "多设备能力使用你自己的 S3-compatible 存储；请求捕获和敏感 Header 脱敏均可配置。" },
    ],
  },
  start: {
    eyebrow: "三步开始",
    title: "装好以后，几分钟就能接管第一个 Agent。",
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
