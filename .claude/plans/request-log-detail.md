# Plan: Request Log Detail Page + Fix Latency Measurement

## Summary

User requirements, restated:
1. **Latency fix**: `latency_ms` was captured before the upstream send (`started_at.elapsed()` at `proxy.rs:444`); must measure ① request start → ② upstream `ttfb_ms` (headers received) → ③ `duration_ms` (body fully streamed). The list "耗时" column must reflect true end-to-end duration.
2. **Log detail page**: Add click-to-expand detail for each log row/attempt group with 基础信息 / 请求详情 / 响应详情.
3. **Sanitization + capture toggle**: header redaction (Authorization / x-api-key), optional request/response body capture with size cap (max 1 MB).

---

## Scope of change

Files we **will** touch (per sub-task below):

- `src-tauri/src/core/storage.rs` — add columns to `request_logs`, migration
- `src-tauri/src/core/storage_usage.rs` — update INSERT / SELECT, new `get_request_log_detail` query
- `src-tauri/src/core/config.rs` — add fields to `RequestLogRow` + `RequestLogInput`
- `src-tauri/src/core/proxy.rs` — fix timing, capture headers/bodies, new command
- `src-tauri/src/core/proxy_routing.rs` — (re-export helpers if needed)
- `src-tauri/src/core/proxy_http.rs` — add header-sanitizing helpers
- `src-tauri/src/commands.rs` + `src-tauri/src/lib.rs` — add `get_request_log_detail` command
- `src/domain.ts` — extend `RequestLogRow` type
- `src/pages/LogsPage.tsx` → split into `LogsPage.tsx` (list + group toggle) + `LogDetailDrawer.tsx` (detail panel)
- `src/app/App.tsx` + `src/app/useFlowletData.ts` + `src/app/actions/usageActions.ts` — wire new data
- `src/styles/ui.css` — drawer/detail styling

---

## 1. Timing fix (backend — `proxy.rs`)

### 1a. New timestamps in the request loop

In `forward_request` (around line 396 candidate loop and the buffered fallback loop) add:
- `start = Instant::now()` already exists at line 289. **Move from context constructor to per-attempt:** each candidate attempt gets its own start time to avoid concatenated timings across fallbacks.
- After `send().await`, immediately capture `ttfb = start.elapsed()` once `build_response` / `build_buffered_response` returns headers.
- **Buffered path** (`build_buffered_response`): after `bytes().await`, capture `duration = start.elapsed()`. Easy, single chunk.
- **Streaming path** (`build_response`): the `duration` cannot be known until the body stream ends *after* the response is returned to the client. Wrap the body stream via a small `TimedBytesStream` that fires a callback (one-shot channel) when the stream terminates:
  - When the first byte crosses → `ttfb_ms`
  - When stream ends or errors → final `duration_ms`

Implementation: add a tiny struct `TimedStream { inner: BytesStream, on_first: Option<oneshot<()>>, on_done: Option<oneshot<()>> }` and `impl Stream for TimedStream` that forwards items, firing `on_first` on first `Some(Ok(bytes))` and `on_done` on `None`. Wire it into `build_response` after `upstream_response.bytes_stream()`, then read the channel.

### 1b. New RouteLogContext fields

Add to `RouteLogContext`:
```
ttfb_ms_start: Instant,         // per-attempt send start
is_stream: bool,                // so caller knows which timing path to use
```
Don't store derived ms until after we have headers/body.

### 1c. Builder helpers (new module-level fns in `proxy.rs`)

```
fn record_response_timing(storage, request_id, ttfb_ms, duration_ms)
```
uses `UPDATE request_logs SET ttfb_ms = ?, duration_ms = ? WHERE request_id = ? AND id = ?` so streaming responses can be updated after the fact.

### 1d. Where each timing is captured

| Path | ttfb_ms | duration_ms |
| --- | --- | --- |
| `no_route` short-circuit | elapsed from `start` | same |
| retryable_status fallback | attempt elapsed (before send) | same |
| quota_exceeded fallback | attempt elapsed (before send) | same |
| network_error fallback | none (null) | attempt elapsed |
| final network error | none (null) | attempt elapsed |
| buffered response (2xx normal) | after `send` | after `bytes().await` |
| buffered response (quota retry exhausted) | after `send` | after `bytes().await` |
| streaming response | first byte via stream wrapper | end-of-stream via stream wrapper |

### 1e. `to_log_input` signature change

Add `ttfb_ms`, `duration_ms`, `status_code`, `attempt_seq` parameters; keep `latency_ms` derived for old schema compat (writes both for a grace period). After migration is in place the old column becomes redundant, but we keep writing it for one release to avoid breaking old installs.

---

## 2. Schema migration (storage.rs + storage_usage.rs)

New `request_logs` columns (idempotent via `add_column_if_missing`):

```sql
ttfb_ms           INTEGER,
duration_ms       INTEGER,
status_code       INTEGER,           -- final observable HTTP status
attempt_seq       INTEGER NOT NULL DEFAULT 0, -- 0-based within request_id group
req_headers_json  TEXT,              -- redacted
req_body_b64      TEXT,              -- base64, optional (capture off → NULL)
res_headers_json  TEXT,              -- includes content-type
res_body_b64      TEXT,              -- base64, optional (streaming/uncollected → NULL)
stream_summary    TEXT,              -- for captured streams: first/last SSE line + line count
is_last_attempt   INTEGER NOT NULL DEFAULT 1  -- 1 = final row shown by default in list
```

SQL migration lives in `migrate()` after the `app_meta` table, using `add_column_if_missing` (already exists for schema evolution).

`list_request_logs` keeps returning all the existing columns (so old clients don't break) plus the new ones, with `WHERE is_last_attempt = 1` to hide intermediate fallback rows from the summary list. Adds `ORDER BY created_at DESC`.

New query: `list_request_logs_by_request_id(request_id) → Vec<RequestLogRow>` for the detail open.

---

## 3. Request/Response body capture (proxy.rs + new helpers)

### 3a. Capture flags (read once at proxy startup, stored on `ProxyAppState`)

```rust
struct LogCaptureConfig {
    capture_request_headers: bool,
    capture_request_body: bool,     // bounded by max_body_bytes
    capture_response_headers: bool,
    capture_response_body: bool,    // bounded; streaming only collects up to first N bytes
    max_body_bytes: usize,          // default 1MB, user-settable
    redact_header_keys: HashSet<&'static str>,  // ["authorization","x-api-key","cookie","set-cookie","x-auth-token"]
}
```

Pass through `ProxyStartupConfig` and `ProxyAppState` just like `storage` already is. Default config (until UI ships): headers captured, request body captured to 64 KB, response body captured to 64 KB for non-streaming, streaming capped to first 16 KB + summary.

### 3b. Redaction helper in `proxy_http.rs`

```rust
pub fn sanitize_headers(headers: &HeaderMap, redact: &HashSet<&str>) -> serde_json::Value
```
Returns a JSON object of non-redacted keys. Redacted keys appear as `"[redacted]"`.

### 3c. Body capture

On each routed request: clone `body_bytes` (already in scope), truncate to `max_body_bytes`, base64-encode (`base64` crate, add to `Cargo.toml`), store in `req_body_b64` column.

For response (non-streamed): `bytes.truncate(max_bytes)`, base64.

For streamed responses: the `TimedBytesStream` wrapper collects up to `max_bytes` of body for capture (separate from what's proxied), and produces a textual summary (first + last data: line for SSE).

### 3d. New `base64` crate dep

Add `base64 = "0.22"` to `Cargo.toml`.

---

## 4. Add `get_request_log_detail` command

New in `commands.rs`:
```rust
#[tauri::command]
pub(super) fn get_request_log_detail(
    state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<Vec<RequestLogRow>, String>
```
Calls `storage.list_request_logs_by_request_id(request_id)`. Registered in `lib.rs` invoke handler.

---

## 5. Frontend types (`src/domain.ts`)

Extend `RequestLogRow`:
```ts
ttfb_ms: number | null;
duration_ms: number | null;
status_code: number | null;
attempt_seq: number;
req_headers_json: string | null;
req_body_b64: string | null;
res_headers_json: string | null;
res_body_b64: string | null;
stream_summary: string | null;
is_last_attempt: boolean;
```

Keep `latency_ms` for backwards compat — front-end list will show `duration_ms ?? latency_ms ?? "-"`.

---

## 6. Frontend Log Detail Drawer (`src/pages/LogDetailDrawer.tsx` + `LogsPage.tsx`)

### 6a. `LogsPage.tsx` changes

- Each row gains a "详情" `link-button`.
- Clicking sets `selectedRequestId` local state.
- Page renders `<LogDetailDrawer requestId={selectedRequestId} onClose={...} />` when set.

### 6b. `LogDetailDrawer.tsx`

Layout (CSS grid, 2 columns inside a right-slide `.detail-drawer`):

**基础信息 block** (from first row = attempt 0):
- request_id / 时间 / 客户端 / 协议 / 对外模型 / 上游模型 / 状态码 / ttfb_ms / duration_ms / fallback_count / route_reason

**Attempts panel** (only when fallback_count > 0):
- collapsible list of attempts keyed by `attempt_seq`, each showing channel / account / status / duration / error.

**请求详情 block**:
- Method / Path
- Headers (render JSON from `req_headers_json` with syntax highlighting via `<pre>`)
- Body: decode `req_body_b64`, try `JSON.parse` + pretty JSON, fallback to raw text. Show KB size, truncation note if applicable.

**响应详情 block**:
- Headers JSON
- Body: same decode logic. If `stream_summary` is set → render a separate collapsible "流式摘要" box with the first/last SSE lines.

### 6c. CSS additions in `ui.css`

`.detail-drawer` — fixed right, 60% width, slide-in transition, backdrop overlay.
`.kv-grid` — 2-col label/value layout for 基础信息.
`.code-block` — pre-wrap + scroll for headers/json bodies.
`.attempt-row`, `.section-title`, `.muted`, `.chip-stream`.

---

## 7. Settings toggle (`src/pages/StatsPage.tsx`)

Add a "日志记录" panel at the top of StatsPage (since this view already hosts "统计数据" / future controls):

Toggles:
- [x] 记录请求 Headers
- [x] 记录请求 Body（上限: `maxBodyKB` KB）
- [x] 记录响应 Headers
- [x] 记录响应 Body（上限: `maxBodyKB` KB）

Persists via `app_meta` (existing `get_app_meta` pattern). Command: `set_log_capture_config` and `get_log_capture_config`. At proxy startup, read config; restart-proxy button after change to reload capture state.

---

## 8. Verification

1. `cargo build -p flowlet_lib` — clean compile with new schema and helpers.
2. `npm run tauri dev` — start app → fire a chat via curl against `127.0.0.1:18640`:
   - Non-streaming: response should show `duration_ms > 0`, `ttfb_ms > 0`, body in detail.
   - Streaming: `stream_summary` shows data lines; `duration_ms` filled in after stream ends.
3. Force a fallback (e.g. point at wrong key for first candidate, valid second): list shows 1 row with `is_last_attempt=1`; detail drawer shows both attempt rows.
4. Change "记录响应 Body" off → restart proxy → fire request → detail shows `— (未捕获)` for body.
5. Header redaction: with `Authorization: Bearer xxx` sent, detail shows `"authorization": "[redacted]"`.

---

## 9. Order of work

1. Add `base64` crate dep.
2. Storage migration + new query in `storage.rs` / `storage_usage.rs`.
3. Extend `RequestLogRow` + `RequestLogInput` in `config.rs`.
4. Timing fix in `proxy.rs` (bulk of logic).
5. Helpers in `proxy_http.rs`.
6. New command + lib.rs registration.
7. Frontend types (`domain.ts`).
8. LogDetailDrawer + LogsPage refactor + CSS.
9. StatsPage settings toggles.
10. Verification (build + live tests above).
