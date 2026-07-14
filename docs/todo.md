# 任务列表

## 概览页

- [x] 将「刷新数据」改为蓝色实心按钮（背景/边框 #1677FF，文字 #FFFFFF），「重启服务」改为橙色描边按钮（文字/边框 #FA8C16，背景 #FFFFFF）
- [x] 调整概览页右上角操作区，将「刷新数据」由蓝色主按钮改为中性次级按钮（背景 #FFFFFF、文字 #64748B、边框 #D9E2F0），「重启服务」保持橙色描边（背景 #FFFFFF、文字及边框 #FA8C16）
- [x] LongCat 账号只能支持余额或资源包，所以概览-渠道账号里的 LongCat 信息展示也没必要同时展示
- [x] 如果渠道账号是余额模式，在概览页的渠道账号模块里就不应该展示有效期了
- [x] 概览页里渠道账号和开放模型里的渠道名称露出感觉有点多余，因为渠道 logo 就可以作为标识了，可以做一个鼠标悬浮到渠道 logo 上也展示渠道名称。并且把现在渠道名称展示的位置那一行都用来展示余额、资源包信息以及 N 个账号可用的附加信息
- [x] 概览页里每个模块都拆成一个独立的组件，然后 OverviewPage 负责整体引入和布局
- [x] 客户端访问信息里的地址直接做成点击链接地址就复制，不需要一个独立的复制按钮了
- [x] 已启用这个 tag 太长了，统一都改成两字的版本
- [x] 代理服务状态模块的高度可以再调小一点，然后客户端访问信息、AI Agent 接入这一行模块高度不变，把多余的高度给渠道账号、开放模型这一行

### 渠道账号

- [x] 模块标题调整为「渠道账号　共 6 个账号」，右侧增加「+ 新增账号」和「查看全部」点击「新增账号」打开新增抽屉；点击账号行或「查看全部」打开完整账号管理抽屉，支持搜索、编辑、启停和删除。
- [x] 取消单条账号的内层卡片样式，改为紧凑列表，通过分割线区分，每条高度控制在 64～68px。每条账号左侧展示渠道图标；中间第一行展示账号名称，第二行展示渠道名称；余额、资源包、有效期横向展示在同一行。右侧保留「已启用/已停用」状态标签及更多操作按钮。

### 开放模型

- [x] 取消单条模型的内层卡片样式，改为紧凑列表，通过分割线区分，每条高度控制在 64～68px。每条模型左侧展示渠道图标；中间第一行展示模型名称，第二行展示所属渠道、可用账号数及运行状态。右侧保留「已启用/已停用」状态标签和启停开关；状态异常时使用橙色或红色文字提示。模型排序优先展示已启用模型，其次展示异常模型，已停用模型放在最后。

## 请求日志

- [x] 请求日志 - 请求详情的弹窗应该和渠道账号管理弹窗一样的层级，需要解决弹窗头部和应用窗口头部冲突的问题
- [x] 请求日志 - 每次通过菜单点击进入到这个页面应该自动刷新下最新数据，现在还需要自己手动刷新
- [x] 请求日志里的客户端筛选项和现在实际意义不符了，现在的客户端应该是 UA 解析出来的

## 其他

- [x] 渠道账号管理的时候 API Key 标题旁的前往查看不应该换行，应该和 API Key 在一行上
- [x] 新增渠道账号时，不能测试链接，这是不对的，是否可以测试链接应该看的是是否维护了关键信息。另外点击测试链接后，toast 提示的层级没有当前渠道账号管理弹窗层级高
- [x] 由我们应用内部发起的请求应该修改下 UA，加个标识，这样我们内部的 LLM API 测试落到请求日志里也能根据 ua_rules 解析为 Flowlet 客户端
- [x] 导入 LongCat 资源包弹窗的层级没有渠道账号管理弹窗层级高
- [x] 渠道账号删除需要有一个二次确认 & 如果是编辑渠道账号，则不允许更改渠道类型
- [x] （编辑时不可更改）这句话应该和 选择渠道 这个标题在一行上
- [x] 资源包如果超过 10 万的话，就加个万的单位，另外资源包默认优先消耗
- [x] LongCat 资源包使用规则· 优先消耗最快过期的Token额度· 未在有效期内使用的额度自动清零· 资源包默认于到期时间当天 23:59:59 清零
- [x] LongCat 资源包现在只支持导入多个资源包，不支持查看和手动维护多个资源包，这个要看怎么处理下
- [ ] config.json 中 ua_rules 升级为客户端配置，每个客户端包含 UA 识别（若有的话，也有可能某个客户端没有特殊的 UA 识别）然后也需要包含如何确认是否在本地安装，安装的版本是多少（优先都是用 bash 命令来确认，例如 PS C:\Users\nicha> hermes --version ===> \n Hermes Agent v0.18.2 (2026.7.7.2) · upstream aaf56912 \n Install directory: C:\Users\nicha\AppData\Local\hermes\hermes-agent \n Install method: git \n Python: 3.11.14 \n OpenAI SDK: 2.24.0 PS C:\Users\nicha> opencode -v ===> 1.17.18 PS C:\Users\nicha> claude -v ===> 2.1.207 (Claude Code)）

## API 接入详情弹窗头部冲突

> `src/features/clients/ApiAccessDrawer.tsx:19-26` 的 `<Drawer>` 缺少 `zIndex` 和 header offset，弹窗头部被自定义标题栏拖拽区（z-index:1000）叠压。

- [ ] `ApiAccessDrawer.tsx` — `<Drawer>` 添加 `zIndex={2000}`，对齐账号管理（`AccountManagementDrawer`）和请求日志详情（`LogDetailDrawer`）的做法
- [ ] `ApiAccessDrawer.tsx` — header 添加 `padding-top`（参考日志详情 44px 或账号管理 20px），避开 window-drag-region 的 36px 像素区域

## 模型服务页面性能优化

> 切换至"模型服务"页面时体感卡顿，其他页面流畅。根因：`buildExposedModels` 在 render 体里裸调用未做 memo，而概览页相同调用使用了 `useMemo`。

- [ ] **P0** `ModelServicesPanel.tsx:55-63` — `availableAccountIds`、`buildExposedModels(...)`、`aggregateModels`、`directModels` 全部用 `React.useMemo` 包裹，对齐 `OverviewPage.tsx:97-108` 的做法
- [ ] **P1** `RouteCandidatesPanel.tsx:30-46` — 大列表（每条 route 展开 3 个 Select + TextInput + Checkbox + Button）未虚拟化，且折叠状态下仍全量 mount。引入 react-window 虚拟化，或改为 `<details>` open 时才挂载 children
- [ ] **P1** `ModelServicesPanel.tsx:115-164` — Tier 卡片循环内 `.find()` 线性查找 accounts（O(routes × accounts)），预索引为 `Map<id, account>` 并加 `useMemo`
- [ ] **P2** `routeActions.ts:91-111` — `updateRoutes(indexes, patch)` 同步触发 N 次 `setRoutes`，合并为单次批量更新
- [ ] **P3** `App.tsx:182-199` — 自动路由同步 effect 内 `ensureDefaultExposedRoutes`（4 层嵌套循环）结果做短时缓存

## 未来规划

- [ ] 可以出一个任务分发功能，我们只管提交 todo，并且分配给不同的 AI Agent，然后 Flowlet 来调度（这里一定需要用到工作树，不然太乱了）
