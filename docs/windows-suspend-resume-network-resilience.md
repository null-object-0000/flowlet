# Windows 待机恢复后请求失败

> 状态：根因已重新定位（2026-07-28 修正旧结论）；方向 1、3 已实现（2026-07-28），待 Windows 实测
> 发现时间：2026-07-21
> 触发环境：Windows 11（**S0 低电量待机 / Modern Standby**，无 S3），Flowlet 便携版运行在 `C:\Users\nicha\Downloads\Flowlet_0.1.0_x64_portable`

## 现象

Windows 自动待机（用户离开后空闲计时器触发，或 Win+L 锁屏后 S0 自动进入 Modern Standby）恢复后，发现**待机前发出的进行中流式请求**失败。SQLite 请求日志中的事故记录（`request_id = 28449577-…`）：

| 字段 | 值 |
|------|-----|
| created_at | `2026-07-21 10:36:45` UTC = **18:36:45 北京时间（合盖前发出）** |
| client / channel / model | Pi → LongCat → `flowlet-pro`（`LongCat-2.0`），`request_type=tool_use` |
| status / is_stream | 200 / 流式 |
| ttfb_ms / ttft_ms | **3345 / 3346（响应头和首个 token 都正常到达）** |
| duration_ms | **1697228（≈28 分钟）** |
| route_reason | `stream_timeout`（"上游流连续 120 秒未返回数据，已中止"） |

### 真实时间线（修正旧文档）

1. **18:36:45** 请求发出，3.3 秒拿到响应头、首个 token 已输出——请求开始完全正常；
2. 随后用户离开，系统自动待机（空闲计时器触发，或 Win+L 锁屏后 S0 进入 Modern Standby）→ Flowlet 进程被冻结、网络断开；
3. 待机期间上游早已超时断流，但本机进程冻结，什么都不发生；
4. **~19:05**（18:36:45 + 1697s）用户回来解锁/唤醒 → 进程解冻 → 已过期的 120s 空闲 timer 立即触发 → 报 `stream_timeout`。

旧文档把 `created_at` 18:36:45 误当作"恢复后发出请求"的时间，并据此推测"恢复后复用僵尸连接卡了 28 分钟"。两处都与证据矛盾（见下）。

## 根因

**根因是"系统待机杀死了进行中的请求"，不是"恢复后复用僵尸连接"。**

### 关键机制：S0 Modern Standby 下 tokio timer 的行为

`powercfg /a` 确认本机只有"待机 (S0 低电量待机)"，S3 被禁用。S0 待机有两个关键行为：

1. **桌面进程被冻结、网络断开**（DAM / 网络低功耗，平台设计如此，应用无法选择退出）；
2. **QPC（Rust `std::time::Instant` / tokio timer 的时钟源）继续走**——与 S3 不同，S0 下 CPU 不完全断电，单调时钟不暂停。

于是"待机前发出、跨越待机的请求"必然表现为：**timer 的 deadline 在待机期间耗尽，但进程冻结无法执行超时回调；恢复解冻瞬间，过期 timer 立即触发**。`duration_ms` 用 `Instant::elapsed()` 计算，因此包含整段待机时长。

### 数据库中的同类记录（三种失败形态）

| created_at (UTC) | duration | route_reason | 说明 |
|---|---|---|---|
| 07-21 10:36:45 | 1697.2s | `stream_timeout` | 本事故：流已开始（ttft 3.3s），待机 ~26 分钟后恢复即超时 |
| 07-21 03:57:07 | 1490.9s | `stream_timeout` | 同形态 |
| 07-24 07:45:39 | 1676.9s | `stream_timeout` | 同形态 |
| 07-24 09:01:04 | **1373.5s** | `timeout`（"上游**响应头**等待超过 120 秒"） | **决定性证据**：`tokio::time::timeout(120s, execute())` 硬上限 120s，实际 1373s 才触发——唯一解释是进程被冻结 ~21 分钟，恢复后才执行超时回调 |
| 07-27 04:12:39 | 3874.5s | `stream_error`（"error decoding response body"） | 待机 ~64 分钟；恢复后连接层先报错（timer 之前），表现为网络错误而非超时 |

对照组：07-21 11:10、07-24 02:18、07-24 05:31 各有 ~1166s 的流式请求**正常完成**（`direct`）——长流本身没有问题，`timeout_seconds` 设计上就不是 SSE 总时长上限（只约束响应头等待、buffered body 和流空闲间隔，见 `proxy.rs:721-726`）。

### 为什么旧结论（僵尸连接）不成立

1. **数字对不上**：旧结论是"恢复后新请求复用死连接，写入挂起直到上游超时"。但响应头等待被 `tokio::time::timeout(120s)` 硬包裹（`proxy.rs:773`），最多卡 120s 就报 `timeout`，**无论如何产生不了 1697s**。
2. **形态对不上**：事故记录 ttfb=3345ms、ttft=3346ms，响应头和首 token 都正常——不是"复用死连接写入挂起"的形态。
3. **日志空白期解读错了**：旧文档把"17:51 启动后到 18:36 无请求日志"解读为"请求卡住不留痕迹"。实际 18:36:45 才是请求发出时间，此前没有日志只是因为本来就没有请求。

连接池僵尸连接问题**客观存在**（待机恢复后首批新请求可能命中死连接），但它是"恢复后体验"问题，不是本事故根因。

## 修复方案

### 用户的正确方向：让系统在有任务运行时不要待机

需要先说清平台现实：**S0 Modern Standby 下，桌面进程在待机中无法继续运行**（微软平台设计，win32 应用没有例外 API；Away Mode 对 S0 无效）。所以"待机中也要能运行"的可行路径只有一条——**阻止系统进入待机**：

#### 方向 1（治本）：有活动请求时持有 Power Request，抑制自动待机

- 代理内维护活动请求计数（`forward_request` 进入 +1；非流式响应构造完成 −1；流式在 `capture_timed_stream` 终结时 −1）；
- 计数 0→1 时调用 `PowerCreateRequest` + `PowerSetRequest(PowerRequestSystemRequired)`（需给 `windows-sys` 加 `Win32_System_Power` feature），1→0 时 `PowerClearRequest`；
- 效果：系统进行中的自动待机（空闲计时器触发）被抑制，长任务可以跑完；**不要求保持屏幕**（display 不受影响，可正常熄灭，耗电影响小）；`powercfg /requests` 里能看到 Flowlet 的持有原因，行为透明；
- 覆盖场景：① 用户离开后空闲计时器触发的自动待机；② **Win+L 锁屏**——锁屏本身不待机，但 S0 机器在"锁屏 + 屏幕关闭"后会很快自动进入 Modern Standby，该自动进入同样被 SYSTEM 类别请求抑制；
- 局限：**无法阻止用户手动触发的睡眠动作**（合盖=睡眠、开始菜单"睡眠"、电源键——Windows 手动睡眠优先于应用请求）；该场景由方向 2 的电源计划引导另行覆盖。

#### 方向 2（可选增强，非本事故场景）：合盖动作引导

已确认本事故由**自动待机 / Win+L 锁屏**触发（用户未合盖），方向 1 已完整覆盖。合盖属于手动睡眠动作，应用层请求无法阻止；若未来需要支持"合盖后任务继续跑"，可把电源计划的合盖动作改为"不采取任何操作"：

```
powercfg -setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0   # 接通电源
powercfg -setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0   # 使用电池
```

- 属于修改用户系统设置，必须在设置页提供显式开关（默认关），并清楚说明影响（合盖后机器继续运行、发热与耗电由用户承担）；
- 与方向 1 组合后：合盖只灭屏，Flowlet 和客户端进程照常运行，Claude Code / Pi 任务不受吃饭打断。

#### 方向 3（恢复韧性，旧方案重新定位）：连接层超时配置

旧文档的三项配置仍然值得做，但定位为"**手动待机/网络抖动后，恢复首批请求快速自愈**"的体验优化（对 S3 机器尤其重要），与本事故根因无关：

| 配置 | 作用 |
|------|------|
| `pool_idle_timeout(Duration::from_secs(60))` | 空闲连接 60 秒清出池，减少复用僵尸连接 |
| `tcp_keepalive(Duration::from_secs(30))` | OS 层探针，恢复后快速发现死连接 |
| `connect_timeout(Duration::from_secs(10))` | 新建连接 10 秒上限 |

#### 方向 4（可选，低优先级）：失败归因

恢复后触发的 `stream_timeout` 错误消息（"上游流连续 120 秒未返回数据"）在待机场景下具有误导性。可通过 `RegisterSuspendResumeNotification` + `WM_POWERBROADCAST` 监听待机/恢复事件，把恢复时刻附近失败的进行中请求标记为"系统待机导致"。S0 下无法用时钟偏差法检测（QPC 与 wall clock 都正常走），只能依赖电源事件，工程量较大，先记录。

### 影响范围

- 方向 1：`src-tauri/src/core/proxy.rs`（活动计数 + Power Request 持有/释放）、`Cargo.toml`（`windows-sys` feature）；需 `cfg(windows)` 隔离，其他平台留空实现（macOS 后续可用 `IOPMAssertion`，Linux 可用 `systemd-inhibit`）；
- 方向 2：新增 Tauri command（读写合盖动作）+ 设置页开关，遵循前端优先原则，是否开启由用户决定；
- 方向 3：只动 `proxy.rs` 的 `Client::builder()`；现有测试（`proxy_tests.rs` 直接构造 `Client::new()`）不受影响；
- `upstream_timeout_seconds`（默认 120s）语义不变。

## 待办

- [x] 方向 1：已实现。新增 `src-tauri/src/core/power.rs`（`ActivityTracker`/`ActivityPermit` RAII 计数，锁内切换抑制状态）；`forward_request` 在路由候选匹配通过后 `track()`，非流式随响应返回释放，流式把 permit 移入 `TimedStreamState` 活到流真正结束（完成/出错/客户端断开）。Windows 用 `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`（进程退出自动清除），非 Windows 暂为空实现。当前默认启用、无配置开关
- [ ] 方向 2（可选，非本事故场景）：设置页"合盖时保持运行"开关（powercfg LIDACTION 读写 command + 前端引导文案）
- [x] 方向 3：已实现。`proxy.rs` 的 `Client::builder()` 加入 `pool_idle_timeout(60s)` / `tcp_keepalive(30s)` / `connect_timeout(10s)`
- [x] 跑 `cargo test -p flowlet --lib proxy_tests`（78 通过）与 `power` 单元测试（2 通过），`cargo check --all-targets` 无新增警告
- [ ] Windows 实测：① 长任务运行时系统不自动待机（`powercfg /requests` 可见 Flowlet 持有）；② Win+L 锁屏超过原待机时长后解锁，流式请求仍在正常输出；③ 手动睡眠恢复后首个新请求数秒内自愈
- [ ] （可选）方向 4：电源事件监听 + 待机失败的错误归因
