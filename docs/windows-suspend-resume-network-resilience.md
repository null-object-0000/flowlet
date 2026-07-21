# Windows 待机恢复后请求失败

> 状态：已定位根因，待修复
> 发现时间：2026-07-21
> 触发环境：Windows 11，Flowlet 便携版运行在 `C:\Users\nicha\Downloads\Flowlet_0.1.0_x64_portable`

## 现象

Windows 休眠/待机恢复后，Flowlet 本地代理发出的上游请求失败。一次实测：

- 请求发出时间：`07/21 18:36:45` 左右（用户吃饭回来重新开盖恢复系统后）
- 最终失败，总耗时 **1697.2 s（约 28 分钟）**
- 日志里 17:51 最后一次启动后到 18:36 之间**没有任何请求级日志**（请求日志在 debug 级别），符合"请求卡住直到超时、没留下中间痕迹"的特征

## 根因

`src-tauri/src/core/proxy.rs:382-384` 的 `reqwest::Client` 用默认配置裸建，**没有任何连接健康检测**：

```rust
client: Client::builder()
    .build()
    .map_err(|err| ProxyError::StartFailed(err.to_string()))?,
```

这带来两个与 Windows 待机直接相关的缺陷：

1. **连接池不会主动清理死连接。** reqwest 默认启用连接池 + keepalive，但**没有 `pool_idle_timeout`**。Windows 待机时网卡被系统挂起、TCP 连接被中间 NAT/路由器悄悄断开（无 RST），恢复后这些"僵尸连接"仍留在池里。下次请求复用它们时，写入会静默失败或挂起，直到上游超时才报错。

2. **没有 `connect_timeout` / `tcp_keepalive`。** 复用死连接时，客户端要等到 TCP 重传退避耗尽才知道坏了（Windows 默认约 21 秒，但叠加应用层 `tokio::time::timeout` 的上游超时后，整体表现就是 ~1697 秒——很可能是某个渠道配了超大 timeout，或请求在死连接上反复等待）。

## 修复方案

改动集中在 `proxy.rs` 的客户端构建处，加三个关键配置：

| 配置 | 作用 |
|------|------|
| `pool_idle_timeout(Duration::from_secs(60))` | 空闲连接 60 秒自动清出池，**从源头减少僵尸连接** |
| `tcp_keepalive(Duration::from_secs(30))` | OS 层 30 秒发一次 keepalive 探针，快速发现断开的连接 |
| `connect_timeout(Duration::from_secs(10))` | 新建连接 10 秒超时，避免新建也卡住 |

这三个组合起来，待机恢复后最坏情况是：第一次请求命中死连接 → TCP keepalive/写入失败快速返回 → 客户端自动建连重试 → 成功。用户感知从"卡 28 分钟报错"变成"首请求多等几秒"。

### 影响范围

- 只动 `src-tauri/src/core/proxy.rs` 一个文件。
- 现有测试（`proxy_tests.rs`）用 `Client::new()` 直接构造状态体，不走这个构建路径，不受影响。
- 上游超时（`upstream_timeout_seconds`，默认 120s，渠道可覆盖）仍作为 SSE 流生命周期的兜底，与连接层超时互不冲突。

## 待办

- [ ] 在 `proxy.rs` 的 `Client::builder()` 中加入上述三个配置
- [ ] 跑 `cargo test -p flowlet --lib proxy_tests` 确认不破坏现有测试
- [ ] 在 Windows 上实测：待机恢复后发一次请求，确认首请求能在数秒内自愈
