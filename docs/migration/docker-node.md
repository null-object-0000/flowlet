# Docker 镜像迁移到 Node Host

> 状态：**Node Host 镜像已在远端 Docker Engine 构建并通过容器冒烟（18/18）**；
> 尚未替换线上 `flowlet` 栈（部署需要用户授权，且上线前需确认本文末尾的已知差异）。

## 镜像结构（`Dockerfile`）

| 阶段 | 基础镜像 | 作用 |
| --- | --- | --- |
| `web` | `node:26-bookworm-slim` | 构建 `dist-web`（与现有多阶段构建完全一致） |
| `server-deps` | `node:26-bookworm-slim` | 只安装 `packages/flowlet-core` 运行时依赖（`undici`） |
| runtime | `node:26-bookworm-slim` | 非 root `10001`、`/data` 卷、`/app/ui` 静态界面、`/app` 源码 + 依赖 |

与 Rust 镜像的差异：

- **删除 Rust 构建阶段**：镜像内不再有 `cargo`、`target/`、`flowlet-server` 二进制；
- 入口是 `node /app/packages/flowlet-core/src/index.ts`（Node 26 原生执行 TS，无构建产物）；
- 体积目标：< 300 MB（Rust 版 runtime 层约 100 MB + 二进制，实际以远端构建结果为准）；
- 环境变量、端口（8080 / 18640）、`/data` 布局、`HEALTHCHECK`、`STOPSIGNAL SIGTERM`、
  `USER 10001:10001`、`stop_grace_period: 30s` **全部保持不变**。

## 远端构建与冒烟结果（2026-11-09）

| 项 | 结果 |
| --- | --- |
| 镜像 | `flowlet:node-20261109-poc`（`sha256:6b7e27053163`） |
| 体积 | **258 MB**（Rust 版 runtime 层 ~100 MB + 24 MB 二进制，Node 版一次到位） |
| 构建 | Docker Engine API `POST /build`，全量 ≈272s；改源码后增量 ≈3.6s（npm 层缓存） |
| 冒烟 | 临时容器 + 临时数据卷（真实库副本）：**18/18 通过**，见下 |
| 清理 | 冒烟容器/卷已删除；线上 `flowlet` 容器未受影响 |

容器冒烟覆盖：`healthy`、`/health` 200、`/api/session` 401/200、SPA 200、`/api/*` 404、
`list_channel_accounts`（14 行）、`list_route_candidates`（44 行）、6 条常用命令 200、
未知命令 501、`/v1/models` 200（4 个模型）、`/v1/models` 无凭据 401。
冒烟使用 `FLOWLET_DISABLE_BACKGROUND_TASKS=1`，避免用库内真实凭据向真实上游发余额请求。

构建期经验：运行阶段已不安装任何 apt 包（健康检查改用 Node `healthcheck.mjs`），
避免了远端拉 Debian 源导致的构建卡顿；镜像内 `/app` 统一 `chmod -R a+rX`，
因为本地工作区文件可能是 0600 而容器以 10001 运行。

## 本地验证（无 docker CLI）

本机没有 docker CLI，服务端镜像构建走 `10.100.217.60:2375` 的 Docker Engine API
（见 `.agents/skills/flowlet-docker-deploy/`）。本地等价验证：

```bash
npm run build:web
scripts/run-node-host.sh                  # 与镜像一致的环境变量 + 数据副本
node scripts/e2e-node-host.mjs            # 端到端冒烟（含 mock 上游流式）
```

## 远程构建与发布（获授权后执行）

1. 用 Engine API `POST /build` 构建（上下文为仓库根，`.dockerignore` 已排除
   `.worktrees/`、`node_modules`、`target`、`dist*`）。服务器已预置
   `node:26-bookworm-slim` 基础镜像，无需拉取 Docker Hub；无需 `DEBIAN_MIRROR`
   （运行阶段不再 apt 安装任何包）。
2. 构建 nginx/代理无变化；部署走既有 Dockhand stack（`env=2`，stack `flowlet`），
   只替换 `services.flowlet.image`。
3. 上线后按技能 `verify` 口径验证：`/health`、管理 API 账号 14 / 路由 56、
   `/v1/chat/completions` 流式、`/anthropic/v1/messages` 流式、`/v1/responses`、
   日志 `route_reason` 与 `upstream_proxy_used` 字段。
4. 回滚点 = 部署前镜像 tag（Rust 版 `flowlet:docker-<日期>`），数据卷 `/data` 不动。

## 后台维护任务（Node Host 已实现）

对齐 Rust `core/host_scheduler.rs` 与 `core/account_balance.rs`：

| 任务 | 首次延迟 / 周期 | 实现位置 | 说明 |
| --- | --- | --- | --- |
| 官方余额同步 | 30s / 5min | `packages/flowlet-core/src/host/scheduler.ts` | 仅启用 + 预设声明 `supports_balance_query` + 官方余额渠道（deepseek/kimi/openrouter/vibetoken）且无账号级自定义 Base URL；串行执行，单账号失败不中断 |
| 存储清理 | 15min / 15min | 同上 + `storage/maintenance.ts` | Body 过期清理（app_meta 的 log_capture 为准）、体积超限按比例清理、余额快照保留（默认 30 天 / 每账号 200 条）、孤儿快照清理 |
| 模型目录同步 | 1h / 1h | 同上 | 抓取 models-cn / models.dev 并原子写入 `FLOWLET_CATALOG_DIR`；单个来源失败不影响另一个 |

## 已知差异 / 待办

- `.flcap` 外置捕获帧（旧请求详情）尚未迁移：Node Host 的 Body 直接落 `request_logs` 列，
  旧库中已外置的帧仍在磁盘上但不再由 Node 读取/清理；Docker 切换前需要确认这部分历史日志的
  可接受性（新写入完全正常）。
- 目录同步只更新目录文件，未重建价格表：Node 的费用估算仍来自 `config.json.model_prices`，
  不含 models-cn/models.dev 派生价格。迁移收尾阶段需补齐（影响「用量洞察」中部分模型的成本）。
- 不写 `background_jobs` 后台任务日志（Rust 会写），改为结构化 stdout 行；不影响业务数据。
