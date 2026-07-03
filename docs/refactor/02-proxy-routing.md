# 代理路由重构详细规格

> 本文档定义 Flowlet 破坏式重构后代理层（proxy.rs）的路由逻辑、协议入口、请求转发、fallback 规则和日志旁路。

---

## 1. 协议入口

### 路由表

```rust
let app = Router::new()
    .route("/health", get(health))
    .route("/v1/{*path}", any(forward_openai_compatible))
    .route("/openai/v1/{*path}", any(forward_openai_compatible))
    .route("/anthropic/v1/{*path}", any(forward_anthropic_compatible));
```

### 路径识别

```rust
fn classify_protocol(path: &str) -> Option<ProtocolType> {
    let p = path.trim_start_matches('/');
    if p.starts_with("anthropic/") {
        Some(ProtocolType::Anthropic)
    } else if p.starts_with("v1/") || p.starts_with("openai/") {
        Some(ProtocolType::OpenAi)
    } else {
        None
    }
}
```

---

## 2. 请求转发主流程

```
Client Request
    ↓
1. 识别协议类型（OpenAI / Anthropic）
2. 提取 Client Token（Authorization Bearer 或 X-Api-Key）
3. 查找 Client ID
4. 提取请求体中的 model 字段
5. 查找匹配的 VirtualModel
6. 获取 RouteCandidate 列表（按 priority 排序）
7. 遍历候选：
   a. 替换 model 为 upstream_model
   b. 替换 Authorization 为 account.api_key
   c. 拼接 upstream base_url
   d. 发送请求
   e. 判断是否 fallback
8. 返回最终响应
```

---

## 3. 路由候选匹配

### 匹配条件

```rust
fn match_candidates(
    candidates: &[RouteCandidate],
    virtual_model: &str,
    protocol: ProtocolType,
) -> Vec<RouteCandidate> {
    let mut matched: Vec<_> = candidates
        .iter()
        .filter(|c| {
            c.enabled
                && c.virtual_model_id == virtual_model
                && c.client_protocol == protocol
        })
        .cloned()
        .collect();
    matched.sort_by_key(|c| (c.priority, c.id.clone()));
    matched
}
```

### 直接模型请求（非虚拟模型）

如果请求体中的 model 不是虚拟模型，则直接查找匹配的 channel_model，构造一个临时 RouteCandidate：

```rust
fn resolve_direct_model(
    model: &str,
    protocol: ProtocolType,
    channels: &[ChannelPreset],
    accounts: &[ChannelAccount],
) -> Option<RouteCandidate> {
    // 1. 查找 channel_model 匹配 model + protocol
    // 2. 找到 channel_id
    // 3. 查找该 channel 下第一个 enabled 的 account（按 priority）
    // 4. 构造临时 RouteCandidate
    ...
}
```

---

## 4. 上游 URL 拼接

### OpenAI-compatible

```rust
fn build_openai_url(base_url: &str, original_path: &str) -> String {
    let base = base_url.trim_end_matches('/');
    // original_path 形如 "/v1/chat/completions"
    // 需要去掉 /v1 前缀，保留 /chat/completions
    let path = original_path
        .trim_start_matches("/v1")
        .trim_start_matches("/openai/v1");
    format!("{base}{path}")
}
```

### Anthropic-compatible

```rust
fn build_anthropic_url(base_url: &str, original_path: &str) -> String {
    let base = base_url.trim_end_matches('/');
    // original_path 形如 "/anthropic/v1/messages"
    // 需要去掉 /anthropic 前缀，保留 /v1/messages
    let path = original_path.trim_start_matches("/anthropic");
    format!("{base}{path}")
}
```

---

## 5. Header 替换

### 请求侧

```rust
fn apply_request_headers(
    mut builder: reqwest::RequestBuilder,
    headers: &HeaderMap,
    api_key: &str,
    protocol: ProtocolType,
) -> reqwest::RequestBuilder {
    // 1. 过滤 hop-by-hop headers
    for (name, value) in headers {
        if is_hop_by_hop(name.as_str()) || name == header::HOST {
            continue;
        }
        // 跳过原始 Authorization 和 X-Api-Key
        if name == header::AUTHORIZATION || name == "x-api-key" {
            continue;
        }
        builder = builder.header(name, value);
    }

    // 2. 注入上游认证
    if !api_key.trim().is_empty() {
        match protocol {
            ProtocolType::OpenAi => {
                builder = builder.bearer_auth(api_key.trim());
            }
            ProtocolType::Anthropic => {
                builder = builder.header("x-api-key", api_key.trim());
            }
        }
    }

    builder
}
```

### 响应侧

```rust
fn copy_response_headers(source: &HeaderMap, target: &mut HeaderMap) {
    for (name, value) in source {
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        target.append(name, value.clone());
    }
}
```

---

## 6. Fallback 规则

### 通用可 fallback

- 429 Too Many Requests
- 500 Internal Server Error
- 502 Bad Gateway
- 503 Service Unavailable
- 网络错误（reqwest::Error）
- 超时

### 通用不 fallback

- 400 Bad Request
- 401 Unauthorized
- 422 Unprocessable Entity
- 413 Payload Too Large

### DeepSeek 特化

- **可 fallback**：402 Payment Required（余额不足）
- **不 fallback**：401（API Key 错误）

### 实现

```rust
fn should_try_next_status(status: StatusCode, channel_vendor: &str) -> bool {
    if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
        return true;
    }
    // DeepSeek 402 余额不足
    if channel_vendor == "deepseek" && status == StatusCode::PAYMENT_REQUIRED {
        return true;
    }
    false
}
```

### 额度不足 body 检测

```rust
fn body_contains_quota_exceeded(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body).to_ascii_lowercase();
    text.contains("quota exceeded")
        || text.contains("insufficient quota")
        || text.contains("exceeded your current quota")
        || text.contains("billing quota")
        || text.contains("balance insufficient")
}
```

---

## 7. 日志旁路

### 写入时机

- 每个候选尝试后立即写入 metadata（无论成功失败）
- 最终成功/失败响应写入完整 metadata

### 旁路失败处理

```rust
fn record_request_log(storage: Storage, log: RequestLogRow) {
    async_runtime::spawn_blocking(move || {
        if let Err(err) = storage.insert_request_log(&log) {
            tracing::warn!("写入请求日志失败: {err}");
        }
    });
}
```

### 日志字段

```rust
RequestLogRow {
    id: uuid::Uuid::new_v4().to_string(),
    request_id,
    client_id,
    client_name,
    channel_id,
    channel_name,
    account_id,
    account_name,
    client_protocol: protocol.as_str().to_string(),
    upstream_protocol: protocol.as_str().to_string(),
    virtual_model,
    public_model,
    upstream_model,
    method,
    path,
    status: Some(status.as_u16() as i64),
    latency_ms: Some(elapsed.as_millis() as i64),
    is_stream,
    error_message: None,
    fallback_count,
    route_reason,
    created_at: chrono::Utc::now().to_rfc3339(),
}
```

---

## 8. 响应透传

### 普通 JSON 响应

```rust
async fn build_buffered_response(
    state: ProxyAppState,
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
    log: RequestLogRow,
) -> Result<Response, reqwest::Error> {
    // 1. 旁路提取 usage（最多 1MB）
    // 2. 写入日志
    // 3. 返回原始 body
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    copy_response_headers(&headers, response.headers_mut());
    Ok(response)
}
```

### 流式响应（SSE）

```rust
async fn build_streaming_response(
    state: ProxyAppState,
    status: StatusCode,
    headers: HeaderMap,
    stream: impl Stream<Item = Result<Bytes, reqwest::Error>>,
    log: RequestLogRow,
) -> Response {
    // 1. 不解析、不缓存
    // 2. 旁路复制到日志 buffer（可选）
    // 3. 直接透传
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    copy_response_headers(&headers, response.headers_mut());
    response
}
```

---

## 9. 错误处理

### 所有候选都失败

```rust
// 返回最后一个错误
Err(last_error.expect("至少应有一个路由候选"))
```

### 无匹配候选

```rust
// 返回 404
(StatusCode::NOT_FOUND, "no matching route candidate")
```

### 上游超时

```rust
// 记录错误，尝试下一个候选
if err.is_timeout() {
    route_reason = "timeout";
}
```

---

## 10. 性能约束

- 代理层不解析请求体语义（仅提取 model 字段）
- 流式响应不缓存完整 body
- 日志写入使用 `spawn_blocking` 不阻塞主链路
- 单次请求最大旁路复制 1MB 响应体用于 usage 提取

---

## 11. 测试用例

### 单元测试

1. `classify_protocol_identifies_anthropic_paths`
2. `classify_protocol_identifies_openai_paths`
3. `match_candidates_filters_by_protocol_and_virtual_model`
4. `match_candidates_sorts_by_priority`
5. `apply_request_headers_replaces_authorization_for_openai`
6. `apply_request_headers_replaces_x_api_key_for_anthropic`
7. `should_try_next_status_handles_deepseek_402`
8. `build_openai_url_strips_v1_prefix`
9. `build_anthropic_url_strips_anthropic_prefix`

### 集成测试

1. `forwards_openai_request_to_longcat`
2. `forwards_anthropic_request_to_longcat`
3. `falls_back_on_429`
4. `does_not_fall_back_on_400`
5. `streaming_response_passes_through_unchanged`
