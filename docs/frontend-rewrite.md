# Flowlet 前端重构方案

状态：核心配置链路已迁移，进入观测和设置阶段
目标目录：src-new  
旧前端目录：src

## 1. 背景

现有前端已经具备可用的产品功能，但状态读取、业务动作、页面编排和 UI 框架之间耦合较深。典型表现包括：

- App 同时承担初始化、状态装配、导航、布局和页面参数传递；
- useFlowletData 集中持有多数领域状态，并通过 refreshAll 全量刷新；
- actions 的类型依赖具体 Hook 返回值；
- command 错误经常被转换为空数组，错误状态与空状态难以区分；
- domain.ts 同时包含领域类型、渠道默认值和产品常量；
- 页面和 feature 之间缺少稳定的依赖方向。

本次重构采用 clean-room frontend。旧前端保持可运行，新前端重新建立边界，不在旧 hooks、actions 和组件上继续演化。

## 2. 目标

- 使用 Semi Design React 19 版本建立新的 UI 基础；
- 页面、业务编排、领域数据和 Tauri command 之间形成单向依赖；
- 按领域查询和精准失效，移除全局 refreshAll 模式；
- loading、error、empty、ready 成为明确的页面状态；
- 代理生命周期保持独立，不与账号和模型配置状态混合；
- 新旧前端在重构期间可以分别启动和构建；
- 新前端完整验收前保留 legacy 回退入口，验收并获批准后再清理旧版。
- 保持旧版已经确认的信息架构、页面布局、模块划分和桌面窗口交互；Semi Design 只用于重建实现与调整视觉细节，不用于擅自重做产品结构。

## 3. 当前非目标

- 新版未完成验收前不删除 legacy、Mantine 或双版本 bootstrap；
- 不提供运行时无重启切换新旧 UI 的能力；
- 没有明确需求前不引入 Redux、Zustand 或其他全局状态库；
- 不因视觉重构擅自改变已经确认的信息架构、功能边界和左侧菜单枚举；
- 不把普通页面重新设计成复杂路由控制台、统计大屏或通用企业网关；
- 不为了新版 UI 复刻一套 Rust 后端或 SQLite 数据。

## 4. 目录和依赖方向

    src-new/
      app/            应用入口、Provider、Router、Shell
      platform/       Tauri 等运行平台适配
      domains/        领域类型、query、mutation、selector
      features/       面向用户动作的业务编排
      pages/          路由页面与页面级状态组合
      shared/         无业务含义的 UI、错误和工具
      styles/         新前端全局样式与 Design Token
      main.tsx        新前端渲染入口

允许的主要依赖方向：

    pages -> features -> domains -> platform
                 \-> shared

约束：

- platform 不依赖 React、Semi、pages 或 features；
- domains 不依赖页面和 UI 框架；
- features 不依赖 pages；
- shared 不导入具体业务领域；
- src-new 不导入旧版 pages、features、app hooks 或 Mantine 组件；
- 旧前端只作为行为和验收参考，不作为新架构的基础层。
- 左侧主导航保持「概览、模型服务、请求日志、用量成本、高级设置」；渠道账号等领域能力继续作为对应页面模块和业务入口，不因技术分层直接升级为主导航。
- Tauri 窗口继续使用无系统边框模式，新壳必须提供可拖动区域以及最小化、最大化、关闭按钮组，并保持关闭窗口时隐藏到托盘的既有行为。

### 4.1 文件体积与样式边界

新前端不得重新形成 `features.css`、`ui.css`、`pages.css` 这类聚合业务样式文件。

目录约定：

    src-new/styles/
      reset.css                 浏览器默认样式重置
      tokens.css                Flowlet Design Tokens 和全局主题变量

    src-new/app/shell/
      AppShell.tsx
      AppShell.module.css

    src-new/pages/overview/
      OverviewPage.tsx
      OverviewPage.module.css

    src-new/features/account-editor/
      AccountEditor.tsx
      AccountEditor.module.css

强制约束：

- `src-new/styles` 只允许 reset、tokens 和少量真正跨应用的全局规则，不得放页面或 feature 样式；
- 页面、feature 和共享组件的样式必须使用同目录 CSS Module；
- 一个 CSS Module 只能服务一个组件或职责紧密的组件组；
- 优先使用 Semi 组件 props 和 Design Token，再增加自定义 CSS；
- 禁止页面或 feature 在全局范围覆盖 `.semi-*`；确有必要时统一进入受控的主题覆盖文件，并记录原因；
- 不得通过不断提高选择器优先级、增加 `!important` 或复制相似规则解决样式冲突；
- CSS Module 达到 200 行时必须评估拆分，超过 300 行不得继续增加功能，必须先拆组件；
- TSX 文件达到 200 行时必须评估拆分；页面只负责组合，复杂表单、表格、Drawer 和业务动作应拆到 feature；
- 禁止为了满足行数阈值进行无意义的机械拆文件；拆分后的模块必须具备明确职责和稳定依赖方向。

构建产物中的 Semi 组件 CSS 体积与项目源码文件体积是两个不同指标。Semi 按组件引入的构建 CSS 应通过 bundle 分析管理，不能以构建 CSS 较大为由把业务样式重新集中到全局文件。
## 5. 应用状态

新前端的数据状态分为三类：

### 5.1 持久化和后端状态

来自 SQLite 或 Tauri command 的数据由 TanStack Query 管理。每个领域维护自己的 query key、query 和 mutation。

mutation 成功后只失效受影响的 query，不执行应用级全量刷新。

### 5.2 页面交互状态

Drawer、Modal、表单草稿、选中项和筛选条件优先放在页面或 feature 本地。

### 5.3 应用级状态

主题、导航折叠状态等少量跨页面 UI 状态可以使用 React Context。没有明确需求前不增加全局状态库。

## 6. Tauri 边界

platform/tauri 是新前端访问 Rust 的唯一入口。

当前基座只提供最小 invokeCommand。进入业务迁移后，每个 Rust command 必须通过领域化且类型明确的函数暴露，例如：

    accountCommands.list()
    accountCommands.create(input)
    proxyCommands.status()
    proxyCommands.start()

页面和组件不得直接拼写 command 名称。

后续需要统一 AppError，区分真实错误、空数据和可重试失败。不得默认将 command failure 转为空集合。

## 7. 路由和 Provider

- 使用 HashRouter，避免桌面安装包对子路径刷新和资源协议的额外要求；
- 使用 TanStack Query 管理后端数据；
- Query 的 networkMode 设为 always，因为 Tauri invoke 不是浏览器网络请求；
- 默认关闭窗口聚焦自动刷新和自动 retry，具体领域按需覆盖；
- React StrictMode 保留，初始化动作必须具备重复执行保护。

## 8. Semi Design

React 19 使用 @douyinfe/semi-ui-19，不使用普通 @douyinfe/semi-ui。

基础约束：

- 直接从 Semi 包导入组件，不增加 Babel import 插件；
- 业务迁移前先确定 Flowlet Design Tokens、明暗主题和基础交互规范；
- 优先使用组件 props，不在基座阶段继承或修改 Semi 内部实现；
- 新前端不导入 Mantine CSS 或 Mantine Provider。

当前 AppShell 是新版桌面产品壳，负责主导航、内容布局、无边框窗口拖动区和窗口控制按钮。全局视觉语言由 Flowlet Design Tokens 统一，页面只保留必要的布局差异。

## 9. 新旧入口

产品级入口由 config.json 的 ui.version 选择，当前重构分支默认使用 `next`：

- legacy：运行现有 Mantine 前端；
- next：运行 src-new 中的 Semi 前端；
- 字段缺失、非法或读取失败时回退 legacy；
- 只在 bootstrap 时读取，修改后需要重启整个应用。

npm run dev:new 和 npm run build:new 的 next mode 只是在非 Tauri 浏览器环境无法调用 read_config 时提供 next 回退值，用于开发和构建验证。生产默认回退值始终是 legacy。一个生产包同时包含两套前端，运行时只加载配置选中的入口。

## 10. 实施阶段

### 阶段 A：架构基座（已完成）

- config.json 驱动的新旧启动入口；
- Semi、Query、Router；
- 新 App Providers、Router、Shell；
- platform/tauri 边界；
- typecheck、旧版构建、新版构建和 HMR。

### 阶段 B：第一个业务闭环（已完成）

完成代理状态和应用初始化：

- 查询真实代理状态；
- 前端决定是否自动尝试启动；
- StrictMode 下不重复启动；
- 展示 starting、running、stopped、failed；
- 保持代理状态与模型配置状态分离。

此阶段验证架构，而不是追求页面完整度。

### 阶段 C：核心配置链路（已完成）

按顺序迁移：

1. 渠道账号；
2. 开放模型；
3. 客户端访问配置；
4. Agent 接入。

### 阶段 D：观测和设置（进行中）

按顺序迁移：

1. 请求日志和详情；
2. 用量；
3. 应用设置；
4. 高级路由能力。

### 阶段 E：切换和清理

- 建立新旧行为验收矩阵；
- config.json 支持 legacy 与 next；
- 保持 next 为默认版本并完成新旧行为验收；
- 保留 legacy 至少一个发布周期；
- 删除旧前端、Mantine 和临时构建模式；
- 将 src-new 调整为最终正式目录。

## 11. 每个业务切片的完成标准

- 领域 command 封装完成；
- query key、query、mutation 和失效范围明确；
- loading、error、empty、ready 状态完整；
- 用户动作有 loading 和错误反馈；
- 不吞掉 Promise rejection；
- StrictMode 下无重复副作用；
- API Key 和请求敏感数据不泄露；
- typecheck 和两个前端构建通过；
- 相关单元测试或契约测试完成；
- 新旧行为差异有明确记录。

## 12. 配置和数据影响

当前迁移状态：

- `config.json` 的 `ui.version` 当前默认 `next`；
- 新旧前端共享同一组 Tauri command、SQLite 和代理核心；
- 新版已经迁移概览、渠道账号、开放模型、客户端访问、Agent 接入和请求日志等核心切片；
- 业务迁移可以扩展领域 command 和返回 DTO，但不得复制后端能力或破坏代理生命周期；
- 当前重构分支默认加载新版；字段缺失、非法或读取失败时仍安全回退 legacy；
- 不改变便携模式的配置加载优先级和托盘退出语义。

热更新范围：

- dev 和 dev:new 中的 React、CSS 修改支持 Vite HMR；
- 非 Tauri 浏览器开发中切换 Vite mode 需要重启开发服务器；
- config.json 的 UI 版本切换要求重启应用。

## 13. 请求日志切片

新版请求日志已按观测页面重新组织：

- 页面切换后立即渲染完整框架，路由加载和数据刷新均使用页面局部骨架，不再展示整页过渡文案；
- 顶部统计、时间范围、模型、状态与搜索条件均由 SQLite 真实查询返回，不使用演示数据；
- 表格按最终请求展示时间、模型、接口、渠道账号、状态、耗时、Token 与预估费用；
- 点击行打开详情抽屉，保留多次路由尝试链路，并展示请求/响应捕获内容与脱敏后的复制能力；
- 实时刷新、手动刷新、分页和历史日志清理继续保留；日志导出不作为本页功能提供。

数据与运行时影响：

- 未修改 SQLite 表结构，不需要数据库迁移；
- `list_request_logs` command 的筛选和返回 DTO 增加了时间范围、模型、汇总统计及用量字段；
- React 与样式在开发模式支持 HMR；Rust command 与查询变更需要重新构建并重启桌面应用后生效；
- 不改变代理生命周期、请求转发、配置热更新或便携模式行为。
