# 自定义渠道资源用量抓取：文件夹发现机制（设计文档）

> 状态：待确认（尚未实现）。
> 决策记录：Friday 这类定制渠道，以 `custom` 渠道下的一个账号承载；
> 「资源用量抓取」的实现通过本机文件夹里的声明式描述符被发现，不进 `config.json`、
> 不进编译期 adapter；抓取脚本只在本机执行，设备同步只传去敏后的观测摘要。

---

## 1. 背景与目标

Flowlet 内置渠道（LongCat / Qwen / Z.AI）支持「后台 webview 登录控制台 → 拦截业务
API → 解析资源用量」，整条链路见 `src-tauri/src/core/scrape_console.rs` 与
`src-tauri/src/commands/scrape.rs`。

这套链路中，配置是声明式的（`config.json → channels_config.scrape`），但有三类行为
是编译进 Rust 的 per-channel adapter：

1. **URL → 槽位** 分类（`ChannelCapabilityAdapter.scrape_response.classify`）；
2. **槽位有效性** 校验（`scrape_response.satisfies`，区分「真数据」与登录失效页）；
3. **同槽位多批合并**（`scrape_response.merge`，如 Qwen 免费额度分 14 批）。

另有前端多处 `channel_id === "longcat/qwen/zhipu"` 硬编码决定是否展示「抓取 / 自动同步」。

**目标**：让用户可以在本机一个指定文件夹下，按渠道/账号名放置一份**声明式描述符**，
为某个 `custom` 渠道账号提供上述 1–3 的行为与解析脚本；Flowlet 启动时发现并校验它，
之后该账号即可像 Qwen 按量付费一样通过 webview 抓取资源用量。抓取脚本与原始响应
**只在本机**，其他设备只通过设备同步拿到去敏后的摘要。

---

## 2. 设计原则与安全边界

- **不引入动态库加载、不引入任意脚本执行**：描述符是 typed JSON；仅有的脚本是
  `interceptor.js` / `extractor.js`，它们与内置渠道一样只在 per-account 抓取 webview
  沙箱内注入，信任边界不变。这符合 `AGENTS.md` 对插件清单的红线。
- **不改变渠道契约**：`custom` 渠道仍按现有规则注册（`plugin-registry.json` +
  `config.json` + 编译期 `custom` adapter 负责模型同步）。文件夹只补「资源用量抓取」
  一个能力，不新增渠道、不新增模型、不参与路由。
- **typed 反序列化，未知键报错**：描述符用严格结构体反序列化，非法即跳过并记 warning，
  不允许静默降级。
- **本机优先**：描述符只从本地目录读取；不进 SQLite、不进 `DeviceUsageSnapshot`。
- **回退明确**：某个账号没有匹配描述符时，行为与今天完全一致（无抓取能力）。

---

## 3. 发现机制

### 3.1 发现目录（按优先级，先命中者优先；同名目录后者被忽略）

1. `<exe 同级目录>/custom-scrape/`（便携版与安装版均可用，便于随身拷贝）
2. `~/.flowlet/custom-scrape/`（回退/补充）

每个描述符一个子目录，目录名建议直接使用账号名（小写归一后），例如：

```text
custom-scrape/
  friday/
    manifest.json      # 类型化描述，不含 JS
    interceptor.js     # 可选；缺省用内置通用拦截器
    extractor.js       # 必填（aggregate=true 时接收 bundle，见 4.3）
```

### 3.2 匹配规则（如何把一个账号解析到描述符）

描述符 `manifest.json` 声明 `channelId` 与可选的 `accountName`。解析优先级：

1. `channelId == "custom"` 且 `accountName` 非空；
2. `channelId == "custom"` 且 `accountName` 省略（作为 `custom` 渠道的兜底，需
   `fallback: true` 显式声明，避免误配到所有账号）；
3. 未来若出现独立定制渠道，允许 `channelId != "custom"`（此时不要求 `accountName`）。

`accountName` 匹配为大小写不敏感、trim 后**先精确、后子串**；描述符目录名只是便于
人工识别的建议命名，不参与匹配（匹配只看 manifest 字段），避免「目录名 vs 账号名」
两套事实源。

### 3.3 加载时机与热更新

- **启动时**：`AppState` 初始化阶段扫描目录、逐个校验，构建进程内全局注册表
  （`OnceLock`，与 `plugin_registry()` 一致，避免把状态穿透到所有捕获回调）。
- **运行时重载**：新增 command `reload_custom_scrape_registry`，用户放入/修改描述符后
  可手动重载，无需重启。抓取模式在每次 `resolve_scrape_mode` 时按注册表解析，因此
  重载后下一次抓取即生效。
- **失败处理**：单个描述符校验失败只跳过该文件，记 `tracing::warn!`，不阻断启动。

---

## 4. manifest schema（v1）

### 4.1 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `schemaVersion` | integer | 是 | 固定 `1` |
| `channelId` | string | 是 | 挂载到的渠道；Friday 场景为 `"custom"` |
| `accountName` | string | 条件 | `channelId=="custom"` 时必填 |
| `fallback` | boolean | 否 | `channelId=="custom"` 且省略 `accountName` 时须为 `true` |
| `resourceModes` | array | 是 | 见 4.2 |
| `login` | object | 否 | 登录页识别，缺省 `{ "kind": "none" }` |
| `modes` | object | 是 | `modeKey → ModeConfig`，见 4.3 |
| `summary` | object | 是 | 去敏摘要映射，见 4.5 |

### 4.2 `resourceModes`

账号 `resource_mode` 与抓取模式的映射，语义同内置
`ConsoleScrapeAdapter::ResourceModes`：

```jsonc
"resourceModes": [
  { "resourceMode": "pay_as_you_go", "modeKey": "paygo" }
]
```

- `resourceMode`：账号字段 `resource_mode` 的取值。
- `modeKey`：`modes` 里的键。
- 历史账号 `resource_mode == null` 时，按 `pay_as_you_go` 兜底（与现有
  `default_resource_mode` 一致）。
- 至少 1 项；同一 `resourceMode` 不重复。

### 4.3 `modes[*]`（复用内置 `ScrapeModeConfig` + 声明式 slot 规则）

```jsonc
"paygo": {
  "consoleUrl": "https://friday.example.com/billing",
  "consoleUrlSecondary": null,   // 可选，多阶段抓取第二阶段
  "consoleUrlTertiary": null,    // 可选，第三阶段
  "aggregate": true,             // true: extractor 接收 bundle；false: 接收单槽位 raw
  "requiredSlots": ["usage", "balance"],
  "slots": {                     // 可选；aggregate=true 时 requiredSlots 必须在 slots 中
    "usage": {
      "match":     { "kind": "url_substring", "value": "/api/v2/usage", "caseInsensitive": true },
      "satisfies": { "kind": "json_path", "path": "$.data.used", "expect": "number" },
      "merge":     { "kind": "last_write_wins" }
    },
    "balance": {
      "match":     { "kind": "url_substring", "value": "/api/v2/balance" },
      "satisfies": { "kind": "json_path", "path": "$.data.amount", "expect": "number" }
    }
  }
}
```

`consoleUrlSecondary` / `consoleUrlTertiary` 语义与内置 `ScrapeModeConfig` 完全一致
（多阶段聚合抓取）。`interceptor.js` / `extractor.js` 从同目录文件读取，不内嵌 JSON。

**`match`（URL → 槽位）**，枚举：

| kind | 说明 |
|------|------|
| `url_substring` | `value` 子串匹配，`caseInsensitive` 默认 `true` |
| `url_prefix` | `value` 前缀匹配 |
| `url_exact` | 精确匹配（去掉查询串后比较，可选保留 `includeQuery`） |
| `url_regex` | Rust `regex` 匹配；加载时校验，非法即跳过描述符 |
| `fallback` | 未命中其他槽位的兜底（单响应模式常用） |

命中规则：除 `fallback` 外按 `slots` 声明顺序取首个命中；同 URL 只进一个槽位。

**`satisfies`（槽位有效性）**，枚举：

| kind | 说明 |
|------|------|
| `json_valid` | 默认；body 是合法 JSON 即视为有效 |
| `json_path` | 在 body 上求 JSONPath，按 `expect` 校验 |
| `none` | 永远有效（不推荐，会失去登录失效防护） |

`expect` 取值：`present` / `number` / `boolean` / `string` / `array` / `object` /
`nonempty_string` / `positive_number`。与内置 `satisfies` 的语义一致：登录失效返回的
合法 JSON 缺少业务字段时不会「误判抓全」，从而进入 `console_action_required` 流程。

**`merge`（同槽位多批合并）**：

| kind | 说明 |
|------|------|
| `last_write_wins` | 默认 |
| `merge_arrays` | `{ "path": "$.data.Data", "dedupBy": ["$.Template.Code"], "keepFields": ["Template", "Status"] }`；按 `dedupBy` 去重（后到覆盖先到），`keepFields` 裁剪白名单字段 |

### 4.4 `login`（登录页识别）

枚举与内置 `LoginPageAdapter` 对应：

```jsonc
{ "kind": "none" }                                    // 不识别登录页
{ "kind": "generic" }                                 // url 含 /login、/signin、passport、oauth 等
{ "kind": "generic_or_host", "host": "friday.example.com" }  // 上述规则 + host 命中
```

### 4.5 `summary`（去敏摘要映射，供设备同步）

设备同步只传输 `SyncedAccountResource` 的去敏字段。其中 `balance / currency /
token_total / token_used / token_remaining / expires_at` 来自抓取快照中已归一化的字段
（`scrape_balance` 写入 `AccountBalanceSnapshot` 的那套字段），无需在描述符里重复声明；
唯一需要描述符提供的是快照里没有的 `plan`（套餐名）：

```jsonc
"summary": {
  "plan": "API 按量付费"
}
```

- `plan` 可选；缺省时 `account_resource_sync` 对自定义渠道回退为 `"API 按量付费"`。
- v1 不映射 `balance_text` / `quota_windows`（保持 `None` / 空）。

### 4.6 `extractor` 输出契约（不变）

`extractor.js` 返回 JSON，字段与内置完全一致，`scrape_balance` 与
`ScrapeBalanceResult` 无需改动：

```text
balance, currency, plan_name, token_total, token_used, token_remaining,
token_expire_at, token_packs(数组)
```

- `aggregate == true`：extractor 签名 `function extract(bundle)`，`bundle` 为
  `{ slotKey: 已解析响应 JSON, ... }`（与 `build_aggregate_bundle` 一致）。
- `aggregate == false`：extractor 签名 `function extract(raw)`，`raw` 为唯一目标槽位。

---

## 5. 运行时接入点（Rust）

| 文件 | 改动 |
|------|------|
| `core/custom_scrape.rs`（新增） | 描述符结构体、严格校验、目录扫描、`OnceLock` 全局注册表、`reload` 函数 |
| `core/scrape_console.rs` | `resolve_scrape_mode` 增加账号名上下文，内置 adapter 无抓取时回退查注册表；`ScrapeModeRuntime` 携带 `slot_rules`（match/satisfies/merge）与 `summary` |
| `core/channel_capability_adapter.rs` | 把 `classify/satisfies/merge` 的全局分派改为「内置 adapter + 自定义注册表」的通用分派（按 mode 携带的 slot 规则） |
| `commands/scrape.rs` | `handle_intercepted_response` / `scrape_responses_complete` / `collect_scrape_slots` 改为按 `ScrapeModeRuntime` 的 slot 规则分派；`channel_resource_sync_method` 去掉 `longcat/qwen/zhipu` 硬编码，改为通用能力判定；新增 `reload_custom_scrape_registry` / `list_custom_scrape_channels` command |
| `core/account_resource_sync.rs` | `has_automatic_resource_sync` 与 `channel_resource` 用描述符的 `summary` 映射替换硬编码 `parse_qwen_*` / `parse_zhipu_*`，泛化生成 `SyncedAccountResource` |
| `lib.rs` | 启动时加载自定义注册表 |

关键重构点：原生 WebView2 / WebKitGTK 捕获回调目前是无 channel 上下文的全局分派。
改造后 `classify_response_url` 需要感知「当前抓取窗口的 mode」，实现上把 slot 规则挂到
`ScrapeModeRuntime`，并在 `open_scrape_console` 建立 `account_id → mode` 的映射供捕获
回调查询（该映射与现有 `scrape_pending` 同生命周期清理）。

---

## 6. 运行时接入点（前端）

| 文件 | 改动 |
|------|------|
| `src/domains/channel/commands.ts` | 新增 `list_custom_scrape_channels` / `reload_custom_scrape_registry` |
| `src/domains/channel/types.ts` | 自定义渠道的 `supports_scrape_balance` 从「描述符存在」动态得出，而非 config.json 静态值 |
| `src/features/channel-accounts/AccountEditorDrawer.tsx` | 「抓取 / 自动同步」入口不再硬编码 `longcat/qwen/zhipu`，改读同一能力查询 |
| `src/features/channel-accounts/accountSyncStatus.ts` | `hasChannelAutoSync` 对 custom 渠道按描述符能力判定 |

---

## 7. 「只在本机抓取」的保证

现有架构已满足核心诉求，本设计不改动、只补强：

1. **抓取脚本**：`interceptor.js` / `extractor.js` 只从本地目录读取，只注入本机
   per-account 抓取 webview。
2. **原始响应**：`account_balance_snapshots.raw_scraped_json` 只写本机 SQLite。
3. **设备同步载荷**（`DeviceUsageSnapshot.account_resources`）：只含 `SyncedAccountResource`
   去敏摘要（`plan/balance/token_*/expires_at`），**不含**原始响应、Cookie、脚本。
4. **描述符不入库、不入同步**：注册表只读本地目录；同步快照由 `build_synced_account_resources`
   生成，新增的 `summary` 映射只产出上述去敏字段。

因此：其他设备能看到「本机抓完的余额/额度摘要」，但永远拿不到本机的抓取脚本与原始报文。

---

## 8. 错误处理与降级

| 情况 | 行为 |
|------|------|
| 目录不存在 | 注册表为空，行为与今天一致 |
| manifest 缺字段 / 未知键 / 类型错误 | 跳过该描述符，`warn!` |
| `url_regex` 非法 | 跳过该描述符 |
| `requiredSlots` 引用未在 `slots` 中声明的槽位 | 跳过该描述符 |
| 账号无匹配描述符 | 无抓取能力；前端不展示抓取入口 |
| 描述符存在但抓取登录失效 | 复用现有 `console_action_required` / `LoginRequired` 流程 |

---

## 9. 实施阶段（已全部落地）

- **Phase 0**：确认 schema 与接入点。
- **Phase 1（后端）**：`custom_scrape.rs` 发现 + 校验；`resolve_scrape_mode` 回退；
  `url_substring` / `url_prefix` / `url_exact` / `url_regex` / `fallback`；
  `json_valid` / `json_path` / `none`；`last_write_wins` / `merge_arrays`；
  `summary` 去敏映射；`channel_resource_sync_method` 与 `account_resource_sync` 泛化。
- **Phase 2（前端）**：能力查询 command（`list_custom_scrape_channels` /
  `reload_custom_scrape_registry`）+ 账号编辑器入口 + 自动同步判定。
- **未做（明确留白）**：`quota_windows` 映射、`balance_text`；两者对自定义渠道
  保持 `None` / 空，远端设备只看到 `plan/balance/token_*/expires_at`。

---

## 10. 测试计划

- `custom_scrape.rs` 单元测试：目录扫描、字段校验、`accountName` 匹配（精确/子串/大小写）、
  `fallback` 约束、非法描述符跳过。
- `scrape_console.rs` / `commands/scrape.rs`：自定义 slot 规则下的 classify/satisfies/
  complete 判定；登录失效不误判抓全。
- `account_resource_sync.rs`：`summary` 映射生成 `SyncedAccountResource`，确认不含
  `raw_scraped_json` 与脚本。
- 前端：`accountSyncStatus` / 编辑器入口在 custom 账号 + 描述符存在时的展示。
- 契约：确认 `DeviceUsageSnapshot` 序列化不新增描述符相关字段。

---

## 11. 示例（Friday）

```text
custom-scrape/
  friday/
    manifest.json
    interceptor.js
    extractor.js
```

`manifest.json`：

```jsonc
{
  "schemaVersion": 1,
  "channelId": "custom",
  "accountName": "Friday",
  "resourceModes": [
    { "resourceMode": "pay_as_you_go", "modeKey": "paygo" }
  ],
  "login": { "kind": "generic_or_host", "host": "friday.example.com" },
  "modes": {
    "paygo": {
      "consoleUrl": "https://friday.example.com/billing",
      "aggregate": true,
      "requiredSlots": ["usage", "balance"],
      "slots": {
        "usage": {
          "match": { "kind": "url_substring", "value": "/api/v2/usage" },
          "satisfies": { "kind": "json_path", "path": "$.data.used", "expect": "number" }
        },
        "balance": {
          "match": { "kind": "url_substring", "value": "/api/v2/balance" },
          "satisfies": { "kind": "json_path", "path": "$.data.amount", "expect": "number" }
        }
      }
    }
  },
  "summary": {
    "plan": "API 按量付费"
  }
}
```
