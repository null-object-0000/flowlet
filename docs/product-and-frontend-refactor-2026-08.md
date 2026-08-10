# Flowlet 产品表达与前端共享化改版说明

> 状态：进行中，本文记录 2026 年 8 月首个正式版本准备阶段的产品、文档、官网与前端架构改版。

## 1. 为什么进行这次改版

Flowlet 已经具备模型账号管理、本地代理、Agent 接入、请求日志、会话观测、用量成本和项目任务等能力，但此前对外表达仍偏向“本地 AI 请求路由客户端”。这个描述技术上没有错，却没有直接回答用户最关心的问题：在已有大量网关、模型客户端和 Agent 工具的情况下，Flowlet 能带来什么不同价值。

本次改版形成的核心表达是：

> **让多个 AI Agent 共用一个可控、可追溯的本地模型入口。**

它对应四个直接的用户收益：

1. Agent 只配置一次本地入口，模型、渠道和账号可以在 Flowlet 中统一切换；
2. 多个上游账号可以组成稳定服务，并在候选失败时降级；
3. Agent 会话、真实上游请求、路由结果、Token 和费用可以串成证据链；
4. 凭据、配置、请求证据和控制权默认保留在用户自己的设备上。

Flowlet 的主要差异化不再表述为“功能更多的通用 LLM 网关”，而是面向本地 AI Agent 工作流的模型服务控制台和观测入口。

## 2. 本会话完成的产品与文档工作

### 2.1 README 精简

README 从完整功能手册调整为面向首次访问者的产品入口，只保留：

- Flowlet 能解决什么问题；
- 用户为什么值得安装；
- 核心能力和支持范围概览；
- 最短开始使用路径；
- 本地优先与平台验证说明；
- 指向详细文档的链接。

复杂协议边界、配置字段和实现细节继续由 `docs/` 中的专项文档承载，避免 README 在用户理解产品之前就进入实现层。

### 2.2 CHANGELOG 收敛

`CHANGELOG.md` 的 `0.1.0` 条目改为版本级摘要，不再逐项记录开发过程中每一个内部变化。内容聚焦正式版本提供的主要能力和分发说明。

### 2.3 平台验证声明

README、CHANGELOG 和官网统一说明：

- 当前主要开发与完整回归环境是 Windows 11 原生环境；
- 开发主力机器未启用 WSL；
- macOS 与 Linux 产物由 GitHub Actions 自动构建；
- macOS 与 Linux 尚未完成作者真机回归；
- 后续完成其他系统和环境验证后再更新支持状态；
- 当前桌面产物尚未签名，系统可能显示未知发布者提示。

这一区分的是“提供构建产物”和“已经完成真机验证”，避免发布页对支持程度作过度承诺。

### 2.4 移动端能力描述修正

移动端不再被描述为只能“处理 OpenCode 权限请求”。更准确的能力边界是：

- 查看多设备用量、会话、项目和 Agent 状态；
- 通过局域网或自有 S3 获取同步数据；
- 提交项目任务；
- 处理 Agent 的交互确认；
- 当前已经实现的交互确认适配首先是 OpenCode，未来可以扩展其他 Agent。

即“Agent 交互确认”是产品能力，“OpenCode 权限请求”只是当前首个适配实现。

## 3. 官网信息架构改版

旧官网已经整体重构，不再以长功能列表堆叠产品能力。

### 3.1 首屏

首屏改为单列价值表达，中文主标题为：

> **一个入口，连接你的 AI Agent。**

英文主标题为：

> **One endpoint for your AI agents.**

副标题进一步说明统一切换模型，以及追踪请求与成本的价值。原本放在首屏右侧、尺寸过小且内容不完整的产品示意图已经移除。

### 3.2 第二屏交互式产品预览

产品演示移动到第二屏，并改为完整的交互区域：

- PC Demo 使用 `1200 × 720` 的产品设计基准；
- 可以切换运行概览、模型服务、项目管理、请求日志、会话管理和用量洞察；
- 不再使用静态截图或官网独立仿画的 UI；
- 官网通过固定 fixtures 向共享展示组件注入 Demo 数据；
- 手机宽度下侧栏切换为横向菜单，以便继续浏览演示页面。

### 3.3 后续内容层级

官网正文围绕以下顺序组织：

1. Flowlet 真正解决的问题；
2. 从 Agent 会话到真实请求和成本的可追溯链路；
3. 支持的 Agent、模型渠道与实验性移动端；
4. 本地优先和协议透明边界；
5. 三步开始使用；
6. 下载、GitHub 和平台验证说明。

## 4. 前端共享化的目标

此前真实桌面应用、移动端和官网 Demo 分别维护 UI。即使官网努力模仿实际应用，也会产生以下问题：

- 产品页面改版后官网很快失真；
- 官网 Demo 容易使用过小字号或不完整布局；
- 同一种卡片、表格和页面状态存在多套 CSS；
- 调试应用页面往往必须同时启动 Tauri/Rust；
- Demo 数据无法直接用于页面回归和沟通。

本次建立仓库级 `packages/product-ui` 纯展示层，使三类消费者使用同一组视图组件：

```text
真实桌面 / 移动应用
  Query、Tauri command、Router、业务 Hook
                  │
                  ▼
       页面容器映射 View Model
                  │
                  ▼
        packages/product-ui
                  ▲
                  │
       fixtures + 本地交互状态
                  │
          官网 / 独立 Demo 模式
```

这不是把真实数据库或 Tauri command 暴露给官网，而是让真实数据和 Demo 数据最终进入同一个展示层。

## 5. `product-ui` 的职责边界

目录：`packages/product-ui/`

共享层允许包含：

- React 纯展示组件；
- Semi Design 组件和图标；
- CSS Modules 与 Flowlet Design Tokens；
- 可序列化 View Model 类型；
- 用户动作回调；
- 官网和独立调试使用的 fixtures；
- 只影响展示的局部交互状态，例如协议标签切换、Token 显隐和选中行。

共享层禁止包含：

- Tauri command 或 `invoke`；
- TanStack Query；
- 应用 Router；
- 读取真实配置、凭据、SQLite 或文件系统；
- 具体业务领域 Hook；
- 真实模式下的保存、同步、删除或授权流程。

真实应用页面仍然负责 loading、error、empty、ready 状态，负责把领域数据映射为 View Model，并在回调中执行真实业务动作。

## 6. 当前已经共享的 PC 页面能力

### 6.1 应用壳

`DesktopAppFrameView` 提供桌面布局边界，真实 `AppShell` 和官网 Demo 共用它。共享内容包括侧栏尺寸、主内容区域、背景、边框和内嵌 Demo 的响应式布局。

真实应用仍单独保留：

- 无系统边框窗口控制按钮；
- Tauri 窗口拖动与最大化；
- 后台 Agent 数据同步；
- Codex 账号同步；
- 渠道资源同步；
- Router 的真实导航。

### 6.2 运行概览

已共享：

- 服务状态、今日 Token、客户端协议地址和 Client Token 的服务条；
- 概览页 2×2 主布局；
- 模块卡结构；
- 官网与独立调试使用的完整概览 Demo View。

真实应用继续使用真实代理状态、真实账号、路由、余额、Agent 环境检测和相关操作回调。

### 6.3 请求日志

真实 `RequestLogsPage` 保留筛选、统计查询、分页、详情抽屉和重试动作，将结果映射为 `RequestLogsView` 所需的行模型。官网和独立 Demo 使用 `RequestLogsDemoView` 与固定日志数据。

### 6.4 Agent 会话

真实 `AgentSessionsPage` 保留会话查询、原生摘要补充、Token/费用 Tooltip、同步任务、分页和详情抽屉，将结果映射为 `AgentSessionsView`。官网使用相同 View 的 Demo 版本。

### 6.5 用量洞察

真实 `UsageAnalysisPage` 保留统计查询、维度切换、矩阵计算、全量展开 SideSheet 和费用语义，把排行、矩阵和详情映射为 `UsageAnalysisView`。官网使用固定数据生成同一种排行与交叉矩阵。

### 6.6 已有共享 Demo、尚未迁移真实页面

以下页面已经具备共享 View 和 Demo fixtures，但真实应用页面还没有切换到这些 View：

- 模型服务：`ModelsServiceView` / `ModelsServiceDemoView`；
- 项目管理：`ProjectsBoardView` / `ProjectsBoardDemoView`。

它们当前用于官网和 `dev:frontend`，不能据此声称真实页面已经完成共享化。

## 7. 移动端当前状态

移动端本轮完成的是概览用量摘要组件 `UsageSummaryGridView` 的共享。真实 `MobileOverviewPage` 继续读取真实移动端数据，并将 Token、请求数、缓存命中和费用映射为共享摘要项。

尚未完成：

- 完整移动端应用壳共享；
- 移动端会话、项目、用量等完整页面 View Model 化；
- 官网中的独立移动端产品演示；
- 不依赖移动端后端连接的完整 `dev:frontend:mobile` 模式。

因此目前应该表述为“PC 共享化主体已经建立，移动端从概览摘要开始迁移”，而不是“PC 和移动端所有页面已经完全共用”。

## 8. 无后端的前端调试模式

新增命令：

```bash
npm run dev:frontend
```

它使用 Vite `demo` mode 加载 `src/demo/DesktopDemoApp.tsx`，不会：

- 启动 Tauri；
- 连接 Rust 后端；
- 注册真实窗口拖动动作；
- 调用真实 command；
- 读取用户账号、凭据或数据库。

当前可以独立调试：

- 应用壳与侧栏；
- 运行概览；
- 模型服务 Demo；
- 项目管理 Demo；
- 请求日志 Demo；
- Agent 会话 Demo；
- 用量洞察 Demo。

任务日志、用量统计和设置暂时显示明确的未接入提示，不伪装成已经完成的 Demo 页面。

真实桌面模式继续使用：

```bash
npm run tauri:dev
```

移动端前端继续使用：

```bash
npm run dev:mobile
```

官网使用：

```bash
npm run website:dev
```

## 9. 构建和模块解析

根应用、官网和 Vitest 都增加了 `@flowlet/product-ui` alias，并对 React、React DOM、Semi UI 和 Semi Icons 进行 dedupe，避免工作区源码被不同入口加载时出现重复 React 实例。

相关配置：

- `vite.config.ts`；
- `website/vite.config.ts`；
- `tsconfig.json`；
- `website/tsconfig.json`；
- `src/vitest.config.ts`。

共享包使用 peer dependencies 表达 React 和 Semi 依赖，不单独持有运行时数据源。

## 10. 数据、配置和运行时影响

本次前端共享化：

- 没有修改 SQLite 表结构；
- 没有新增或修改 Tauri command；
- 没有修改 `config.json` 字段或默认值；
- 没有改变代理协议、路由、日志捕获或 Agent 配置写入逻辑；
- 不需要进行数据迁移；
- 不需要重启本地代理来应用数据变化。

开发环境中的展示组件和 CSS 支持 Vite HMR。生产环境需要重新构建和安装前端产物；这与代理配置热更新无关。

## 11. 验证记录

截至本文建立时已经运行：

```text
npm run check
  通过

npm --prefix website run check
  通过

受影响页面 Vitest
  5 个测试文件通过
  23 个测试通过
```

相关测试覆盖概览服务条、概览网格、聚合模型卡、Agent 会话、请求日志和用量洞察。最终合并或发布前仍应运行：

```bash
npm run build
npm run build:mobile
npm run website:build
npm test
git diff --check
```

构建过程中 `lottie-web` 的 direct `eval` 警告是现有第三方依赖警告，不应误报为本次共享化引入的新错误；但最终验收必须记录其真实输出。

## 12. 后续建议

建议按以下顺序继续迁移：

1. 将真实模型服务页面接入 `ModelsServiceView`；
2. 将真实项目看板接入 `ProjectsBoardView`；
3. 为任务日志、用量统计和设置建立共享展示模型；
4. 抽取完整移动端应用壳和主要页面；
5. 增加 `dev:frontend:mobile`；
6. 为 `packages/product-ui` 增加独立的组件与 fixture 测试；
7. 在官网自动化检查中固定验证 `1200 × 720` PC Demo、移动宽度菜单和中英文切换；
8. 共享 Design Tokens 的单一来源，减少官网和应用各自维护相似 Token 的漂移风险。

迁移过程中应继续坚持：业务容器负责真实状态与动作，共享层负责展示；不要为了让官网可运行而把真实 command 替换成全局 mock，也不要让 Demo fixtures 进入真实数据链路。
