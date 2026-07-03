# 数据结构重构详细规格

> 本文档定义 Flowlet 破坏式重构后所有核心数据结构的精确字段、TypeScript 类型、Rust 结构和 SQLite Schema。后续 Rust 编码、前端编码均以此为准。

---

## 1. ProtocolType

### Rust 定义

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProtocolType {
    OpenAi,
    Anthropic,
}

impl ProtocolType {
    /// 用路径前缀判断协议类型。
    pub fn from_path(path: &str) -> Option<Self> {
        let p = path.trim_start_matches('/');
        if p.starts_with("anthropic/") {
            Some(Self::Anthropic)
        } else if p.starts_with("v1/")
            || p.starts_with("openai/")
            || p == "v1"
            || p == "openai"
        {
            Some(Self::OpenAi)
        } else {
            None
        }
    }

    /// 用于日志/存储的静态字符串表示。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
        }
    }
}
```

### TypeScript 定义

```typescript
type ProtocolType = "openai" | "anthropic";
```

### 路径识别规则（重要）

- 输入来自 Uri `path_and_query().map(|x| x.as_str())`。
- 取 `trim_start_matches('/')` 后：
  - 以 `anthropic/` 开头 → Anthropic
  - 以 `v1/`、`openai/` 开头，或纯 `v1`、`openai` → OpenAi
  - 其他 → 仅用于路由匹配，不判断协议（如 `/health`）

### SQLite 存储

`protocol_type TEXT NOT NULL CHECK(protocol_type IN ('openai','anthropic'))`

---

## 2. PriceSource

### Rust 定义

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PriceSource {
    #[default]
    Preset,
    Synced,
    Manual,
}
```

### TypeScript 定义

```typescript
type PriceSource = "preset" | "synced" | "manual";
```

### SQLite 存储

`source TEXT NOT NULL DEFAULT 'preset' CHECK(source IN ('preset','synced','manual'))`

---

## 3. ChannelPreset

### Rust 定义

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelPreset {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub supported_protocols: Vec<ProtocolType>,
    pub openai_base_url: String,
    pub anthropic_base_url: String,
    pub default_model: String,
    pub supports_model_list: bool,
    pub supports_model_detail: bool,
    pub supports_price_sync: bool,
    pub supports_balance_query: bool,
    pub supports_quota_query: bool,
    pub supports_usage_query: bool,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
```

### TypeScript 定义

```typescript
type ChannelPreset = {
  id: string;
  name: string;
  vendor: string;
  supported_protocols: ProtocolType[];
  openai_base_url: string;
  anthropic_base_url: string;
  default_model: string;
  supports_model_list: boolean;
  supports_model_detail: boolean;
  supports_price_sync: boolean;
  supports_balance_query: boolean;
  supports_quota_query: boolean;
  supports_usage_query: boolean;
  notes?: string;
  created_at: string;
  updated_at: string;
};
```

### SQLite Schema

```sql
CREATE TABLE channel_presets (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    vendor          TEXT NOT NULL,
    supported_protocols TEXT NOT NULL,           -- JSON 数组 ["openai","anthropic"]
    openai_base_url TEXT NOT NULL,
    anthropic_base_url TEXT NOT NULL,
    default_model   TEXT NOT NULL,
    supports_model_list    INTEGER NOT NULL DEFAULT 0,
    supports_model_detail  INTEGER NOT NULL DEFAULT 0,
    supports_price_sync    INTEGER NOT NULL DEFAULT 0,
    supports_balance_query INTEGER NOT NULL DEFAULT 0,
    supports_quota_query   INTEGER NOT NULL DEFAULT 0,
    supports_usage_query   INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
```

> 尽管文档中有 `notes` 字段，第一版最小表集合不含 `notes`；UI 不需要展示。

---

## 4. ChannelAccount

### Rust 定义

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelAccount {
    pub id: String,
    pub channel_id: String,
    pub name: String,
    pub api_key: String,
    pub enabled: bool,
    pub priority: i64,
    pub remark: Option<String>,
    pub last_used_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
```

### TypeScript 定义

```typescript
type ChannelAccount = {
  id: string;
  channel_id: string;
  name: string;
  api_key: string;
  enabled: boolean;
  priority: number;
  remark?: string;
  last_used_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
};
```

### SQLite Schema

```sql
CREATE TABLE channel_accounts (
    id           TEXT PRIMARY KEY,
    channel_id   TEXT NOT NULL,
    name         TEXT NOT NULL,
    api_key      TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    priority     INTEGER NOT NULL DEFAULT 0,
    remark       TEXT,
    last_used_at TEXT,
    last_error   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
```

---

## 5. ChannelModel

### Rust 定义

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelModel {
    pub id: String,
    pub channel_id: String,
    pub model: String,
    pub display_name: Option<String>,
    pub supported_protocols: Vec<ProtocolType>,
    pub context_window: Option<i64>,
    pub max_output_tokens: Option<i64>,
    pub supports_stream: bool,
    pub enabled: bool,
    pub source: String,
    pub synced_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
```

### TypeScript 定义

```typescript
type ChannelModel = {
  id: string;
  channel_id: string;
  model: string;
  display_name?: string;
  supported_protocols: ProtocolType[];
  context_window?: number;
  max_output_tokens?: number;
  supports_stream: boolean;
  enabled: boolean;
  source: string;
  synced_at?: string;
  created_at: string;
  updated_at: string;
};
```

### SQLite Schema

```sql
CREATE TABLE channel_models (
    id                   TEXT PRIMARY KEY,
    channel_id           TEXT NOT NULL,
    model                TEXT NOT NULL,
    display_name         TEXT,
    supported_protocols  TEXT NOT NULL,
    context_window       INTEGER,
    max_output_tokens    INTEGER,
    supports_stream      INTEGER NOT NULL DEFAULT 1,
    enabled              INTEGER NOT NULL DEFAULT 1,
    source               TEXT NOT NULL DEFAULT 'preset',
    synced_at            TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);
```

---

## 6. ClientConfig（请求客户端）

### Rust 定义

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientConfig {
    pub id: String,
    pub name: String,
    pub token: String,
    pub app_type: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}
```

### TypeScript 定义

```typescript
type ClientConfig = {
  id: string;
  name: string;
  token: string;
  app_type: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};
```

### SQLite Schema

```sql
CREATE TABLE clients (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    token      TEXT NOT NULL,
    app_type   TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

---

## 7. VirtualModel（虚拟模型）

### Rust 定义

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VirtualModel {
    pub id: String,
    pub name: String,
    pub protocol_type: ProtocolType,
    pub routing_strategy: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}
```

### TypeScript 定义

```typescript
type VirtualModel = {
  id: string;
  name: string;
  protocol_type: ProtocolType;
  routing_strategy: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};
```

### SQLite Schema

```sql
CREATE TABLE virtual_models (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,
    protocol_type    TEXT NOT NULL,
    routing_strategy TEXT NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
```

---

## 8. RouteCandidate（路由候选）

> **核心重构点**：旧版 `VirtualModelRoute` 仅含 `virtual_model / provider_name / upstream_model`，新版改为四元组 `virtual_model_id + channel_id + account_id + upstream_model`。这是多账号透明替换的核心。

### Rust 定义

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteCandidate {
    pub id: String,
    pub virtual_model_id: String,
    pub channel_id: String,
    pub account_id: String,
    pub upstream_model: String,
    pub client_protocol: ProtocolType,
    pub priority: i64,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}
```

### TypeScript 定义

```typescript
type RouteCandidate = {
  id: string;
  virtual_model_id: string;
  channel_id: string;
  account_id: string;
  upstream_model: string;
  client_protocol: ProtocolType;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};
```

### SQLite Schema

```sql
CREATE TABLE virtual_model_routes (
    id               TEXT PRIMARY KEY,
    virtual_model_id TEXT NOT NULL,
    channel_id       TEXT NOT NULL,
    account_id       TEXT NOT NULL,
    upstream_model   TEXT NOT NULL,
    client_protocol  TEXT NOT NULL,
    priority         INTEGER NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
```

---

## 9. ModelPrice（三段价格）

### Rust 定义

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPrice {
    pub id: String,
    pub channel_id: String,
    pub upstream_model: String,
    pub input_uncached_price: f64,
    pub input_cached_price: f64,
    pub output_price: f64,
    pub currency: String,
    pub unit: String,
    pub source: PriceSource,
    pub synced_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
```

### TypeScript 定义

```typescript
type ModelPrice = {
  id: string;
  channel_id: string;
  upstream_model: string;
  input_uncached_price: number;
  input_cached_price: number;
  output_price: number;
  currency: string;
  unit: string;
  source: PriceSource;
  synced_at?: string;
  created_at: string;
  updated_at: string;
};
```

### SQLite Schema

```sql
CREATE TABLE model_prices (
    id                    TEXT PRIMARY KEY,
    channel_id            TEXT NOT NULL,
    upstream_model        TEXT NOT NULL,
    input_uncached_price  REAL NOT NULL DEFAULT 0,
    input_cached_price    REAL NOT NULL DEFAULT 0,
    output_price          REAL NOT NULL DEFAULT 0,
    currency              TEXT NOT NULL,
    unit                  TEXT NOT NULL,
    source                TEXT NOT NULL DEFAULT 'preset',
    synced_at             TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);
```

---

## 10. AccountBalanceSnapshot（余额/资源包快照）

### Rust 定义

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountBalanceSnapshot {
    pub id: String,
    pub account_id: String,
    pub balance: Option<f64>,
    pub currency: Option<String>,
    pub token_pack_total: Option<i64>,
    pub token_pack_used: Option<i64>,
    pub token_pack_remaining: Option<i64>,
    pub token_pack_expire_at: Option<String>,
    pub source: String,
    pub synced_at: Option<String>,
    pub remark: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
```

### TypeScript 定义

```typescript
type AccountBalanceSnapshot = {
  id: string;
  account_id: string;
  balance?: number;
  currency?: string;
  token_pack_total?: number;
  token_pack_used?: number;
  token_pack_remaining?: number;
  token_pack_expire_at?: string;
  source: string;
  synced_at?: string;
  remark?: string;
  created_at: string;
  updated_at: string;
};
```

### SQLite Schema

```sql
CREATE TABLE account_balance_snapshots (
    id                   TEXT PRIMARY KEY,
    account_id           TEXT NOT NULL,
    balance              REAL,
    currency             TEXT,
    token_pack_total     INTEGER,
    token_pack_used      INTEGER,
    token_pack_remaining INTEGER,
    token_pack_expire_at TEXT,
    source               TEXT NOT NULL,
    synced_at            TEXT,
    remark               TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);
```

---

## 11. RequestLogMetadata（请求日志）

> **核心重构点**：旧版用 `provider_id` 单字段，新版拆为 `client_protocol + upstream_protocol + channel_id + account_id + public_model + virtual_model`。

### Rust 定义

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLogRow {
    pub id: String,
    pub request_id: String,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub client_protocol: String,
    pub upstream_protocol: String,
    pub virtual_model: Option<String>,
    pub public_model: Option<String>,
    pub upstream_model: Option<String>,
    pub method: String,
    pub path: String,
    pub status: Option<i64>,
    pub latency_ms: Option<i64>,
    pub is_stream: bool,
    pub error_message: Option<String>,
    pub fallback_count: i64,
    pub route_reason: Option<String>,
    pub created_at: String,
}
```

### TypeScript 定义

```typescript
type RequestLogRow = {
  id: string;
  request_id: string;
  client_id?: string;
  client_name?: string;
  channel_id?: string;
  channel_name?: string;
  account_id?: string;
  account_name?: string;
  client_protocol: string;
  upstream_protocol: string;
  virtual_model?: string;
  public_model?: string;
  upstream_model?: string;
  method: string;
  path: string;
  status?: number;
  latency_ms?: number;
  is_stream: boolean;
  error_message?: string;
  fallback_count: number;
  route_reason?: string;
  created_at: string;
};
```

### SQLite Schema

```sql
CREATE TABLE request_logs (
    id                TEXT PRIMARY KEY,
    request_id        TEXT NOT NULL,
    client_id         TEXT,
    channel_id        TEXT,
    account_id        TEXT,
    client_protocol   TEXT NOT NULL,
    upstream_protocol TEXT NOT NULL,
    virtual_model     TEXT,
    public_model      TEXT,
    upstream_model    TEXT,
    method            TEXT NOT NULL,
    path              TEXT NOT NULL,
    status            INTEGER,
    latency_ms        INTEGER,
    is_stream         INTEGER NOT NULL DEFAULT 0,
    error_message     TEXT,
    fallback_count    INTEGER NOT NULL DEFAULT 0,
    route_reason      TEXT,
    created_at        TEXT NOT NULL
);
```

---

## 12. UsageRecord（用量记录）

### Rust 定义

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageRecordRow {
    pub id: String,
    pub request_id: String,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub client_protocol: String,
    pub upstream_protocol: String,
    pub virtual_model: Option<String>,
    pub upstream_model: Option<String>,
    pub input_tokens: Option<i64>,
    pub input_cached_tokens: Option<i64>,
    pub input_uncached_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub estimated_cost: Option<f64>,
    pub analyzed_at: Option<String>,
    pub created_at: String,
}
```

### TypeScript 定义

```typescript
type UsageRecordRow = {
  id: string;
  request_id: string;
  client_id?: string;
  client_name?: string;
  channel_id?: string;
  channel_name?: string;
  account_id?: string;
  account_name?: string;
  client_protocol: string;
  upstream_protocol: string;
  virtual_model?: string;
  upstream_model?: string;
  input_tokens?: number;
  input_cached_tokens?: number;
  input_uncached_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  estimated_cost?: number;
  analyzed_at?: string;
  created_at: string;
};
```

### SQLite Schema

```sql
CREATE TABLE usage_records (
    id                    TEXT PRIMARY KEY,
    request_id            TEXT NOT NULL,
    client_id             TEXT,
    channel_id            TEXT,
    account_id            TEXT,
    client_protocol       TEXT NOT NULL,
    upstream_protocol     TEXT NOT NULL,
    virtual_model         TEXT,
    upstream_model        TEXT,
    input_tokens          INTEGER,
    input_cached_tokens   INTEGER,
    input_uncached_tokens INTEGER,
    output_tokens         INTEGER,
    total_tokens          INTEGER,
    estimated_cost        REAL,
    analyzed_at           TEXT,
    created_at            TEXT NOT NULL
);
```

---

## 13. 版本信息表（新增）

用于未来 schema 升级 / 应用版本追踪。

### SQLite Schema

```sql
CREATE TABLE app_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

启动时校验 `schema_version`，若不存在则视为全新库并写入当前版本号 `2026.07.01`。

---

## 14. 完整建表 SQL

```sql
-- 渠道模板
CREATE TABLE channel_presets (...);

-- 渠道账号
CREATE TABLE channel_accounts (...);

-- 渠道模型
CREATE TABLE channel_models (...);

-- 客户端来源
CREATE TABLE clients (...);

-- 虚拟模型
CREATE TABLE virtual_models (...);

-- 路由候选
CREATE TABLE virtual_model_routes (...);

-- 模型价格（三段）
CREATE TABLE model_prices (...);

-- 余额/资源包快照
CREATE TABLE account_balance_snapshots (...);

-- 请求日志
CREATE TABLE request_logs (...);

-- 用量记录
CREATE TABLE usage_records (...);

-- 应用元信息
CREATE TABLE app_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

---

## 15. SQLite 启用 WAL

重构启动 SQLite 连接时必须执行：

```sql
PRAGMA journal_mode = WAL;
```

确保读写并发能力。

---

## 16. JSON 数组存储规范

由于 SQLite 不支持数组类型，以下字段使用 JSON TEXT 存储：

| 字段 | 表 | 示例 |
|------|----|------|
| `supported_protocols` | `channel_presets` | `'["openai","anthropic"]'` |
| `supported_protocols` | `channel_models` | `'["openai"]'` |

读取时用 `serde_json::from_str::<Vec<ProtocolType>>(raw).unwrap_or_default()` 反序列化。

写入时用 `serde_json::to_vec(value).unwrap()` 序列化。

---

## 17. 删除的旧结构

以下内容在第一版中彻底删除：

| 旧结构 | 位置 |
|--------|------|
| `ProviderConfig`（单 Provider） | `config.rs` |
| `ModelPrice`（input_price/output_price 二段） | `config.rs` |
| `providers` 表 | `storage.rs` |
| `provider_id = "default"` 逻辑 | `proxy.rs` / `storage.rs` |
| 旧 `virtual_model_routes` 含 `provider_name` | `config.rs` / `storage.rs` |
| 旧二段 `model_prices` | `storage.rs` |
| 旧 `AppState { provider, ... }` 单 Provider | `lib.rs` |
| 旧 Provider 管理 UI | `main.tsx` |

---

## 18. 实现顺序

1. **Step 1**：`config.rs` 全部替换为新结构
2. **Step 2**：`storage.rs` 迁移 + 新表 CRUD
3. **Step 3**：`proxy.rs` 按新 RouteCandidate 路由
4. **Step 4**：`lib.rs` 更新 Tauri 命令注册
5. **Step 5**：`main.tsx` 更新 UI 类型 + 调用
6. **Step 6**：单元测试补充
7. **Step 7**：`bun run check` + `cargo test` + `cargo fmt`

每步完成后运行 `cargo check` 确认编译通过。
