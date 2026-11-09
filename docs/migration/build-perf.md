# 过渡期 Rust 构建提速（实测报告）

> 适用阶段：Flowlet 迁移到 Electron + Node 的过渡期。目标是在不改变产物语义、平台支持
> （Android 仍需 `staticlib`/`cdylib`）的前提下，降低日常 Rust 重编译的 CPU、IO、
> 产物体积与磁盘占用。
>
> 测量环境：Linux x86_64，16 核 / 30 GiB 内存（测量时已用约 20 GiB，swap 使用较多），
> rustc 1.97.1 / cargo 1.97.1（stable），无 sccache、无系统 lld/mold、无 sudo。
> 所有数字均为本机 `/usr/bin/time -v` 实测，不是估算。测量期间机器上还有其他进程负载，
> `loadavg` 在 3~19 之间波动；为控制内存峰值，除特别说明外构建使用 `-j 8`。
> 因此**墙钟时间只作参考，跨改动的核心口径是 CPU 时间（user/sys）、磁盘写入
> （file system outputs）与产物体积**。

---

## 0. 结论摘要

1. **日常编辑的真实成本不是 46 秒。** 46.15s 基线对应「增量缓存失效/构建入口切换后的
   冷重建」；增量缓存有效时，稳态热重建改前约 **7.5-8.0s 墙钟 / user 12.6-14.6s**，
   改后约 **5.5-6.0s 墙钟 / user 5.6-6.1s**（user 时间约 **-55%**）。
2. 本次落地的改动只有 `src-tauri/Cargo.toml` 的 `[profile.dev]` 段：
   - 本 crate：`debug = "line-tables-only"`（保留 backtrace 的 `文件:行号`）；
   - 第三方依赖：`[profile.dev.package."*"] debug = 0`。
3. 收益：
   - 稳态热重建：user **12.6→5.6s（约 -55%）**，sys **4.4→2.2s**，磁盘写入
     **6.98→2.43 GB（约 -65%）**，墙钟约 **-20~25%**；
   - 冷重建（`cargo clean -p flowlet` 后）：user **71.4→43.3s（约 -39%）**，
     sys **9.4→3.8s**，磁盘写入 **8.14→2.84 GB（约 -65%）**；
   - debug 产物总体积 **3.02 GiB → 884 MiB（约 -71%）**；
   - `target/` 目录随历史多指纹产物清理一并下降（本机 31G → 14G，仅供参考）。
4. 一次性代价：首次应用 `[profile]` 会触发**全量依赖重建**，本机实测约 **2 分 10 秒**
   （`-j 8`，期间 CPU 会短时占满）。回滚同样会触发一次同量级全量重建。
5. 不可行/无收益项（均有实测或证据）：
   - **mold/lld 系统安装不可行**（无 sudo，`no new privileges`；系统无 `ld.lld`/`mold`）；
     且 **rustc 1.97.1 在 x86_64-unknown-linux-gnu 上默认已经使用自带的 `rust-lld`**
     （`strace` 证实），无需再配置链接器。
   - `cargo build --bins` **不能**跳过 `staticlib`/`cdylib`（`-v` 证实 lib 仍按三种
     crate-type 编译），因此没有零改动的命令级收益。
   - sccache 未安装，且日常是「本 crate 重编 + 依赖缓存命中」，收益低，不落地。
   - `[profile.dev.package."*"] opt-level` 默认已是 0，无需改动。

---

## 1. 基线（改动前）

`src-tauri/Cargo.toml` 当时**没有 `[profile]` 段**，全部使用 cargo 默认 dev profile
（`debug = 2` 完整调试信息）。`[lib] crate-type = ["staticlib","cdylib","rlib"]`。

### 1.1 稳态热重建（增量缓存有效）

| 指标 | 实测值 |
| --- | --- |
| 操作 | `touch src-tauri/src/lib.rs && cargo build`（连测，增量缓存热态） |
| 墙钟 | 7.51s / 7.63s（另有一次 9.92s、一次 13.14s 的负载/缓存波动样本） |
| CPU | 193% ~ 232% |
| user | 12.64s / 13.07s（另一轮 14.63s） |
| sys | 4.40s / 4.41s |
| 磁盘写入（FS_OUT） | 6,981,960 KB ≈ 6.98 GB |
| 各编译单元耗时 | `flowlet_lib` 7.5s，`flowlet` bin 1.92s，`headless` bin 2.00s |

### 1.2 冷重建（本地 crate 增量缓存失效后）

`cargo clean -p flowlet`（清掉本包产物 + 本包 incremental 缓存）后 `touch lib.rs && cargo build`：

| 指标 | 实测值 |
| --- | --- |
| 墙钟 | 41.63s（与 Lead 的 46.15s 基线同量级；差异来自机器负载） |
| CPU | 193% |
| user / sys | 71.35s / 9.38s |
| 磁盘写入 | 8,141,912 KB ≈ 8.14 GB |
| 峰值 RSS | 2.26 GiB |

> 为什么 46s 和 7.5s 会同时存在：cargo 的增量缓存与 `target/` 指纹是绑定构建参数/环境的。
> 清缓存、切换构建入口（如 `cargo build` ↔ `tauri dev`）或环境变量变化后，本 crate 会
> 全量重编一次（≈40s）；此后连续编辑走增量，单次约 7.5s。**日常感知到的 46s 属于前者，
> 不是每次编辑都有**。

### 1.3 产物（debug）

| 产物 | 体积 |
| --- | --- |
| `target/debug/flowlet` | 501,864,224 B（478.5 MiB） |
| `target/debug/headless` | 455,246,496 B（434.2 MiB） |
| `target/debug/libflowlet_lib.a` | 1,368,206,016 B（1304.8 MiB） |
| `target/debug/libflowlet_lib.so` | 397,954,464 B（379.5 MiB） |
| `target/debug/libflowlet_lib.rlib` | 522,671,048 B（498.5 MiB） |
| 合计 | 3,245,942,248 B（3.02 GiB） |

---

## 2. 改动与逐项实测

### 2.1 主收益项：`[profile.dev]` 调试信息分级

最终配置（已写入 `src-tauri/Cargo.toml` 末尾）：

```toml
[profile.dev]
# 本 crate 保留行号信息，backtrace 仍可定位到 文件:行号；需要变量级调试时临时改 2。
debug = "line-tables-only"

[profile.dev.package."*"]
# 第三方依赖不再产出 DWARF；这是产物/IO/链接耗时下降的主要来源。
debug = 0
```

**实测（应用后）**

| 场景 | 改前 | 改后 | 变化 |
| --- | --- | --- | --- |
| 稳态热重建 墙钟 | 7.5 ~ 8.0s（样本 7.51 / 7.63s） | 5.5 ~ 6.0s（样本 5.48 / 5.52 / 5.77 / 5.96 / 6.07s；最终验证 4.79s） | 约 -20~25% |
| 稳态热重建 CPU% | 193 ~ 232% | 102 ~ 151% | 并行度下降、总 CPU 工作减少 |
| 稳态热重建 user | 12.6 ~ 14.6s | 5.29 ~ 6.08s | **约 -55%** |
| 稳态热重建 sys | 4.40 ~ 4.41s | 2.04 ~ 2.44s | 约 -50% |
| 稳态热重建 FS_OUT | ≈ 6.98 GB | ≈ 2.43 GB | **约 -65%** |
| 冷重建（clean -p flowlet 后）墙钟 | 41.63s | 24.72s（低负载段）；同负载段 42.91s | 受外部负载影响大，见下 |
| 冷重建 user / sys | 71.35s / 9.38s | 42.92~43.26s / 3.81s | user **约 -39%**，sys 约 -59% |
| 冷重建 FS_OUT | ≈ 8.14 GB | ≈ 2.84 GB | **约 -65%** |
| 冷重建峰值 RSS | 2.26 GiB | 1.92 GiB | 约 -15% |
| 三个编译单元耗时 | lib 7.5s；bins 1.92 / 2.00s | lib 4.05s；bins 1.02 / 1.04s | lib 约 -46% |

> 冷重建的墙钟对比受外部负载影响很大：改前样本 `loadavg≈8`、CPU 193%；改后在
> `loadavg≈3.3` 时 24.72s、`loadavg≈9.6` 时 42.91s。**CPU user 时间（-39%）与磁盘写入
> （-65%）是更可靠的口径。**

**一次性成本（profile 变更）**：从改 `Cargo.toml` 到全量依赖重建完成，本机实测
**约 2 分 10 秒**（2026-11-09 22:05:56 → 22:08:05；`-j 8`；其中一次续建段
墙钟 83.85s / user 259.51s / sys 27.58s）。期间 CPU 会短时占满。回滚同样会触发一次
同量级全量依赖重建。

**产物（改后）**

| 产物 | 改前 | 改后 | 变化 |
| --- | --- | --- | --- |
| `flowlet` bin | 478.5 MiB | 126.8 MiB | -73.5% |
| `headless` bin | 434.2 MiB | 80.1 MiB | -81.5% |
| `libflowlet_lib.a` | 1304.8 MiB | 475.0 MiB | -63.6% |
| `libflowlet_lib.so` | 379.5 MiB | 32.4 MiB | -91.5% |
| `libflowlet_lib.rlib` | 498.5 MiB | 169.5 MiB | -66.0% |
| 合计 | 3.02 GiB | 883.8 MiB | **约 -71%** |

### 2.2 `debug = 0`（本 crate）对比实验：不采用为默认

把 `[profile.dev] debug` 临时改成 `0`（依赖 override 不变，只重编本 crate）：

| 指标 | `line-tables-only` | `debug = 0` |
| --- | --- | --- |
| 切换后本 crate 冷重建 | 42.91s 墙钟 / user 42.92s | 34.38s 墙钟 / user 37.72s（约再 -12%） |
| 稳态热重建 user | 5.6 ~ 6.1s | 5.5 ~ 5.8s（差异在噪声内） |
| 产物合计 | 883.8 MiB | 约 735 MiB（再 -17%，`.so` 32.4→6.2 MiB） |
| backtrace | 有 `文件:行号` | **无行号/无符号** |

**结论**：`debug = 0` 只再降约 12% 冷重建 CPU 与 17% 体积，却牺牲日常排查能力，
因此默认保留 `line-tables-only`。需要极限提速或排查目标机磁盘紧张时，可临时改为
`debug = 0`（切换触发一次约 35~43s 的本 crate 重建）。

### 2.3 链接器（lld/mold）：无需改动，且无法安装系统级替代

- `which ld.lld / lld / mold / ld.gold` 全部不存在；`sudo` 因 `no new privileges` 不可用，
  无法安装。
- **但 rustc 1.97.1 默认已经在用自带 `rust-lld`**：`strace -f -e trace=execve` 显示
  链接链为 `cc → collect2 → <sysroot>/.../rust-lld -flavor gnu`（普通 `rustc` 单文件
  编译与 `cargo build` 均如此），`collect2` 参数中带 `-fuse-ld=lld`。
- 热重建共有 3 个链接步骤（cdylib + 2 个 bin），每个 `cc/collect2/rust-lld` 链路墙钟
  约 0.8~1.0s，合计约 2.7s 串行；即使换 mold 理论收益也很小。
- `-Clinker-features=+lld`/`gnu-lld` 在 stable 上属 unstable（需 `RUSTC_BOOTSTRAP=1` +
  `-Zunstable-options`），`-Clinker-flavor=ld.lld` 需手工补 CRT/系统库路径，二者都比
  默认行为更脆弱，**不落地**。
- 结论：`.cargo/config.toml` 保持原有 rsproxy 源配置，不增加 linker 配置（见第 4 节注释）。

### 2.4 `cargo build --bins`：无收益

`cargo build --bins -v` 显示 `flowlet_lib` 仍以
`--crate-type staticlib --crate-type cdylib --crate-type rlib` 编译，三个单元
（lib + 2 bin）全部参与，与 `cargo build` 无差异。**不存在命令级跳过 staticlib/cdylib
的方式。**

补充实测（临时把 `crate-type` 改成 `["rlib"]` 测上限，随后已还原）：
- 热重建 4.46s / 4.54s（user 4.82 / 5.13s，FS_OUT 1.39 GB），相比三类型
  5.5~6.0s / user 5.6~6.1s / FS_OUT 2.43 GB，约 **墙钟 -20%、user -12%、IO -43%**；
- 还原后重建一次 8.45s。
- Android 构建需要 `staticlib`/`cdylib`，**不得直接删除**；后续如要拿回这部分收益，
  正确做法是把移动端产物拆到独立 crate（见第 6 节）。

### 2.5 sccache：不落地

`which sccache` 未安装。本仓库日常成本是「本 crate 重编 + 依赖已缓存」，sccache 主要
帮助跨分支/clean 后的全量重建，且 `cargo install sccache` 需要一次较长的编译与较大内存，
在当前 30 GiB 已用 20 GiB + swap 紧张的机器上不划算。结论：不安装、不接入。

### 2.6 opt-level / 其他 profile 项

- `[profile.dev.package."*"] opt-level`：dev 默认即 0，未改动（避免无谓变更）。
- `incremental`：dev 默认开启，未改动。
- `panic` / `lto` / `codegen-units`：默认值即可，未改动（改动会改变语义/产物，不属本次范围）。

### 2.7 release 增量（用户第二痛点，仅实测未改动）

`release` profile 未改动，因此**改前=改后**。`touch lib.rs && cargo build --release -j 8`
（release 依赖已缓存、release incremental 默认关闭，属「改一行代码重新出包」的真实成本）：

| 指标 | 实测值 |
| --- | --- |
| 墙钟 | 74.92s（另一次含 3 个依赖意外重编的样本 85s） |
| CPU | 508% |
| user / sys | 374.70s / 6.03s |
| FS_OUT | ≈ 0.91 GB |
| 产物 | `flowlet` 44.0 MiB、`headless` 23.8 MiB、`.a` 198.0 MiB、`.so` 3.5 MiB、`.rlib` 78.3 MiB |

> 未做全量冷 release 构建（成本过高）。若后续想降低本地 release 迭代成本，可评估
> `[profile.release] incremental = true`，但它会增加首次构建成本、产物体积并影响
> 可复现性，且 Tauri 打包链路未验证，**本次不落地**。

### 2.8 tauri dev

未实际运行 `tauri dev`（会拉起 GUI/占用端口，避免干扰本机）。可以确认的是：
`tauri dev` 与 `cargo build` 共用同一个 `target/` 和 `[profile.dev]`，本次配置对
`tauri dev` 同样生效。`target/debug/.fingerprint` 中存在多组 `flowlet-*` 指纹，说明历史
上在不同构建入口/参数之间切换过，每次切换都会触发一次本 crate 全量重编（≈40s）。
**建议过渡期固定一个开发入口（`tauri dev` 或 `cargo build` 二选一），避免来回切换带来
额外冷重建。**

---

## 3. 改动前后对比总表

| 场景 | 改前（默认 debug=2） | 改后（line-tables-only + 依赖 debug=0） | 说明 |
| --- | --- | --- | --- |
| 稳态热重建（`touch lib.rs && cargo build`） | 墙钟 7.5~8.0s；user 12.6~14.6s；sys 4.4s；FS_OUT 6.98 GB | 墙钟 5.5~6.0s（最终 4.79s）；user 5.3~6.1s；sys 2.0~2.4s；FS_OUT 2.43 GB | 日常编辑成本，user -55% |
| profile 变更后冷重建（`cargo clean -p flowlet` 后） | 41.63s / user 71.35s / sys 9.38s / FS_OUT 8.14 GB | 24.72s（低负载；同负载段 42.91s）/ user 42.9~43.3s / sys 3.81s / FS_OUT 2.84 GB | 一次性重建成本，CPU/IO 约 -40%/-65% |
| release 增量（`touch lib.rs && cargo build --release`） | 未改 release（同一数值） | 74.92s / CPU 508% / user 374.7s / FS_OUT 0.91 GB | release profile 未触碰，改前=改后 |
| `cargo check`（`touch lib.rs && cargo check`） | 未单独复测（机制不变） | 暖态 2.09~2.43s；check 单元首次 11.46s（user 10.53s） | check 只编 metadata，不生成代码，`profile.debug` 不影响其耗时 |
| debug 产物合计 | 3.02 GiB | 883.8 MiB | 约 -71% |
| `target/` 目录（本机） | 31G（含历史多指纹产物） | 14G（debug 11G + release 2.7G） | 清理历史指纹后的存量，仅供参考 |

数据采集命令（可复现）：

```bash
cd src-tauri
touch src/lib.rs
/usr/bin/time -v cargo build            # 看 wall / %CPU / user / sys / FS outputs / RSS
cargo clean -p flowlet && touch src/lib.rs
/usr/bin/time -v cargo build            # 冷重建
touch src/lib.rs
/usr/bin/time -v cargo build --release  # release 增量（不要做全量冷 release）
touch src/lib.rs
/usr/bin/time -v cargo check            # check
stat -c '%s %n' target/debug/flowlet target/debug/headless \
  target/debug/libflowlet_lib.{a,so,rlib}
```

---

## 4. 最终配置与 `.cargo/config.toml`

`src-tauri/Cargo.toml` 末尾已有：

```toml
[profile.dev]
debug = "line-tables-only"

[profile.dev.package."*"]
debug = 0
```

`.cargo/config.toml`：**功能配置不变**（rsproxy 源/重试/超时保留），仅追加说明性注释，
解释为什么没有加 linker 配置（rustc 已默认 rust-lld；系统无 mold/lld 且无 sudo）。
`.cargo/config.toml` 的注释不参与构建，无副作用。

---

## 5. 回滚方法

只回滚本次改动 = 删除 `src-tauri/Cargo.toml` 末尾的 `[profile]` 段（**不要**直接
`git checkout src-tauri/Cargo.toml`：工作区里还有其他人未提交的 Cargo.toml 改动，
整文件回退会误伤）。在仓库根目录执行：

```bash
python3 - <<'EOF'
p = "src-tauri/Cargo.toml"
s = open(p, encoding="utf-8").read()
marker = "# ---------------------------------------------------------------------------\n# 过渡期构建提速"
i = s.index(marker)
open(p, "w", encoding="utf-8").write(s[:i].rstrip() + "\n")
EOF
cd src-tauri && cargo build   # 会触发一次全量依赖重建（debug=2），与 apply 代价同量级（≈2 分钟）
```

回滚成本：一次全量依赖重建（本机 apply 侧实测约 **2 分 10 秒**，`-j 8`；回滚方向为
同一机制，未再单独重复测量以避免再次全量重建）。回滚后 `target/` 会重新变回大体积
debug 产物（约 3 GiB/次构建输出）。

---

## 6. 需要注意的场景（CI / Android / 其他机器）

- **Android**：`[lib] crate-type = ["staticlib","cdylib","rlib"]` 保持不变，移动端产物
  不受影响；本次只改 development profile，Android 的 release APK/AAB 构建不受影响，
  dev 构建的依赖调试信息变少（APK 体积更小、链接更快）。中期方案可把移动端需要的
  staticlib/cdylib 拆到独立 crate，从而让桌面日常 `cargo build` 只产出 rlib
  （见 2.4 的上限实测：热重建约 -20%）。
- **CI（`.github/workflows/build-installers.yml`）**：构建 release，不受本次改动影响。
  若 CI 还跑 debug/test 构建，首次会因 `[profile.dev]` 变化全量重建依赖一次，之后命中
  缓存；产物语义不变。
- **其他开发机**：改动只作用于 dev profile，跨平台（Windows/macOS/Linux）均可生效，
  无需改 platform-specific 配置；依赖 `debug=0` 会让「单步进入第三方库」缺少变量/行号，
  需要时临时把本 crate/依赖改回 `debug = 2` 并接受一次重建。
- **内存紧张的机器**：一次性全量依赖重建期间建议 `cargo build -j 8`（本报告测量口径），
  避免与 swap 争用。
- **旧 rustc**：`rust-lld` 默认行为是 rustc 1.97 的行为；更旧的工具链可能仍走系统
  `ld`，正确性不受影响，只是链接耗时可能略高（本机无 lld/mold 可装，已记录为不可行）。
- **日常调试**：默认 `line-tables-only` 可看到 backtrace 的 `文件:行号`；需要查看局部
  变量时临时改为：

  ```toml
  [profile.dev]
  debug = 2
  ```

  改回会触发一次本 crate 全量重编（约 35~43s，实测冷重建区间）。

---

## 7. 测量与干扰记录

- 测量期间 `loadavg` 在 3~19 之间波动（其他构建/进程负载），因此跨改动的对比以 CPU
  user/sys 时间、FS_OUT 与产物体积为主，墙钟只作参考；报告中的「样本」均为连续多次测量。
- 22:04:12 执行 `cargo clean -p flowlet` 时出现一次
  `Blocking waiting for file lock on build directory`（`target/` 被本会话之外的进程短暂
  占用）。cargo 不打印该等待时长，随后命令立即继续，未观察到 >10s 量级的等待；本次
  未将锁等待计入构建耗时结论。
- 为控制 30 GiB 内存（已用约 20 GiB、swap 使用较多）的峰值，除标注外统一 `-j 8`；
  这会让绝对墙钟略高于默认 `-j 16`，但不影响前后 CPU/IO 对比结论。
- cron/CI 之外的并发构建会改变 `target/` 指纹，可能导致「看起来是冷重建」；本报告
  已把稳态热重建与冷重建分开列示。
