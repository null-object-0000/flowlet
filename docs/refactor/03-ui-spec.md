# 桌面 UI 重构详细规格

> 本文档定义 Flowlet 破坏式重构后桌面端 UI 的页面结构、组件设计和交互流程。

---

## 1. 导航结构

```
Flowlet
├── 概览 (Overview)
├── 渠道账号 (Channels)
│   ├── LongCat
│   │   ├── 账号列表
│   │   ├── 新增账号
│   │   └── 测试连接
│   └── DeepSeek
│       ├── 账号列表
│       ├── 新增账号
│       ├── 测试连接
│       └── 余额查询
├── Claude Code
├── 客户端 Token (Clients)
├── 路由配置 (Routes)
├── 请求日志 (Logs)
├── 用量统计 (Usage)
└── 设置 (Settings)
```

---

## 2. 概览页 (Overview)

### 展示内容

- 代理状态（运行中 / 已停止）
- 启动 / 停止按钮
- Base URL 一键复制
- Client Token 一键复制
- 当前渠道数量
- 当前账号数量
- 今日请求数 / Token / 成本

### 布局

```
┌─────────────────────────────────────────┐
│  Flowlet                     [启动][停止] │
├─────────────────────────────────────────┤
│  Base URL: http://127.0.0.1:18640/v1    │
│  Client Token: Bearer xxx               │
├─────────────────────────────────────────┤
│  渠道: 2   账号: 3   客户端: 1          │
│  今日: 42 请求  12.3K Token  $0.024     │
└─────────────────────────────────────────┘
```

---

## 3. 渠道账号页 (Channels)

### 渠道卡片

每个渠道一个卡片，展示：

- 渠道名称（LongCat / DeepSeek）
- 支持的协议（OpenAI-compatible / Anthropic-compatible）
- 账号数量
- 默认模型

### 账号列表

表格形式：

| 账号名称 | API Key | 优先级 | 启用 | 最近使用 | 最近错误 | 操作 |
|----------|---------|--------|------|----------|----------|------|
| 主账号   | sk-xxx  | 0      | ✅   | 2分钟前 | -        | 编辑/删除/测试 |
| 备用账号 | sk-yyy  | 1      | ✅   | 1小时前  | -        | 编辑/删除/测试 |

### 新增账号表单

- 账号名称（文本输入）
- API Key（密码输入）
- 优先级（数字输入）
- 启用（开关）
- 备注（文本输入，可选）

### 测试连接

- 按钮：测试连接
- 结果：成功 / 失败 + 错误信息
- 成功后更新 `last_used_at`

---

## 4. Claude Code 页

### 接入向导

展示配置步骤：

1. 选择渠道（LongCat / DeepSeek）
2. 选择账号
3. 生成配置：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:18640/anthropic"
export ANTHROPIC_AUTH_TOKEN="flowlet-client-token"
```

4. 一键复制按钮

### 配置验证

- 提示用户运行 `claude` 验证
- 展示常见问题排查

---

## 5. 客户端 Token 页 (Clients)

### Token 列表

| 名称 | Token | 应用类型 | 启用 | 操作 |
|------|-------|----------|------|------|
| Claude Code | flowlet-xxx | claude-code | ✅ | 编辑/删除/复制 |
| Cursor | flowlet-yyy | cursor | ✅ | 编辑/删除/复制 |

### 新增 Token

- 名称
- Token（自动生成或手动输入）
- 应用类型（下拉选择：claude-code, cursor, cline, open-webui, cherry-studio, continue, custom）
- 启用

---

## 6. 路由配置页 (Routes)

### 虚拟模型列表

展示所有虚拟模型（auto, cheap-auto, coding-auto 等）

### 路由候选编辑器

对每个虚拟模型，展示候选列表：

| 优先级 | 渠道 | 账号 | 上游模型 | 协议 | 启用 | 操作 |
|--------|------|------|----------|------|------|------|
| 0 | LongCat | 主账号 | LongCat-2.0 | OpenAI | ✅ | 编辑/删除 |
| 1 | DeepSeek | 备用账号 | deepseek-v4-flash | OpenAI | ✅ | 编辑/删除 |

### 新增候选

- 选择渠道
- 选择账号
- 输入上游模型名
- 选择协议
- 设置优先级

---

## 7. 请求日志页 (Logs)

### 表格

| 时间 | 客户端 | 渠道 | 账号 | 协议 | 公开模型 | 上游模型 | 状态 | 耗时 | 流式 | 降级 | 原因 |
|------|--------|------|------|------|----------|----------|------|------|------|------|------|

### 筛选

- 按客户端
- 按渠道
- 按账号
- 按状态
- 按时间范围

### 详情

点击行展开：

- 完整请求路径
- 错误信息
- 路由原因

---

## 8. 用量统计页 (Usage)

### 汇总卡片

- 今日请求数
- 今日 Token
- 今日成本
- 未知 Token 占比

### 表格

| 日期 | 客户端 | 渠道 | 账号 | 上游模型 | 请求数 | 输入 Token | 输出 Token | 总 Token | 估算成本 |

### 离线分析按钮

- 执行离线分析
- 显示新增 unknown 记录数

---

## 9. 设置页 (Settings)

### 代理设置

- 监听地址（默认 127.0.0.1:18640）
- 上游超时秒数
- 日志级别

### 数据管理

- 数据库路径
- 导出数据
- 清空日志

### 关于

- 版本号
- 开源协议

---

## 10. 交互规范

### 操作反馈

- 所有保存操作显示 toast 提示
- 删除操作需要二次确认
- 测试连接显示 loading 状态

### 表单验证

- API Key 不能为空
- 优先级必须为数字
- 账号名称不能为空

### 错误处理

- 网络错误显示友好提示
- 代理未启动时禁用相关操作

---

## 11. 样式规范

- 中文界面
- 使用系统字体
- 响应式布局（最小 900x620）
- 暗色主题优先

---

## 12. 组件拆分

```
src/
├── main.tsx              # 应用入口
├── components/
│   ├── Sidebar.tsx       # 侧边导航
│   ├── TopBar.tsx        # 顶部栏
│   ├── Overview.tsx      # 概览页
│   ├── Channels.tsx      # 渠道账号页
│   ├── ClaudeCode.tsx    # Claude Code 页
│   ├── Clients.tsx       # 客户端 Token 页
│   ├── Routes.tsx        # 路由配置页
│   ├── Logs.tsx          # 请求日志页
│   ├── Usage.tsx         # 用量统计页
│   ├── Settings.tsx      # 设置页
│   ├── AccountForm.tsx   # 账号表单
│   ├── RouteForm.tsx     # 路由候选表单
│   └── Toast.tsx         # 提示组件
├── hooks/
│   ├── useProxy.ts       # 代理状态管理
│   └── useChannels.ts    # 渠道数据管理
├── types/
│   └── index.ts          # TypeScript 类型定义
└── styles/
    └── app.css           # 全局样式
```

---

## 13. 状态管理

使用 React hooks + 本地状态，不引入 Redux/Zustand：

- `useState` 管理页面级状态
- `useCallback` 管理刷新函数
- `useEffect` 管理初始化加载
- Tauri invoke 调用 Rust 后端

---

## 14. Tauri Commands 映射

| UI 操作 | Tauri Command |
|---------|---------------|
| 启动代理 | `start_proxy` |
| 停止代理 | `stop_proxy` |
| 获取代理状态 | `proxy_status` |
| 列出渠道 | `list_channel_presets` |
| 列出账号 | `list_channel_accounts` |
| 保存账号 | `save_channel_accounts` |
| 列出客户端 | `list_clients` |
| 保存客户端 | `save_clients` |
| 列出路由 | `list_route_candidates` |
| 保存路由 | `save_route_candidates` |
| 列出日志 | `list_request_logs` |
| 列出用量 | `usage_summary` |
| 执行分析 | `analyze_usage` |
| 测试连接 | `test_channel_connection` |
