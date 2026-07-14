我看完后，建议不要直接按区块把 `features.css` 切成几个全局 CSS 文件。真正需要的是“先清死代码，再按组件收归样式”。

## 当前判断

[features.css](D:/newbie-self/flowlet/src/styles/features.css) 约 1,500 个物理行、29KB，混合了至少这些职责：

- 路由候选、路由规则
- 已废弃的账号列表和账号弹窗
- 概览页布局
- API 接入详情
- 模型服务
- LongCat 资源包
- 账号编辑抽屉
- 账号管理抽屉
- 渠道账号页

更关键的是，[OverviewPage.tsx](D:/newbie-self/flowlet/src/pages/OverviewPage.tsx:373) 已使用新的 `AccountEditorDrawer`，但 [389 行](D:/newbie-self/flowlet/src/pages/OverviewPage.tsx:389) 后仍保留一套 `opened={false}` 的旧账号编辑 Drawer，连同约 180 行 JSX、状态和保存函数。这套不可达代码正拖着大量旧 CSS 无法清理。

另外，最近一次 CSS 重构提交重新加入了不少宽泛的全局规则；因此目前不是单纯“文件没拆”，而是新旧实现叠加。

## 推荐重构顺序

### 第一阶段：删除不可达实现

先处理 `OverviewPage.tsx`：

- 删除永久 `opened={false}` 的旧账号 Drawer。
- 删除只服务于旧 Drawer 的表单状态、转换函数和 imports。
- `accountEditor` 缩减为新的 `AccountEditorDrawer` 所需的最小 request。
- 检查并删除从未被设为非空的 `snapshotAccountId` 旧流程。
- 保留当前真实使用的账号编辑、模型卡片和代理生命周期调用链。

预计 `OverviewPage.tsx` 可从约 700 行降至 350～420 行。

这一步独立提交，不同时迁移 CSS，便于确认只是删除不可达代码。

### 第二阶段：拆出概览页剩余职责

把 API 接入详情从 Overview 抽出：

```text
src/features/clients/
  ApiAccessDrawer.tsx
  ApiAccessDrawer.module.css
```

概览页自身只保留：

- 页面状态组合
- 空配置/已配置分支
- 打开账号编辑器
- 打开 API 详情
- 各 feature 卡片排列

建议再建立一个概览卡片壳，统一目前多处共享的：

- `overview-section-card`
- `overview-section-card--grow`
- `overview-list`
- `overview-view-all`

例如：

```text
src/components/ui/
  OverviewSectionCard.tsx
  OverviewSectionCard.module.css
```

这样不需要四个 feature 继续依赖同一组全局 class。

### 第三阶段：按组件迁移 `features.css`

推荐顺序从边界最明确的模块开始：

```text
src/features/channels/
  AccountEditorDrawer.module.css
  AccountManagementDrawer.module.css
  LongCatPackImportDialog.module.css

src/features/routes/
  ModelServicesPanel.module.css
  RoutePanels.module.css

src/pages/
  OverviewPage.module.css
  ChannelsPage.module.css
```

迁移原则：

- 组件专属规则放同目录 CSS Module。
- 两个路由面板真正共享的样式可以共用 `RoutePanels.module.css`。
- Mantine 内部覆盖必须挂在模块根节点下面，例如 `root :global(.mantine-Drawer-header)`，避免全局污染。
- 不把 `features.css` 简单改名为 `channels.css`、`routes.css`；那只会产生多个新的大文件。
- 响应式规则跟随所属组件迁移，不集中建立另一个 `responsive.css`。

### 第四阶段：清理全局样式

最终全局层只保留：

```text
styles/
  base.css       # reset、CSS variables、基础元素
  ui.css         # 真正跨业务的 UI primitives
  layout.css     # AppShell、Sidebar、Topbar、窗口布局
```

完成后：

- 删除 `features.css`。
- 删除 [styles.css](D:/newbie-self/flowlet/src/styles.css:3) 中对应 import。
- 清查无引用 selector。
- 合并重复颜色、圆角、边框为少量 CSS variables。
- 清理重复定义，例如 `account-modal-footer` 当前存在多段定义。

## 建议拆成 4 个可审查提交

1. `refactor(overview): remove unreachable account editor implementation`
2. `refactor(overview): extract api access drawer and overview card shell`
3. `refactor(channels): colocate channel feature styles`
4. `refactor(routes): migrate remaining styles and remove features.css`

不建议一次性提交全部迁移，否则视觉回归很难定位。

## 验收标准

每个提交都应验证：

- 无账号概览状态
- 已有账号概览状态
- 新增、编辑、删除账号
- LongCat 资源包编辑
- API 接入详情
- 模型服务和高级路由
- 720px、900px 两个现有响应式断点
- 前端 typecheck 和 build

当前直接运行项目内 `tsc --noEmit` 是通过的；`npm run check` 无法启动是本机全局 npm 入口缺失，不是项目 TypeScript 错误，后续可用项目二进制或可用的 `pnpm` 执行检查。

## 其他大文件的优先级

CSS 完成后再单独处理 Rust，避免和当前已有的 Rust 未提交修改交叉：

1. [proxy.rs](D:/newbie-self/flowlet/src-tauri/src/core/proxy.rs)  
   可继续拆出响应构建、流式 usage 捕获、请求日志记录。

2. [proxy_tests.rs](D:/newbie-self/flowlet/src-tauri/src/core/proxy_tests.rs)  
   按协议、鉴权、模型列表、路由回退、端到端场景拆测试模块。

3. `commands.rs`  
   按 proxy/config/account/log/usage command 分模块。

4. `config.rs`、`storage_usage.rs`  
   需要先看当前 Rust 改动完成后的职责边界，不建议现在只为降行数硬拆。

这轮前端重构不需要改变数据结构、`config.json` 或代理行为；CSS/React 修改支持开发期热更新，也不需要重启代理服务。