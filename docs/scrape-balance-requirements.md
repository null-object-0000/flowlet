# 控制台抓取套餐余量需求文档

> 状态:需求已确认,待实施
> 最后更新:2026-07-21
> 作者:经用户抓包核实

## 1. 背景与目标

Flowlet 当前只对 **DeepSeek / Kimi** 提供 API 式余额自动同步(`supports_balance_query=true`)。
**LongCat**(Token 资源包 / 按量付费余额)和 **千问 Qwen Token Plan**(Credits 订阅)的套餐余量**只在官方控制台可见**,
没有公开 API——用户在账号编辑器里只能手动维护,是典型痛点。

**目标**:在 Flowlet 内**后台加载**这些提供商的官方控制台,注入 JS **拦截页面自己的 API 请求**,
用页面自身的**结构化响应**解析出套餐余量,结果作为 `source="scrape"` 写入已有的 `account_balance_snapshots` 余额快照表,
复用现有展示与持久化链路。

**目标渠道**:LongCat(双模式)+ Qwen Token Plan。做成**数据驱动**的框架(配置即拦截器/解析器 JS),
未来新渠道只改 config.json。

## 2. 核心架构决策

### 2.1 webview 本身就是会话容器(关键洞察)
WebView2 在 app 数据目录里持久化 cookie/Storage。**per-account 长驻后台 webview** 让登录态在多次抓取间自然存活(甚至跨应用重启),无需手动加密持久化会话——把会话管理交给平台,比我们自己存/恢复 cookie 更简单可靠。只有网站自身过期才需重新登录。

### 2.2 每轮都加载页面 + 拦截(不沉淀端点)
每次抓取都把后台 webview 导航到控制台 URL,等页面自发调用自己的 API,实时拦截响应。避免 reqwest cookie-jar 的复杂度。

### 2.3 JS 注入拦截 fetch/XHR + IPC 回传
页面加载前注入 JS,monkeypatch `fetch` + `XMLHttpRequest`,捕获匹配响应,
通过 `window.__TAURI_INTERNALS__.invoke` 实时回传 Rust。

### 2.4 JS 函数解析结果
config 里配 per-channel 的 JS `extractor` 函数,把捕获的 JSON 映射成结构化余额对象。

### 2.5 手动触发 + 写入余额快照
账号编辑器提供「抓取余额」按钮,结果 `source="scrape"` 写入 `account_balance_snapshots`。

### 2.6 需要时弹出登录
后台 webview 平时隐藏;若检测到跳转登录页 / API 返回 401 / 拦截器未触发,把 webview 移到可见区域让用户登录,登录后继续抓取。

## 3. 已核实的 API 端点与响应结构

> 以下端点均经用户实际抓包确认(2026-07-21)。

### 3.1 LongCat —— token_pack 模式(资源包)

| 项目 | 值 |
|------|-----|
| **页面 URL** | `https://longcat.chat/platform/usage?tab=token` |
| **目标接口** | `POST https://longcat.chat/api/pay/quota/metering/token-packs/summary` |
| **请求头** | 页面 JS 自动生成(`m-traceid` 随机、`m-appkey` 固定),纯拦截响应即可 |
| **鉴权** | `credentials: include`,cookie 由 webview 自动携带 |

**响应结构**(实测):
```jsonc
{
  "code": 0, "msg": "success",
  "data": {
    "currentLot": {
      "lotId": 151724, "grantCategory": "GIFT", "source": "FREE_PACK",
      "modelScope": "{\"models\":[\"ALL\"]}",
      "remainingToken": 17652364, "consumedToken": 32347636, "frozenToken": 0,
      "totalToken": 50000000, "consumedRatio": 0.64695272,
      "effectiveTime": "2026-06-30 01:00:31", "expireTime": "2026-07-30 01:00:31",
      "remainSeconds": 712092, "consumeOrder": 1, "status": "ACTIVE"
    },
    "estimate": { "windowDays": 7, "dailyAverageToken": 1620510, "exhaustedAfterDays": 11 },
    "otherLots": [
      // 同 currentLot 结构,每项是一个资源包
      { "lotId": 159869, "remainingToken": 10000000, "consumedToken": 0, "totalToken": 10000000, ... },
      { "lotId": 160795, "remainingToken": 5000000, "consumedToken": 0, "totalToken": 5000000, ... }
    ]
  }
}
```

**字段映射**(全部 lots 求和):

| 响应字段路径 | 余额快照字段 | 计算方式 |
|---|---|---|
| currentLot + otherLots 全部 | `token_pack_total` | Σ `totalToken` |
| 同上 | `token_pack_used` | Σ `consumedToken` |
| 同上 | `token_pack_remaining` | Σ `remainingToken` |
| 全部 lots 最早 `expireTime` | `token_pack_expire_at` | min(`expireTime`) |
| 整份响应 | `raw_scraped_json` | 完整 payload |
| 固定 | `plan_name` | `"LongCat 资源包"` |

### 3.2 LongCat —— pay_as_you_go 模式(按量付费)

| 项目 | 值 |
|------|-----|
| **页面 URL** | `https://longcat.chat/platform/usage?tab=api` |
| **目标接口** | `POST https://longcat.chat/api/pay/quota/metering/api-usage/summary` |
| **请求头** | 页面 JS 自动生成,纯拦截响应即可 |
| **鉴权** | `credentials: include` |

**响应结构**(实测,用户充值 1 元后):
```jsonc
{
  "code": 0, "msg": "success",
  "data": {
    "paygoBalanceCent": 100,        // 100 分 = 1.00 元
    "paygoStatus": "NORMAL",
    "rechargeEnabled": true,
    "statusTip": "余额不足 ¥20，请及时充值以确保 API 服务正常使用",
    "paygoBalance": {
      "primary": { "currency": "CNY", "amount": "1.00" },
      "secondary": null
    },
    "exchangeRate": 6.8
  }
}
```

**字段映射**:

| 响应字段路径 | 余额快照字段 | 计算方式 |
|---|---|---|
| `paygoBalanceCent` | `balance` | ÷ 100(分→元) |
| `paygoBalance.primary.currency` | `currency` | 直接取值 "CNY" |
| 固定 | `plan_name` | `"LongCat 按量付费"` |

**实测验证**:充值 1 元后 `paygoBalanceCent=100` → `balance=1.00`,与 `paygoBalance.primary.amount="1.00"` 一致 ✓

### 3.3 Qwen Token Plan —— 三接口聚合

| 项目 | 值 |
|------|-----|
| **页面 URL** | `https://platform.qianwenai.com/home/billing/subscription/token-plan-individual` |

**三个接口组合出完整用量**(页面显示 = 订阅定档位 + 配额配置定总额 + 用量定剩余%):

| 接口 | URL 路径中的 `api` 参数 | 作用 |
|------|------------------------|------|
| **subscription** | `...%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fsubscription` | 返回当前订阅档位 `specCode`(如 `"standard"`) |
| **quota-config** | `...%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fquota-config` | 返回各档位额度:`standard` = `{five_hour:3000, weekly:10000}` |
| **usage** | `...%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage` | 返回消耗百分比:`per5HourPercentage`、`per1WeekPercentage`、`per1WeekResetTime` |

**公共请求特征**:
- URL 模板:`POST https://cs-data.qianwenai.com/data/api.json?product=sfm_bailian&action=BroadScopeAspnGateway&api=...`
- 请求体:URL 编码表单,含 `sec_token`、`region`、`params`(含 `cornerstoneParam` 与 `Api`/`Data`)
- `credentials: include`

**响应结构**(实测):

subscription:
```jsonc
{
  "data": { "DataV2": { "data": { "data": {
    "instanceCode": "sfm_tokenplansolo_public_cn-...",
    "specCode": "standard",          // 当前订阅档位
    "remainingDays": 30,
    "startTime": 1784512320000,
    "endTime": 1787241600000,       // 订阅结束时间
    "autoRenewFlag": false,
    "status": "VALID"
  }}}}
}
```

quota-config:
```jsonc
{
  "data": { "DataV2": { "data": { "data": {
    "standard": { "five_hour": 3000.0, "weekly": 10000.0 },
    "lite":     { "five_hour": 700.0,  "weekly": 2500.0 },
    "pro":      { "five_hour": 12000.0, "weekly": 40000.0 }
  }}}}
}
```

usage:
```jsonc
{
  "data": { "DataV2": { "data": { "data": {
    "per5HourPercentage": 0.0,
    "per1WeekPercentage": 0.7886782422,
    "per1WeekResetTime": 1785130440000
  }}}}
}
```

**计算逻辑**:
- `总额 = quota_config[subscription.specCode]`(如 standard → weekly=10000)
- `剩余量 = 总额 × (1 - usage 百分比)`(如 10000 × (1-0.7886) ≈ 2113)

**字段映射**(以 7天额度 `weekly` 为主展示):

| 来源 | 余额快照字段 | 计算方式 |
|---|---|---|
| `quota_config[specCode].weekly` | `token_pack_total` | 直接取值(如 10000) |
| `total × per1WeekPercentage` | `token_pack_used` | 10000 × 0.7886 ≈ 7887 |
| `total − used` | `token_pack_remaining` | 10000 − 7887 = 2113 |
| `subscription.endTime` | `token_pack_expire_at` | 订阅结束时间 |
| 三份响应合并 | `raw_scraped_json` | `{subscription, quota_config, usage}` |
| 固定 | `plan_name` | `"Token Plan 个人版(" + specCode + ")"` |

## 4. 拦截器与解析器 JS

### 4.1 LongCat interceptor(双端点共用)

```js
(() => {
  try {
    if (window.location.origin !== 'https://longcat.chat') return 'ok-not-target';
    const TARGETS = [
      '/api/pay/quota/metering/token-packs/summary',
      '/api/pay/quota/metering/api-usage/summary'
    ];
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const matches = (url) => TARGETS.some((t) => url.includes(t));
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (matches(url)) {
        res.clone().text().then((body) => {
          invoke('handle_intercepted_response', { channelId: 'longcat', url, body })
            .catch(() => {});
        }).catch(() => {});
      }
      return res;
    };
    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function () {
      const xhr = new OrigXHR();
      const origOpen = xhr.open;
      xhr.open = function (m, u) { this._url = u; return origOpen.apply(this, arguments); };
      xhr.addEventListener('readystatechange', () => {
        if (xhr.readyState === 4 && xhr.status === 200 && matches(xhr._url || '')) {
          invoke('handle_intercepted_response', { channelId: 'longcat', url: xhr._url, body: xhr.responseText })
            .catch(() => {});
        }
      });
      return xhr;
    };
    return 'ok-injected';
  } catch (e) { return 'err:' + e.message; }
})();
```

### 4.2 LongCat extractors(双模式)

```js
// token_pack 模式:全部 lots 求和
function extractLongCatTokenPack(raw) {
  try {
    const d = raw?.data || raw;
    const lots = [d.currentLot, ...(d.otherLots || [])].filter(Boolean);
    if (!lots.length) return null;
    let total = 0, used = 0, remaining = 0, earliestExpire = null;
    for (const lot of lots) {
      total += lot.totalToken || 0;
      used += lot.consumedToken || 0;
      remaining += lot.remainingToken || 0;
      if (lot.expireTime && (!earliestExpire || lot.expireTime < earliestExpire)) {
        earliestExpire = lot.expireTime;
      }
    }
    return {
      balance: null, currency: null, plan_name: 'LongCat 资源包',
      token_total: total || null, token_used: used || null,
      token_remaining: remaining || null,
      token_expire_at: earliestExpire
    };
  } catch (e) { return null; }
}
// pay_as_you_go 模式:分→元换算
function extractLongCatPaygo(raw) {
  try {
    const d = raw?.data || raw;
    const cent = d.paygoBalanceCent;
    if (cent == null) return null;
    const yuan = Math.round((Number(cent) / 100) * 100) / 100;
    const currency = d.paygoBalance?.primary?.currency || 'CNY';
    return {
      balance: yuan, currency, plan_name: 'LongCat 按量付费',
      token_total: null, token_used: null, token_remaining: null,
      token_expire_at: null
    };
  } catch (e) { return null; }
}
```

### 4.3 Qwen interceptor(三端点)

```js
(() => {
  try {
    if (window.location.origin !== 'https://platform.qianwenai.com') return 'ok-not-target';
    const TARGETS = [
      '/tokenplan/personal/api/v2/subscription',
      '/tokenplan/personal/api/v2/quota-config',
      '/tokenplan/personal/api/v2/usage'
    ];
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const matches = (url) => TARGETS.some((t) => url.includes(t));
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (matches(url)) {
        res.clone().text().then((body) => {
          invoke('handle_intercepted_response', { channelId: 'qwen', url, body })
            .catch(() => {});
        }).catch(() => {});
      }
      return res;
    };
    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function () {
      const xhr = new OrigXHR();
      const origOpen = xhr.open;
      xhr.open = function (m, u) { this._url = u; return origOpen.apply(this, arguments); };
      xhr.addEventListener('readystatechange', () => {
        if (xhr.readyState === 4 && xhr.status === 200 && matches(xhr._url || '')) {
          invoke('handle_intercepted_response', { channelId: 'qwen', url: xhr._url, body: xhr.responseText })
            .catch(() => {});
        }
      });
      return xhr;
    };
    return 'ok-injected';
  } catch (e) { return 'err:' + e.message; }
})();
```

### 4.4 Qwen extractor(三响应聚合)

```js
// 由 Rust 侧在收齐后注入三份响应,再调用 extractQwen({sub, quota, usage})
function extractQwen(bundle) {
  try {
    const sub = bundle?.subscription?.data?.DataV2?.data?.data || {};
    const quota = bundle?.quota_config?.data?.DataV2?.data?.data || {};
    const usage = bundle?.usage?.data?.DataV2?.data?.data || {};
    const specCode = sub.specCode || 'standard';
    const tier = quota[specCode] || quota.standard || {};
    const weeklyTotal = tier.weekly != null ? Number(tier.weekly) : null;
    const per1WeekPct = usage.per1WeekPercentage != null ? Number(usage.per1WeekPercentage) : null;
    if (weeklyTotal == null || per1WeekPct == null) return null;
    const used = Math.round(weeklyTotal * per1WeekPct);
    return {
      balance: null, currency: null,
      plan_name: 'Token Plan 个人版(' + specCode + ')',
      token_total: weeklyTotal,
      token_used: used,
      token_remaining: Math.max(0, weeklyTotal - used),
      token_expire_at: sub.endTime ? new Date(sub.endTime).toISOString() : null
    };
  } catch (e) { return null; }
}
```

## 5. 技术约束(Tauri v2.11.5 已验证)

> 以下 API 对照 `tauri-2.11.5` 源码验证,行号已标注。

| 关注点 | 真实 API(源码位置) |
|--------|----------|
| **JS 注入** | `initialization_script(script: impl Into<String>)` + `initialization_script_for_all_frames(script)`(WebviewWindowBuilder webview_window.rs:**945**/**990**)。❌ `add_script_to_execute_on_document_created` 不存在。 |
| **eval 时机** | 必须等 `on_page_load(Finished)` 后才能 `eval`/`eval_with_callback`。 |
| **导航** | `WebviewWindow::navigate(&self, url: Url)`(webview_window.rs:**2384**) |
| **导航守卫** | `on_navigation<F: Fn(&Url) -> bool + Send + 'static>`(webview_window.rs:**266**) |
| **页面加载** | `on_page_load<F: Fn(WebviewWindow, PageLoadPayload) + Send + Sync + 'static>`(webview_window.rs:**421**);`PageLoadEvent::Started`/`Finished`(mod.rs:**21**) |
| **隐藏窗口** | `.visible(false)`(webview_window.rs:**871**)+ `show`/`set_size`/`set_position`/`set_focus`(弹出登录) |
| **JS → Rust IPC** | `window.__TAURI_INTERNALS__.invoke`(manager/webview.rs:**172-185**) |
| **command 可从 JS 调用** | `generate_handler!` 注册的每个 `#[tauri::command]` 自动可调用 |
| **`eval_with_callback`** | 存在(mod.rs:**1929**),Windows 吞异常 → JS 必须 try/catch 返回 JSON 串 |
| **cookie API** | `cookies()`/`set_cookie()` 等存在,但 **Windows 死锁警告**:必须 `async` command + `spawn_blocking` |
| **CSP** | `tauri.conf.json` 当前 `csp: null` → 注入脚本不会被拦截 |

## 6. 数据模型变更

### 6.1 SQLite 迁移

- `channel_presets` 加列 `supports_scrape_balance INTEGER NOT NULL DEFAULT 0`(用 `add_column_if_missing`,storage.rs:**922** 模式)
- `account_balance_snapshots` 加列 `raw_scraped_json TEXT`(存完整拦截 payload 用于调试)
- 已有行迁移:仿 `ensure_preset_balance_query`(storage_config.rs:**216-231**)加 `ensure_preset_scrape_balance`

### 6.2 结构体变更

- Rust `ChannelPreset`(config.rs:**234-255**)加 `supports_scrape_balance: bool`
- Rust `AccountBalanceSnapshot`(config.rs:**682-698**)加 `raw_scraped_json: Option<String>`
- TS `ChannelPreset`(src/domains/channel/types.ts:**7-27**)加 `supports_scrape_balance: boolean`
- TS `AccountBalanceSnapshot`(src/domains/account/types.ts:**33-48**)加 `raw_scraped_json?: string | null`

### 6.3 能力标志

仅 longcat / qwen 构造函数设 `supports_scrape_balance: true`(kimi/deepseek 已有 API 余额)。

## 7. 实施阶段

### Phase A —— config 模式
- `config.json` 加 `scrape` 块(`console_url` + `interceptor_js` + `extractor_js`)
- `channels_config.rs` 加 `ScrapeConfigJson` + `ScrapeConfig` + `scrape_config_for(channel_id)`
- `docs/config.md` 同步

### Phase B —— 能力标志 + 数据模型
- 结构体加字段 + SQLite 迁移 + TS 类型

### Phase C —— per-account 后台 webview 生命周期
- `AppState` 加 `scrape_webviews: Arc<Mutex<HashMap<String, WebviewWindow>>>`
- 打开/保活/关闭/弹出登录

### Phase D —— Rust command 层
- 6 个 command:`open/navigate/close_scrape_console`、`handle_intercepted_response`、`run_scrape_extractor`、`scrape_balance`(编排器)
- 全部 `async`,cookie 操作(如有)在 `spawn_blocking`

### Phase E —— 前端 UI
- `account/commands.ts` 加 `scrapeBalance` 包装
- 新 Hook `useScrapeConsole.ts`(UX 状态机)
- `AccountEditorDrawer.tsx` 加 `supports_scrape_balance && !supports_balance_query` 分支

### Phase F —— 测试 + 文档
- Rust 单测(config 解析、extractor 映射、迁移幂等)
- 前端 vitest(`useScrapeConsole` 状态机、按钮渲染条件)
- `tsc --noEmit` + `cargo check` + `cargo test`

## 8. 抓取流程(精确)

1. **触发**:用户点「抓取余额」(仅 `supports_scrape_balance && !supports_balance_query` 时显示)
2. **解析配置**:读 account → channel preset → scrape config
3. **ensure webview**:查 AppState map 是否已有 `scrape-{account_id}`,无则创建(隐藏 + `initialization_script`)
4. **导航**:`webview.navigate(console_url)`,`initialization_script` 自动重注入
5. **等页面**:await `on_page_load(Finished)`,超时 15s
6. **拦截器触发**:页面自发调 API 时,monkeypatch 的 fetch/XHR 捕获匹配响应,实时 IPC 回传,Rust 缓冲到 per-account buffer
7. **检测需登录**:`on_navigation` 检测到跳转登录 URL / API 返回 401 / 拦截器超时未触发 → 发 `scrape:need-login` + 弹出 webview
8. **跑 extractor**:单响应(LongCat)直接 `eval_with_callback`;三响应(Qwen)等收齐后合并计算
9. **写快照**:`source="scrape"`、`synced_at=now`、`remark="控制台抓取"`、`raw_scraped_json`、解析数值 → `token_pack_*` / `balance`+`currency`
10. **发事件**:`scrape:result` / `scrape:error`
11. **再隐藏**:`webview.hide()`,句柄留 map

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 拦截器未触发 | `raw_scraped_json` 列 + 调试覆盖层;JS 作为配置数据可无重编更新 |
| 登录检测误判 | 三信号组合(nav 到登录 URL / 401 / 超时),任一触发就弹出,误判无害 |
| 页面导航时序竞争 | `eval` 前 await `on_page_load(Finished)`;收集窗口去抖 2-3s;整体超时 20s |
| 隐藏窗口可靠性 | `.visible(false)` 创建,WebView2 离屏也渲染 |
| WebView2 机器人检测 | 设合理 userAgent;加载真实控制台页 |
| Windows eval 吞异常 | 所有注入 JS 和 extractor 必须 try/catch 返回 JSON 串 |
| 多次/并发抓取 | per-account 串行化:map + per-account `scraping` 锁 |

## 10. 不在本次范围

- 定时自动抓取(留作后续)
- 沉淀 API 端点 + reqwest 直连(每轮都加载页面拦截)
- 手动加密持久化会话(webview 自身即会话容器)
- 跨协议转换、复杂调度等无关能力

## 11. 关键文件清单

实施时主要涉及:

- `config.json`(根)
- `src-tauri/src/core/channels_config.rs`
- `src-tauri/src/core/config.rs`
- `src-tauri/src/core/storage.rs`
- `src-tauri/src/core/storage_usage.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/capabilities/default.json`
- `src/domains/channel/types.ts`
- `src/domains/account/types.ts`
- `src/domains/account/commands.ts`
- `src/features/channel-accounts/useScrapeConsole.ts`(新)
- `src/features/channel-accounts/AccountEditorDrawer.tsx`
- `docs/config.md`、`docs/channel-integration.md`(同步)
