# Antigravity 订阅额度观测

在概览页「渠道账号 → 新增账号」选择「Antigravity」，点击「授权登录」，在浏览器完成 Google OAuth 授权。
此后 Flowlet 使用保存的离线授权查询远端额度，**不需要安装、启动或一直开着 Antigravity**。
如果账号尚未在官方服务完成初始化，接口会提示先在官方客户端登录一次；Flowlet 不代用户创建 Google Cloud 项目或开通服务。

支持多个授权账号，展示邮箱、套餐、分组/模型剩余额度、重置时间与最后成功查询时间。
详情支持手动刷新、重新授权和移除授权；概览页打开期间每两分钟自动刷新。没有代理账号也可以使用。
原有本地 App / IDE 服务读取作为可选发现来源保留，使用「Google 授权 / 本地客户端」区分来源；
同一邮箱的授权账号优先，不把另一个本地登录账号的额度归到已授权账号。

## 调用与数据边界

- 前端 `useAntigravityAccounts` 查询 `query_antigravity_accounts`；该命令并行组合独立的
  `antigravity_oauth::query_accounts` 和原有 `antigravity_account` 本地观测。
- 授权入口为 `authorize_antigravity_account`：绑定 `127.0.0.1` 随机端口，打开 Google 官方授权页，
  校验随机 state，使用 PKCE S256 交换授权码，并通过 Google userinfo 验证邮箱身份。
  回调仅处理固定路径，不显示令牌或原始错误。浏览器回调等待上限 180 秒；结束/超时后关闭监听器。
- OAuth 请求 `cloud-platform` 与 `userinfo.email` scope，申请 `access_type=offline`。
  **不内置 OAuth client**：发起授权前必须成对设置环境变量
  `ANTIGRAVITY_OAUTH_CLIENT_ID` 与 `ANTIGRAVITY_OAUTH_CLIENT_SECRET`，未配置时授权入口返回明确错误。
  client 声明来源参考
  [Antigravity-Manager 的客户端声明](https://github.com/lbjlaq/Antigravity-Manager/blob/0067fe045ddd77f4462ea8e2c25384839d869f32/src-tauri/src/modules/oauth.rs)。
  这两项只影响新授权；已有 refresh token 始终绑定其授权时保存的 client。不要把 client secret
  写入仓库或提交到版本库。
- 远端 HTTPS 请求遵循 Flowlet 当前上游代理设置，禁止重定向。先读取 `loadCodeAssist` 的项目与套餐，
  优先 `paidTier`，再读取 `retrieveUserQuotaSummary`；不可用时回退到 `retrieveUserQuota` 的真实额度桶。
  `fetchAvailableModels` 只补充名称，不将其可用性信息冒充额度，特别是不把未验证的全 100% 当剩余额度。
- 未返回比例显示「额度未知」；禁用项显示「不可用」，两者不绘制进度条，真实 0% 保留为 0%。
  窗口名称、说明与重置时间来自服务响应，不固定假定五小时或每周额度；不凭相同比例推断共享额度池。
- 令牌临近过期时刷新；HTTP 401 可刷新一次后重试。续期后先验证账号身份，再原子保存轮换后的令牌。
  即使随后额度接口失败，已验证的新令牌仍会保存；身份验证失败不写入新令牌。
  `invalid_grant` 等授权失效显式标记为需要重新授权，权限不足与网络故障单独展示。
- 授权成功但额度查询失败时保留授权，展示真实查询错误；刷新失败时保留上次成功快照与其时间并标记过期。
  成功授权或删除后前端只更新本领域缓存，不做全局刷新；Rust 串行化授权提交、令牌轮换与删除，避免删除后复活。

## 本机保存与移除

数据保存在 Flowlet 数据库同级的 `antigravity-accounts/<邮箱 SHA-256>.json`，包含该账号授权和额度快照，
不保存到项目 `config.json`，也不读取、修改 Antigravity 客户端的凭据。Unix 授权目录权限为 0700、文件为 0600；
Windows 继承当前用户应用数据目录的 ACL。文件通过唯一临时文件与原子替换写入，前端报告只包含额度和身份，
不返回 access token、refresh token 或 client secret。该文件含敏感授权信息，不应共享或提交版本库。

「移除授权」经确认后删除 Flowlet 的该账号授权和快照，不修改 Antigravity 登录状态，也不撤销 Google 全局授权。
如需撤销所有相关客户端的 Google 授权，应在 Google 账号的第三方访问管理页面操作。
若同一账号仍在运行中的 Antigravity 内登录，下次刷新可能以「本地客户端」来源再次出现，但不会重建被移除的 OAuth 授权。

观测报告独立于 `ChannelAccount`，不计入启用代理账号数，不进入开放模型、路由或代理启动条件。
新增本机授权文件，不改变数据库 schema、代理配置或客户端配置。
新代码需重启新版 Flowlet；授权、移除、额度变化及上游代理设置在下一次操作生效，无需再次重启。

## 本地服务回退

未授权时仍可读取本机正在运行且带有 `--csrf_token` 的 Antigravity App / IDE language server。
Unix 只枚举当前用户进程；Linux 用 `/proc/<pid>/fd` 与该进程的 TCP 表，macOS 用 `lsof`，Windows 用 PowerShell。
只探测匹配进程的监听端口或声明的 extension port；请求固定在 `127.0.0.1`，不走系统代理或重定向。
本地 HTTPS 允许客户端自签名证书；HTTP extension port 优先用 `--extension_server_csrf_token`。
CSRF 仅驻留内存，不进入前端报告或存储。优先分组额度，回退到 `GetUserStatus`、`GetCommandModelConfigs`。
本地接口与远端接口均为内部兼容接口，可能随版本或账号权限变化；不承诺所有账号都返回每周额度。

## 验证

Rust 模拟 Google 端点与本地回调覆盖：浏览器授权和 PKCE/state、未运行客户端时的远端查询、离线授权保存、
套餐优先级、令牌轮换、401 续期重试、invalid_grant、身份不匹配、额度权限不足、保留旧快照、
模型可用性不冒充 100% 额度、移除授权、回调超时与监听器清理。本地服务解析与兼容测试保留。
前端测试覆盖授权入口、等待浏览器状态、重新授权、移除确认、未知/禁用额度、刷新与无代理账号展示。
模拟测试不代替真实 Google 账号联调。

额度接口形状参考（查阅日期：2026-11-06）：

- [CodexBar Antigravity 数据源说明](https://github.com/steipete/CodexBar/blob/main/docs/antigravity.md)
- [远端额度实现](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Antigravity/AntigravityRemoteUsageFetcher.swift)
- [分组额度响应模型](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Antigravity/AntigravityQuotaSummaryParser.swift)

品牌图标固化自 `@lobehub/icons-static-svg@1.93.0`，保留现有 MIT 许可证，详见 `public/icons/lobe/README.md`。

网络请求建立连接超时为 10 秒、单请求总超时为 30 秒。连接错误区分令牌交换/续期、身份验证与额度接口阶段，
不在错误中输出 OAuth 授权码、完整请求 URL 或凭据。
