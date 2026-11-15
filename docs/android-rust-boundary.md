# Android Rust 边界（2026-11-15）

`src-tauri/` 仅提供移动同步查看器。桌面由 Electron + Node Host 承担；Rust 桌面入口、
命令、代理、Agent 接入、控制台抓取、窗口/托盘、自启、电源、原生通知及遗留
headless/凭据 CLI 均已删除。旧实现的来源可从 Git 历史查询。

## 保留的调用链

`lib.rs::run` → Android 凭据库初始化 → `flowlet-mobile.sqlite` → 17 条移动命令。
后台按原规则每 5 分钟执行 S3-only pull 与 LAN probe；手动刷新仍支持 LAN 优先和 S3 回退。

| 模块 | Android 职责 |
| --- | --- |
| `mobile_commands.rs` | 原有 17 条命令、camelCase 参数、响应字段和错误处理 |
| `device_identity.rs` | 接收端快照 DTO、版本兼容、字段校验和展示名称回退 |
| `config.rs` | 同步用量拆解 DTO；不再定义渠道或代理配置 |
| `device_sync.rs` | S3 设置、系统凭据引用、Bucket/列表/快照读取、导入和刷新状态 |
| `lan_sync.rs` | 内网端点校验、HMAC 请求、加密响应解码、探测缓存与远程权限回复 |
| `opencode_control.rs` | 远程权限 DTO；不读取本机 OpenCode 文件或调用本机控制端点 |
| `job_runtime.rs` | 手动/后台 pull 的排他租约，失败或任务被丢弃时释放 |
| `storage.rs` / `storage_device_usage.rs` | 数据库初始化、迁移、同步缓存导入与查询 |
| `model_catalog.rs` | 仅为历史数据库迁移解析规范模型身份；不提供模型路由 |

保留 Android 扫码插件与 Keystore。已移除桌面 Tauri 插件和 Windows/WebKitGTK 直接依赖，
以及 axum 服务端、文件监听、Agent 配置格式解析、日志压缩等不再使用的直接依赖。
Cargo 默认 feature 为 `mobile`，不再提供 `desktop`、`legacy-server`、`legacy-cred` 或 Rust bin。
宿主平台的核心测试使用 `--no-default-features`，无需启动 Tauri GUI。

## 数据与协议兼容

- 17 条移动命令的名称和顺序保持不变；移动后台更新事件和周期不变。
- 数据库仍使用 `flowlet-mobile.sqlite`，保留原有全部建表、补列和历史数据迁移。
  7 个迁移函数与裁剪前核对一致；本次不 DROP 存量表、不重建数据库、不引入新 schema。
  Android 不使用的历史桌面表暂留，以保持已安装手机的升级兼容。
- S3 Key 前缀、快照 v1–v13 兼容、凭据服务名/用户名派生、设置键和探测缓存键不变。
  本机快照生产、上传、恢复和桌面账号工作区写入已移除。
- LAN 客户端保留原签名、响应 AAD、错误分类和内网限制；不启动 LAN HTTP 服务端。
- 根目录 `tauri` npm 别名仍供 Gradle 的 `android-studio-script` 回调使用。
  共享随包资源继续从 `resources/` 打包，fixture 位于 `tests/fixtures/`。

## 验证

```bash
cargo check --manifest-path src-tauri/Cargo.toml --no-default-features --locked
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib --locked
npm run tauri:android:build
```

本次裁剪后，Rust 源文件 147 → 14，源码行数约 98,781 → 6,146（统计时点），
普通直接依赖 40 → 18，锁文件 package 629 → 542。测试辅助模块只在 `cfg(test)` 下编译。

31 项移动核心测试通过，包含旧版本快照解码、资源合并、旧库补列、重复导入与数据库重开、
同步租约、S3 签名只读 HTTP，以及与独立对端实现核对的 LAN 签名/加密响应和拒绝重放测试。
Android arm64 release APK 已重新构建，`apksigner verify` 通过（v2 签名）；
APK 包含 arm64 Rust 库，包内两份模型目录与 `resources/catalogs/` 来源逐字节一致。
前端/core/desktop 类型检查通过，Node 核心测试 638 通过、5 条条件跳过。

Android CI 在 APK 构建前执行移动核心 Rust 测试。历史 Rust↔Node 对拍工具仍可选运行，
但必须显式通过 `FLOWLET_RUST_HEADLESS` / `FLOWLET_RUST_CRED` 提供此前保存的可信二进制；
普通 Node 测试不依赖这些历史产物，当前仓库不能再构建它们。

本次验证包含构建与协议/存储测试，未包含 Android 真机安装或与真实设备联调。
代码和依赖变化需要重新打包安装，不改变配置热更新规则。
