import type { OverviewServiceStripLabels, OverviewServiceStripModel } from "../desktop/OverviewServiceStripView";
import type { UsageSummaryItem } from "../mobile/UsageSummaryGridView";
import type { RequestLogsRowModel, RequestLogsStatItem, RequestLogsLabels } from "../desktop/RequestLogsView";
import type { AgentSessionRowModel, AgentSessionsLabels } from "../desktop/AgentSessionsView";
import type { UsageAnalysisRankEntryModel, UsageAnalysisMatrixColumnModel, UsageAnalysisMatrixRowModel, UsageAnalysisDetailModel, UsageAnalysisLabels } from "../desktop/UsageAnalysisView";
import type { ModelsServiceStatModel, ModelsServiceItemModel, ModelsServiceLabels } from "../desktop/ModelsServiceView";
import type { ProjectsBoardColumnModel, ProjectsBoardLabels } from "../desktop/ProjectsBoardView";

export function createOverviewServiceFixture(zh: boolean): { model: OverviewServiceStripModel; labels: OverviewServiceStripLabels } {
  return {
    model: {
      running: true,
      statusTitle: zh ? "运行中" : "Running",
      statusSubtitle: zh ? "本地代理 · 已运行 5 分钟" : "Local proxy · up for 5m",
      usageLabel: zh ? "今日消耗" : "Usage today",
      usageValue: zh ? "1.92亿" : "192M",
      usageUnit: "Tokens",
      accessLabel: zh ? "客户端接入" : "Client access",
      detailLabel: zh ? "接入详情" : "Details",
      endpoints: { openai: "http://127.0.0.1:18640/v1", anthropic: "http://127.0.0.1:18640/anthropic" },
      tokenLabel: zh ? "客户端 Token" : "Client Token",
      clientToken: "flw_demo_local_token",
    },
    labels: {
      copyBaseUrl: zh ? "复制 Base URL" : "Copy Base URL",
      testConnection: zh ? "测试连接" : "Test connection",
      copyToken: zh ? "复制 Client Token" : "Copy client token",
      showToken: zh ? "显示 Client Token" : "Show client token",
      hideToken: zh ? "隐藏 Client Token" : "Hide client token",
    },
  };
}

export function createUsageSummaryFixture(zh: boolean): UsageSummaryItem[] {
  return [
    { id: "tokens", label: "Tokens", value: "8.42M", detail: zh ? "输入 6.1M · 输出 2.3M" : "6.1M in · 2.3M out" },
    { id: "cost", label: zh ? "预估费用" : "Est. cost", value: "$12.84", detail: zh ? "按模型价格估算" : "Based on model pricing" },
    { id: "cache", label: zh ? "缓存命中" : "Cache hit", value: "38.6%", detail: zh ? "节省约 3.2M Token" : "About 3.2M tokens saved" },
  ];
}

export function createRequestLogsFixture(zh: boolean): {
  stats: RequestLogsStatItem[];
  rows: RequestLogsRowModel[];
  labels: RequestLogsLabels;
} {
  return {
    stats: [
      { key: "success", label: zh ? "成功率" : "Success rate", value: "98.4%", hint: zh ? "当前筛选范围" : "Current filter range", success: true },
      { key: "duration", label: zh ? "平均总耗时" : "Avg duration", value: "1.4s", hint: `TTFT ${zh ? "842ms" : "842 ms"}` },
      { key: "rate", label: zh ? "平均输出速率" : "Output rate", value: "38.2 tok/s", hint: zh ? "从首 Token 到完成" : "From first token" },
      { key: "tokens", label: "Token", value: "18.42K", hint: zh ? "缓存命中率 38.6%" : "Cache hit 38.6%" },
    ],
    rows: [
      {
        id: "req-1",
        time: "14:32:18",
        client: "Claude Code",
        model: "flowlet-pro",
        method: "POST",
        path: "/v1/responses",
        channel: "DeepSeek",
        account: "工作账号",
        status: "success",
        statusLabel: zh ? "成功" : "Success",
        duration: "1.8s",
        streaming: true,
        detail: `TTFT 842ms · 42.3 tok/s`,
        tokens: "12.4K",
        cost: "¥0.36",
      },
      {
        id: "req-2",
        time: "14:30:54",
        client: "Codex",
        model: "qwen3.8-max",
        method: "POST",
        path: "/chat/completions",
        channel: "Qwen",
        account: "Token 计划",
        status: "success",
        statusLabel: zh ? "成功" : "Success",
        duration: "2.4s",
        detail: `TTFT 1.2s · 21.8 tok/s`,
        tokens: "4.1K",
        cost: "¥0.09",
      },
      {
        id: "req-3",
        time: "14:28:09",
        client: "OpenCode",
        model: "flowlet-pro",
        method: "POST",
        path: "/v1/responses",
        channel: "DeepSeek",
        account: "工作账号",
        status: "success",
        statusLabel: zh ? "成功" : "Success",
        duration: "3.1s",
        detail: `TTFT 1.6s · 18.4 tok/s`,
        tokens: "9.8K",
        cost: "¥0.21",
      },
      {
        id: "req-4",
        time: "14:24:47",
        client: "Pi",
        model: "longcat-2.0",
        method: "POST",
        path: "/chat/completions",
        channel: "LongCat",
        account: "标准账号",
        status: "success",
        statusLabel: zh ? "成功" : "Success",
        duration: "1.2s",
        detail: `TTFT 690ms · 30.1 tok/s`,
        tokens: "6.7K",
        cost: "¥0.14",
      },
    ],
    labels: {
      time: zh ? "时间" : "Time",
      client: zh ? "客户端" : "Client",
      modelInterface: zh ? "模型 / 接口" : "Model / interface",
      channelAccount: zh ? "渠道 / 账号" : "Channel / account",
      status: zh ? "状态" : "Status",
      performance: zh ? "性能" : "Performance",
      token: "Token",
      cost: zh ? "费用" : "Cost",
      stream: zh ? "流式" : "Stream",
      emptyTitle: zh ? "没有找到请求日志" : "No request logs found",
      emptyDesc: zh ? "发起一次模型请求，或调整当前筛选条件后再试。" : "Make a request or adjust the filters.",
    },
  };
}

export function createAgentSessionsFixture(zh: boolean): {
  rows: AgentSessionRowModel[];
  labels: AgentSessionsLabels;
} {
  return {
    rows: [
      {
        id: "ses-1",
        activityAt: "14:32",
        title: zh ? "修复代理请求归属" : "Fix request attribution",
        subtitle: "Claude Code · Flowlet",
        client: "Claude Code",
        requests: "24",
        tokens: "24.8K",
        cost: "¥0.58",
        status: zh ? "运行中" : "Running",
        statusTone: "running",
        statusHint: zh ? "请求正常" : "Healthy",
      },
      {
        id: "ses-2",
        activityAt: "14:05",
        title: zh ? "完善官网 Demo 交互" : "Polish website demo",
        subtitle: "Codex · Website",
        client: "Codex Desktop",
        requests: "18",
        tokens: "31.2K",
        cost: "¥0.86",
        status: zh ? "空闲" : "Idle",
        statusTone: "idle",
        statusHint: zh ? "本地会话" : "Local session",
      },
      {
        id: "ses-3",
        activityAt: "13:48",
        title: zh ? "检查移动端布局" : "Check mobile layout",
        subtitle: "OpenCode · Mobile",
        client: "OpenCode",
        requests: "9",
        tokens: "12.1K",
        cost: "¥0.22",
        status: zh ? "空闲" : "Idle",
        statusTone: "idle",
        statusHint: zh ? "本地会话" : "Local session",
      },
      {
        id: "ses-4",
        activityAt: "12:21",
        title: zh ? "优化账号编辑器" : "Refine account editor",
        subtitle: "Pi · Desktop",
        client: "Pi",
        requests: "6",
        tokens: "8.4K",
        cost: "¥0.16",
        status: zh ? "空闲" : "Idle",
        statusTone: "idle",
        statusHint: zh ? "本地会话" : "Local session",
      },
    ],
    labels: {
      activity: zh ? "最近活动" : "Activity",
      session: zh ? "主会话" : "Session",
      client: zh ? "客户端" : "Client",
      requests: zh ? "请求" : "Requests",
      token: "Token",
      cost: zh ? "费用" : "Cost",
      status: zh ? "状态" : "Status",
      total: zh ? "共 4 个主会话" : "4 sessions total",
    },
  };
}

export type UsageAnalysisDemoDimension = "model" | "account" | "client" | "device";

export function createUsageAnalysisFixture(
  zh: boolean,
  dimension: UsageAnalysisDemoDimension = "model",
  metric: "tokens" | "cost" = "tokens",
): {
  entries: UsageAnalysisRankEntryModel[];
  columns: UsageAnalysisMatrixColumnModel[];
  rows: UsageAnalysisMatrixRowModel[];
  detail: UsageAnalysisDetailModel;
  labels: UsageAnalysisLabels;
} {
  const fixture = {
    entries: [
      { key: "flowlet-pro", label: "flowlet-pro", sublabel: "DeepSeek · 工作账号", badge: { letter: "F" }, tokenValue: "6.42M", tokenShare: "46%", costValue: "$8.21", costShare: "51%" },
      { key: "qwen3.8-max", label: "qwen3.8-max", sublabel: "Qwen · Token 计划", badge: { letter: "Q" }, tokenValue: "3.11M", tokenShare: "22%", costValue: "$3.44", costShare: "21%" },
      { key: "longcat-2.0", label: "longcat-2.0", sublabel: "LongCat · 标准账号", badge: { letter: "L" }, tokenValue: "2.04M", tokenShare: "15%", costValue: "$2.18", costShare: "13%" },
      { key: "deepseek-v4", label: "deepseek-v4-pro", sublabel: "DeepSeek · 个人账号", badge: { letter: "D" }, tokenValue: "1.68M", tokenShare: "12%", costValue: "$2.02", costShare: "12%" },
    ],
    columns: [
      { key: "deepseek", label: "DeepSeek", shortLabel: "DS" },
      { key: "qwen", label: "Qwen", shortLabel: "QW" },
      { key: "longcat", label: "LongCat", shortLabel: "LC" },
      { key: "openrouter", label: "OpenRouter", shortLabel: "OR" },
    ],
    rows: [
      { key: "flowlet-pro", label: "flowlet-pro", cells: [
        { value: "4.2M", level: 4 },
        { value: "1.1M", level: 2 },
        { value: "612K", level: 1 },
        { value: "312K", level: 0 },
      ] },
      { key: "qwen3.8-max", label: "qwen3.8-max", cells: [
        { value: "412K", level: 1 },
        { value: "2.4M", level: 3 },
        { value: "188K", level: 0 },
        { value: "—", level: 0, empty: true },
      ] },
      { key: "longcat-2.0", label: "longcat-2.0", cells: [
        { value: "124K", level: 0 },
        { value: "96K", level: 0 },
        { value: "1.8M", level: 3 },
        { value: "—", level: 0, empty: true },
      ] },
      { key: "deepseek-v4", label: "deepseek-v4-pro", cells: [
        { value: "1.4M", level: 2 },
        { value: "82K", level: 0 },
        { value: "—", level: 0, empty: true },
        { value: "—", level: 0, empty: true },
      ] },
    ],
    detail: {
      label: "flowlet-pro",
      inputOutput: zh ? "6.1M / 2.3M" : "6.1M / 2.3M",
      outputSpeed: "38.4 tok/s",
      cacheHitRate: "38.6%",
      meta: zh ? "124 次请求 · 8 条 Agent 原生事件 · 平均耗时 1.4s" : "124 requests · 8 native events · avg 1.4s",
    },
    labels: {
      dimensionTitle: zh ? "多维归因" : "Attribution",
      dimensionSubtitle: zh ? "切换主维度，再交叉查看 Token 与费用归因" : "Switch dimension to compare tokens & cost",
      rankObject: zh ? "对象" : "Object",
      rankToken: "Token / 占比",
      rankCost: zh ? "预估费用" : "Est. cost",
      matrixTitle: zh ? "交叉归因矩阵" : "Cross matrix",
      matrixSubtitle: zh ? "模型 × 渠道账号，颜色越深消耗越高" : "Model × account, darker = higher",
      metricTokens: "Token",
      metricCost: zh ? "预估费用" : "Est. cost",
      selected: zh ? "已选中" : "Selected",
      inputOutput: zh ? "输入 / 输出" : "In / Out",
      outputSpeed: zh ? "输出速度" : "Output speed",
      cacheHitRate: zh ? "缓存命中率" : "Cache hit",
      heatLow: zh ? "少" : "Low",
      heatHigh: zh ? "多" : "High",
      emptyCell: zh ? "该组合暂无数据" : "No data",
    },
  };

  const variants: Record<UsageAnalysisDemoDimension, {
    entries: Array<[string, string, string]>;
    columns: Array<[string, string, string]>;
    subtitle: string;
  }> = {
    model: {
      entries: fixture.entries.map((entry) => [entry.key, entry.label, entry.sublabel ?? ""]),
      columns: fixture.columns.map((column) => [column.key, column.label, column.shortLabel]),
      subtitle: zh ? "模型 × 渠道账号，颜色越深消耗越高" : "Model × account, darker = higher",
    },
    account: {
      entries: [
        ["work-account", zh ? "DeepSeek · 工作账号" : "DeepSeek · Work", "DeepSeek"],
        ["token-plan", zh ? "Qwen · Token 计划" : "Qwen · Token plan", "Qwen"],
        ["standard-account", zh ? "LongCat · 标准账号" : "LongCat · Standard", "LongCat"],
        ["personal-account", zh ? "DeepSeek · 个人账号" : "DeepSeek · Personal", "DeepSeek"],
      ],
      columns: [
        ["flowlet-pro", "flowlet-pro", "pro"],
        ["qwen3.8-max", "qwen3.8-max", "qwen"],
        ["longcat-2.0", "longcat-2.0", "LC"],
        ["deepseek-v4-pro", "deepseek-v4-pro", "DS"],
      ],
      subtitle: zh ? "渠道账号 × 模型，颜色越深消耗越高" : "Account × model, darker = higher",
    },
    client: {
      entries: [
        ["codex-desktop", "Codex Desktop", zh ? "桌面端" : "Desktop"],
        ["claude-code", "Claude Code", "CLI"],
        ["opencode", "OpenCode", "CLI"],
        ["pi", "Pi", "CLI"],
      ],
      columns: [
        ["flowlet-pro", "flowlet-pro", "pro"],
        ["qwen3.8-max", "qwen3.8-max", "qwen"],
        ["longcat-2.0", "longcat-2.0", "LC"],
        ["deepseek-v4-pro", "deepseek-v4-pro", "DS"],
      ],
      subtitle: zh ? "客户端 × 模型，颜色越深消耗越高" : "Client × model, darker = higher",
    },
    device: {
      entries: [
        ["local", zh ? "本机" : "This device", "Windows 11"],
        ["studio", zh ? "工作室电脑" : "Studio PC", "Windows 11"],
        ["laptop", zh ? "移动工作站" : "Laptop", "macOS"],
        ["server", zh ? "家庭服务器" : "Home server", "Linux"],
      ],
      columns: [
        ["flowlet-pro", "flowlet-pro", "pro"],
        ["qwen3.8-max", "qwen3.8-max", "qwen"],
        ["longcat-2.0", "longcat-2.0", "LC"],
        ["deepseek-v4-pro", "deepseek-v4-pro", "DS"],
      ],
      subtitle: zh ? "设备 × 模型，颜色越深消耗越高" : "Device × model, darker = higher",
    },
  };
  const variant = variants[dimension];
  const costValues = [
    ["$5.12", "$1.42", "$0.96", "$0.71"],
    ["$0.74", "$2.18", "$0.41", "—"],
    ["$0.22", "$0.18", "$1.78", "—"],
    ["$1.36", "$0.11", "—", "—"],
  ];
  const entries = fixture.entries.map((entry, index) => ({
    ...entry,
    key: variant.entries[index][0],
    label: variant.entries[index][1],
    sublabel: variant.entries[index][2],
  }));
  const rows = fixture.rows.map((row, rowIndex) => ({
    ...row,
    key: entries[rowIndex].key,
    label: entries[rowIndex].label,
    cells: row.cells.map((cell, columnIndex) => ({
      ...cell,
      level: cell.level as 0 | 1 | 2 | 3 | 4,
      value: metric === "cost" ? costValues[rowIndex][columnIndex] : cell.value,
    })),
  }));

  return {
    ...fixture,
    entries,
    columns: variant.columns.map(([key, label, shortLabel]) => ({ key, label, shortLabel })),
    rows,
    detail: { ...fixture.detail, label: entries[0].label },
    labels: { ...fixture.labels, matrixSubtitle: variant.subtitle },
  };
}

export function createModelsServiceFixture(zh: boolean): {
  stats: ModelsServiceStatModel[];
  groups: { aggregate: ModelsServiceItemModel[]; direct: ModelsServiceItemModel[] };
  labels: ModelsServiceLabels;
} {
  return {
    stats: [
      { key: "models", label: zh ? "对外模型" : "Models", value: "15" },
      { key: "enabled", label: zh ? "已启用" : "Enabled", value: "2", tone: "success" },
      { key: "channels", label: zh ? "已接入渠道" : "Channels", value: "7" },
    ],
    groups: {
      aggregate: [
        { id: "flowlet-pro", kind: "aggregate", name: "flowlet-pro", typeLabel: zh ? "Flowlet · 聚合模型" : "Flowlet · Aggregate", summary: zh ? "2 个可用账号" : "2 accounts", enabled: true, logo: "/flowlet-logo.png" },
        { id: "flowlet-flash", kind: "aggregate", name: "flowlet-flash", typeLabel: zh ? "Flowlet · 聚合模型" : "Flowlet · Aggregate", summary: zh ? "3 个可用账号" : "3 accounts", enabled: true, logo: "/flowlet-logo.png" },
      ],
      direct: [
        { id: "deepseek-v4-flash", kind: "direct", name: "deepseek-v4-flash", typeLabel: "DeepSeek · 渠道模型", summary: zh ? "已加入 2 个聚合模型" : "In 2 aggregates", enabled: false, logo: "/icons/lobe/deepseek-color.svg" },
        { id: "deepseek-v4-pro", kind: "direct", name: "deepseek-v4-pro", typeLabel: "DeepSeek · 渠道模型", summary: zh ? "尚未加入路由" : "Not routed", summaryMuted: true, enabled: false, logo: "/icons/lobe/deepseek-color.svg" },
        { id: "glm-4.5-air", kind: "direct", name: "glm-4.5-air", typeLabel: "Z.AI · 渠道模型", summary: zh ? "已加入 1 个聚合模型" : "In 1 aggregate", enabled: false, logo: "/icons/lobe/zhipu-color.svg" },
        { id: "glm-4.7", kind: "direct", name: "glm-4.7", typeLabel: "Z.AI · 渠道模型", summary: zh ? "已加入 1 个聚合模型" : "In 1 aggregate", enabled: false, logo: "/icons/lobe/zhipu-color.svg" },
        { id: "glm-5.2", kind: "direct", name: "glm-5.2", typeLabel: "Z.AI · 渠道模型", summary: zh ? "尚未加入路由" : "Not routed", summaryMuted: true, enabled: false, logo: "/icons/lobe/zhipu-color.svg" },
        { id: "longcat-2.0", kind: "direct", name: "longcat-2.0", typeLabel: "LongCat · 渠道模型", summary: zh ? "已加入 1 个聚合模型" : "In 1 aggregate", enabled: false, logo: "/icons/lobe/longcat-color.svg" },
        { id: "kimi-k3", kind: "direct", name: "kimi-k3", typeLabel: "Kimi · 渠道模型", summary: zh ? "已加入 1 个聚合模型" : "In 1 aggregate", enabled: false, logo: "/icons/lobe/kimi-color.svg" },
        { id: "kimi-k2.7-code", kind: "direct", name: "kimi-k2.7-code", typeLabel: "Kimi · 渠道模型", summary: zh ? "尚未加入路由" : "Not routed", summaryMuted: true, enabled: false, logo: "/icons/lobe/kimi-color.svg" },
        { id: "qwen3.8-max", kind: "direct", name: "qwen3.8-max", typeLabel: "Qwen · 渠道模型", summary: zh ? "已加入 1 个聚合模型" : "In 1 aggregate", enabled: false, logo: "/icons/lobe/qwen-color.svg" },
        { id: "qwen3.7-max", kind: "direct", name: "qwen3.7-max", typeLabel: "Qwen · 渠道模型", summary: zh ? "尚未加入路由" : "Not routed", summaryMuted: true, enabled: false, logo: "/icons/lobe/qwen-color.svg" },
        { id: "qwen3.7-plus", kind: "direct", name: "qwen3.7-plus", typeLabel: "Qwen · 渠道模型", summary: zh ? "尚未加入路由" : "Not routed", summaryMuted: true, enabled: false, logo: "/icons/lobe/qwen-color.svg" },
        { id: "qwen3.7-flash", kind: "direct", name: "qwen3.7-flash", typeLabel: "Qwen · 渠道模型", summary: zh ? "尚未加入路由" : "Not routed", summaryMuted: true, enabled: false, logo: "/icons/lobe/qwen-color.svg" },
        { id: "qwen3.6-plus", kind: "direct", name: "qwen3.6-plus", typeLabel: "Qwen · 渠道模型", summary: zh ? "尚未加入路由" : "Not routed", summaryMuted: true, enabled: false, logo: "/icons/lobe/qwen-color.svg" },
      ],
    },
    labels: {
      stats: {},
      aggregateGroup: zh ? "聚合模型" : "Aggregate",
      directGroup: zh ? "渠道模型" : "Direct",
      statsAria: zh ? "模型服务统计" : "Model service summary",
      currentVisible: zh ? "当前显示 15 / 共 15 个模型" : "Showing 15 of 15 models",
      hint: zh ? "选择模型后在右侧查看详情" : "Select a model to view details",
      ready: zh ? "可用" : "Ready",
      off: zh ? "关闭" : "Off",
      empty: zh ? "没有匹配的模型" : "No matching models",
    },
  };
}

export function createProjectsBoardFixture(zh: boolean): {
  columns: ProjectsBoardColumnModel[];
  labels: ProjectsBoardLabels;
} {
  return {
    columns: [
      {
        id: "queued",
        title: zh ? "待处理" : "Queued",
        count: 2,
        tone: "primary",
        tasks: [
          { id: "t-1", title: zh ? "补齐官网产品演示的共享组件" : "Complete shared website demo components", roundLabel: zh ? "第 1 轮" : "Round 1", contextLabel: zh ? "代码修改 · Codex" : "Code · Codex", status: "queued", meta: zh ? "等待 1 min" : "Waiting 1 min" },
          { id: "t-2", title: zh ? "检查桌面端 1200×720 布局" : "Check the 1200×720 desktop layout", roundLabel: zh ? "第 1 轮" : "Round 1", contextLabel: zh ? "只读分析 · Claude Code" : "Analysis · Claude Code", status: "queued", meta: zh ? "等待 2 min" : "Waiting 2 min" },
        ],
      },
      {
        id: "running",
        title: zh ? "进行中" : "Running",
        count: 1,
        tone: "primary",
        tasks: [
          { id: "t-3", title: zh ? "统一任务看板与官网 Demo" : "Unify the task board and website demo", roundLabel: zh ? "第 1 轮" : "Round 1", contextLabel: zh ? "代码修改 · OpenCode" : "Code · OpenCode", status: "running", meta: zh ? "执行 3m 24s" : "Running 3m 24s", trailing: zh ? "4.28M tokens ≈¥0.22" : "4.28M tokens ≈¥0.22" },
        ],
      },
      {
        id: "review",
        title: zh ? "待审核" : "Review",
        count: 2,
        tone: "warning",
        tasks: [
          { id: "t-4", title: zh ? "修复请求日志底部分页布局" : "Fix request log footer pagination", roundLabel: zh ? "第 1 轮" : "Round 1", contextLabel: zh ? "代码修改 · Claude Code" : "Code · Claude Code", status: "review", meta: zh ? "执行 8 min" : "Ran 8 min", trailing: zh ? "7.90M tokens ≈¥0.39" : "7.90M tokens ≈¥0.39" },
          { id: "t-5", title: zh ? "完善多维归因矩阵折叠规则" : "Refine attribution matrix collapsing", roundLabel: zh ? "第 2 轮" : "Round 2", contextLabel: zh ? "代码修改 · Pi" : "Code · Pi", status: "review", meta: zh ? "执行 5.4 min" : "Ran 5.4 min", trailing: zh ? "3.16M tokens ≈¥0.18" : "3.16M tokens ≈¥0.18" },
        ],
      },
    ],
    labels: {
      emptyHint: zh ? "暂无任务" : "No tasks",
      running: zh ? "运行中" : "Running",
    },
  };
}
