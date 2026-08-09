//! 后台 webview 控制台抓取的核心逻辑:窗口构建、导航、拦截响应缓冲、
//! eval 执行 extractor、登录检测。
//!
//! 设计要点:
//! - 窗口由 Rust command 创建，在 document-start 注入 interceptor_js。
//! - 拦截响应由页面 JS 通过 IPC(handle_intercepted_response)回传,暂存到 AppState.scrape_pending。
//! - interceptor 安装完成后通过 IPC(handle_scrape_interceptor_ready)回传页面标识；
//!   command 必须等 ready 后再计算业务响应超时，避免把页面尚未初始化误判成未登录。
//! - 收齐后 Rust 侧 eval_with_callback 执行 extractor_js,拿到结构化结果。

use crate::core::channels_config::ChannelsConfig;
use std::collections::HashMap;
#[cfg(any(windows, target_os = "linux"))]
use std::sync::{Arc, Mutex};

/// 单个抓取模式的运行时配置(从 ChannelsConfig 解析后传入)。
#[derive(Debug, Clone)]
pub struct ScrapeModeRuntime {
    pub console_url: String,
    /// 可选的第二次导航 URL。多阶段抓取时,主 URL 捕获完成后导航到此 URL。
    pub console_url_secondary: Option<String>,
    /// 可选的第三次导航 URL。三阶段抓取时,第二 URL 捕获完成后导航到此 URL。
    pub console_url_tertiary: Option<String>,
    pub interceptor_js: String,
    pub extractor_js: String,
    pub aggregate: bool,
    /// 聚合模式要求的响应槽位列表,全部到位才视为捕获完成。
    pub required_slots: Vec<String>,
}

/// document-start 拦截器完成安装后的页面标识。
#[derive(Debug, Clone)]
pub struct ScrapeInterceptorReady {
    pub document_id: String,
    pub page_url: String,
}

/// 根据账号的 resource_mode / 渠道,解析出本次抓取的模式配置。
/// LongCat 统一走 hybrid 模式(同时抓取 token 资源包与按量余额),不再按
/// resource_mode 区分 token_pack / pay_as_you_go。
/// Qwen 仅 Token Plan 订阅账号使用控制台抓取；API 按量付费账号没有官方
/// 余额接口也没有可用的抓取模式，走手动维护，不参与自动同步。
pub fn resolve_scrape_mode(
    channels_config: &ChannelsConfig,
    channel_id: &str,
    resource_mode: Option<&str>,
) -> Option<ScrapeModeRuntime> {
    let mode_key = match channel_id {
        "longcat" => "hybrid",
        "qwen" if resource_mode == Some("token_plan") => "token_plan",
        _ => return None,
    };
    let cfg = channels_config.scrape_config(channel_id, mode_key)?;
    Some(ScrapeModeRuntime {
        console_url: cfg.console_url.clone(),
        console_url_secondary: cfg.console_url_secondary.clone(),
        console_url_tertiary: cfg.console_url_tertiary.clone(),
        interceptor_js: cfg.interceptor_js.clone(),
        extractor_js: cfg.extractor_js.clone(),
        aggregate: cfg.aggregate,
        required_slots: cfg.required_slots.clone(),
    })
}

/// 构建 per-account 后台抓取 webview(隐藏)。
/// 每个账号使用独立的 data_directory,从而拥有完全隔离的 cookie / localStorage /
/// 缓存与登录态。多个抓取窗口共享默认 EBWebView 目录时,后一个窗口会继承前一个
/// 窗口的登录态,导致自动刷新读到错误账号的余额。
pub fn build_scrape_webview(
    app: &tauri::AppHandle,
    account_id: &str,
    channel_id: &str,
    mode: &ScrapeModeRuntime,
) -> Result<tauri::WebviewWindow, String> {
    let label = format!("scrape-{account_id}");
    let url = tauri::WebviewUrl::External(
        mode.console_url
            .parse()
            .map_err(|e| format!("抓取控制台 URL 解析失败: {e}"))?,
    );
    let channel_id_json = serde_json::to_string(channel_id)
        .map_err(|error| format!("序列化抓取渠道失败: {error}"))?;
    // initialization_script 在新 document 的页面业务脚本之前运行。配置中的拦截器
    // 安装完 fetch/XHR hook 后立即 ACK；后端只从 ACK 到达后开始计算捕获超时。
    let interceptor = format!(
        r#"{}
;(()=>{{
  try {{
    const documentId = globalThis.crypto?.randomUUID?.()
      ?? `${{Date.now()}}-${{Math.random().toString(16).slice(2)}}`;
    globalThis.__flowlet_scrape_document_id = documentId;
    globalThis.__TAURI_INTERNALS__.invoke('handle_scrape_interceptor_ready', {{
      channelId: {},
      documentId,
      pageUrl: globalThis.location.href
    }}).catch(()=>{{}});
  }} catch (_) {{}}
}})();"#,
        mode.interceptor_js, channel_id_json
    );
    // per-account 隔离的 WebView 数据目录。路径位于 WebView 数据根目录下（便携版
    // 在 exe 旁、安装版在 %LOCALAPPDATA%），与主窗口 (main-webview) 同等模式。
    // 目录不存在时主动创建,避免 Tauri 直接报错。
    let data_dir = super::webview_profile::webview_data_root(app)?
        .join(format!("scrape-webview-{account_id}"));
    if let Some(parent) = data_dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建抓取 webview 数据父目录失败: {error}"))?;
    }
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("创建抓取 webview 数据目录失败: {error}"))?;
    let build_t0 = std::time::Instant::now();
    tracing::info!(
        account_id,
        channel_id,
        data_dir = %data_dir.display(),
        "开始创建控制台抓取 WebView"
    );
    let builder = tauri::webview::WebviewWindowBuilder::new(app, label, url)
        .title("Flowlet · 控制台抓取")
        .inner_size(900.0, 720.0)
        .visible(false)
        .data_directory(data_dir)
        .initialization_script(interceptor)
        .initialization_script_for_all_frames("window.__flowlet_scrape_active = true;".to_string());
    #[cfg(windows)]
    let builder =
        builder.additional_browser_args(super::webview_profile::WINDOWS_CACHE_LIMIT_BROWSER_ARGS);
    let window = builder
        .build()
        .map_err(|e| format!("构建抓取 webview 失败: {e}"))?;
    tracing::info!(
        account_id,
        channel_id,
        t_ms = build_t0.elapsed().as_millis() as u64,
        "控制台抓取 WebView 创建完成"
    );
    Ok(window)
}

/// Windows 主链路：直接从 WebView2 网络层读取外部 HTTPS 响应。document-start
/// fetch/XHR hook 仍然保留为跨平台 fallback，重复响应会按 kind 覆盖。
#[cfg(windows)]
pub fn install_windows_response_capture(
    window: &tauri::WebviewWindow,
    account_id: String,
    pending: Arc<Mutex<HashMap<String, Vec<(String, String)>>>>,
    native_ready: Arc<Mutex<std::collections::HashSet<String>>>,
) -> Result<(), String> {
    window
        .with_webview(move |platform_webview| {
            if let Err(error) = attach_webview2_response_capture(
                platform_webview,
                account_id.clone(),
                Arc::clone(&pending),
            ) {
                // 原生监听失败时仍可使用 document-start 注入，不阻断创建登录窗口。
                tracing::warn!(
                    account_id = %account_id,
                    error = %error,
                    "WebView2 原生响应监听安装失败，将使用页面注入 fallback"
                );
            } else {
                if let Ok(mut guard) = native_ready.lock() {
                    guard.insert(account_id.clone());
                }
                tracing::info!(
                    account_id = %account_id,
                    capture_backend = "webview2",
                    "控制台原生网络监听已就绪"
                );
            }
        })
        .map_err(|error| format!("调度 WebView2 原生响应监听失败: {error}"))
}

#[cfg(windows)]
fn attach_webview2_response_capture(
    platform_webview: tauri::webview::PlatformWebview,
    account_id: String,
    pending: Arc<Mutex<HashMap<String, Vec<(String, String)>>>>,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2_2};
    use webview2_com::{
        take_pwstr, WebResourceResponseReceivedEventHandler,
        WebResourceResponseViewGetContentCompletedHandler,
    };
    use windows::core::{Interface, PWSTR};

    let controller = platform_webview.controller();
    let webview: ICoreWebView2 = unsafe { controller.CoreWebView2() }
        .map_err(|error| format!("获取 ICoreWebView2 失败: {error}"))?;
    let webview2: ICoreWebView2_2 = webview
        .cast()
        .map_err(|error| format!("获取 ICoreWebView2_2 失败: {error}"))?;
    let handler =
        WebResourceResponseReceivedEventHandler::create(Box::new(move |_sender, event_args| {
            let Some(event_args) = event_args else {
                return Ok(());
            };
            let request = unsafe { event_args.Request()? };
            let mut raw_uri = PWSTR::null();
            unsafe { request.Uri(&mut raw_uri)? };
            let url = take_pwstr(raw_uri);
            if classify_response_url(&url) == "unknown" {
                return Ok(());
            }

            let response = unsafe { event_args.Response()? };
            let response_url = url.clone();
            let response_account_id = account_id.clone();
            let response_pending = Arc::clone(&pending);
            let completed = WebResourceResponseViewGetContentCompletedHandler::create(Box::new(
                move |result, content| {
                    if result.is_err() {
                        return Ok(());
                    }
                    let Some(content) = content else {
                        return Ok(());
                    };
                    match read_webview2_response_body(&content) {
                        Ok(body) => {
                            let kind = classify_response_url(&response_url);
                            let body_bytes = body.len();
                            if let Ok(mut guard) = response_pending.lock() {
                                let entry = guard.entry(response_account_id.clone()).or_default();
                                record_captured_response(entry, response_url.clone(), body);
                            }
                            tracing::info!(
                                account_id = %response_account_id,
                                response_kind = %kind,
                                response_url = %response_url,
                                body_bytes,
                                capture_backend = "webview2",
                                "控制台抓取捕获到原生网络响应"
                            );
                        }
                        Err(error) => tracing::debug!(
                            account_id = %response_account_id,
                            response_url = %response_url,
                            error = %error,
                            "读取 WebView2 响应 body 失败"
                        ),
                    }
                    Ok(())
                },
            ));
            unsafe { response.GetContent(&completed)? };
            Ok(())
        }));
    let mut token = 0_i64;
    unsafe { webview2.add_WebResourceResponseReceived(&handler, &mut token) }
        .map_err(|error| format!("订阅 WebResourceResponseReceived 失败: {error}"))?;
    Ok(())
}

#[cfg(windows)]
fn read_webview2_response_body(
    stream: &windows::Win32::System::Com::IStream,
) -> Result<String, String> {
    const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        let mut read = 0_u32;
        let result = unsafe {
            stream.Read(
                chunk.as_mut_ptr().cast(),
                chunk.len() as u32,
                Some(&mut read),
            )
        };
        result
            .ok()
            .map_err(|error| format!("读取响应流失败: {error}"))?;
        if read == 0 {
            break;
        }
        if bytes.len() + read as usize > MAX_RESPONSE_BYTES {
            return Err("抓取响应超过 8 MB".to_string());
        }
        bytes.extend_from_slice(&chunk[..read as usize]);
    }
    String::from_utf8(bytes).map_err(|error| format!("响应 body 不是 UTF-8: {error}"))
}

/// Linux 主链路：WebKitGTK 会为页面 fetch/XHR 创建 WebResource；资源完成后直接读取
/// 原始响应数据。页面注入继续作为 fallback，并覆盖 macOS 没有等价公开 API 的情况。
#[cfg(target_os = "linux")]
pub fn install_linux_response_capture(
    window: &tauri::WebviewWindow,
    account_id: String,
    pending: Arc<Mutex<HashMap<String, Vec<(String, String)>>>>,
    native_ready: Arc<Mutex<std::collections::HashSet<String>>>,
) -> Result<(), String> {
    use webkit2gtk::{URIRequestExt, WebResourceExt, WebViewExt};

    window
        .with_webview(move |platform_webview| {
            let webview = platform_webview.inner();
            let listener_account_id = account_id.clone();
            webview.connect_resource_load_started(move |_webview, resource, request| {
                let Some(url) = request.uri().map(|value| value.to_string()) else {
                    return;
                };
                if classify_response_url(&url) == "unknown" {
                    return;
                }
                let response_url = url.clone();
                let response_account_id = listener_account_id.clone();
                let response_pending = Arc::clone(&pending);
                resource.connect_finished(move |resource| {
                    let response_url = response_url.clone();
                    let response_account_id = response_account_id.clone();
                    let response_pending = Arc::clone(&response_pending);
                    resource.data(
                        None::<&webkit2gtk::gio::Cancellable>,
                        move |result| match result {
                            Ok(bytes) if bytes.len() <= 8 * 1024 * 1024 => {
                                let Ok(body) = String::from_utf8(bytes) else {
                                    return;
                                };
                                let kind = classify_response_url(&response_url);
                                let body_bytes = body.len();
                                if let Ok(mut guard) = response_pending.lock() {
                                    let entry =
                                        guard.entry(response_account_id.clone()).or_default();
                                    record_captured_response(entry, response_url.clone(), body);
                                }
                                tracing::info!(
                                    account_id = %response_account_id,
                                    response_kind = %kind,
                                    response_url = %response_url,
                                    body_bytes,
                                    capture_backend = "webkitgtk",
                                    "控制台抓取捕获到原生网络响应"
                                );
                            }
                            Ok(bytes) => tracing::debug!(
                                account_id = %response_account_id,
                                response_url = %response_url,
                                body_bytes = bytes.len(),
                                "WebKitGTK 抓取响应超过 8 MB"
                            ),
                            Err(error) => tracing::debug!(
                                account_id = %response_account_id,
                                response_url = %response_url,
                                error = %error,
                                "读取 WebKitGTK 响应 body 失败"
                            ),
                        },
                    );
                });
            });
            if let Ok(mut guard) = native_ready.lock() {
                guard.insert(account_id.clone());
            }
            tracing::info!(
                account_id = %account_id,
                capture_backend = "webkitgtk",
                "控制台原生网络监听已就绪"
            );
        })
        .map_err(|error| format!("调度 WebKitGTK 原生响应监听失败: {error}"))
}

/// 根据响应 URL 判断它属于哪个抓取阶段(用于聚合模式分槽)。
/// 这里只允许精确的业务 API 路径。不能用 `contains("usage")` 之类的宽泛
/// 规则，否则 LongCat 的控制台 document、监控埋点和用量明细都会被误认为
/// 套餐响应，导致多阶段抓取提前结束。
pub fn classify_response_url(url: &str) -> &'static str {
    let normalized = url.to_ascii_lowercase().replace("%2f", "/");
    if normalized.contains("/tokenplan/personal/api/v2/subscription") {
        "subscription"
    } else if normalized.contains("/tokenplan/personal/api/v2/quota-config") {
        "quota_config"
    } else if normalized.contains("/tokenplan/personal/api/v2/reset-card/list") {
        "reset_card_list"
    } else if normalized.contains("/api/pay/commercial/entitlements/token-packs/list") {
        // 必须在 token-packs/summary 之前判断,但二者路径不同无冲突。
        // 放在前面是为了让"token-packs"前缀的匹配更明确可读。
        "token_packs_list"
    } else if normalized.contains("/api/pay/quota/metering/token-packs/summary") {
        "token_packs_summary"
    } else if normalized.contains("/api/pay/quota/metering/api-usage/summary") {
        "api_usage_summary"
    } else if normalized.contains("/tokenplan/personal/api/v2/usage") {
        "usage"
    } else {
        "unknown"
    }
}

/// 把一条业务响应写入账号缓冲。
///
/// 大多数槽位仍采用“同类型最新响应覆盖旧响应”。LongCat 的 fuel_pack 页面会对
/// `token-packs/list` 并行发出不同筛选条件的 POST 请求（例如完整历史列表，以及
/// `statusCodes=[1], pageSize=1` 的活跃包探测），因此该槽位必须按 resourceId 合并，
/// 不能让较小的筛选响应覆盖完整历史列表。
pub fn record_captured_response(entry: &mut Vec<(String, String)>, url: String, body: String) {
    let kind = classify_response_url(&url);
    if kind == "token_packs_list" {
        if let Some(index) = entry
            .iter()
            .position(|(existing_url, _)| classify_response_url(existing_url) == kind)
        {
            if let Some(merged) = merge_longcat_token_pack_list(&entry[index].1, &body) {
                entry[index] = (url, merged);
                return;
            }
        }
    }
    entry.retain(|(existing_url, _)| classify_response_url(existing_url) != kind);
    entry.push((url, body));
}

/// 判断已捕获的响应是否足以让当前槽位完成。
///
/// 对 LongCat 历史列表，如果响应声明存在历史包，就必须实际包含当前页应有的历史
/// items。这样活跃包探测请求不会抢先满足第三阶段，完整历史响应到达后才继续提取。
pub fn captured_response_satisfies_slot(kind: &str, body: &str) -> bool {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    if kind != "token_packs_list" {
        return true;
    }
    if root
        .get("code")
        .and_then(serde_json::Value::as_i64)
        .is_some_and(|code| code != 0)
    {
        return false;
    }
    let data = root.get("data").unwrap_or(&root);
    let Some(items) = data.get("items").and_then(serde_json::Value::as_array) else {
        return false;
    };
    let history_count = data
        .get("historyCount")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as usize;
    let page_size = data
        .get("pageSize")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(history_count as u64) as usize;
    if history_count == 0 {
        // fuel_pack 的完整列表使用正常分页（当前为 pageSize=9）；页面还会额外发出
        // pageSize=1 的活跃包探测。即使当前没有历史包，也要等完整列表响应，
        // 不能让探测请求抢先结束阶段。
        return page_size > 1;
    }
    let expected_history_items = history_count.min(page_size.max(1));
    let has_status_codes = items
        .iter()
        .any(|item| item.get("statusCode").is_some() || item.get("displayStatusCode").is_some());
    let captured_history_items = if has_status_codes {
        items
            .iter()
            .filter(|item| {
                item.get("statusCode")
                    .or_else(|| item.get("displayStatusCode"))
                    .and_then(serde_json::Value::as_i64)
                    .is_some_and(|status| status != 1)
            })
            .count()
    } else {
        items.len()
    };
    captured_history_items >= expected_history_items
}

fn merge_longcat_token_pack_list(existing: &str, incoming: &str) -> Option<String> {
    let mut existing_root = serde_json::from_str::<serde_json::Value>(existing).ok()?;
    let incoming_root = serde_json::from_str::<serde_json::Value>(incoming).ok()?;
    let existing_data = existing_root.get("data").unwrap_or(&existing_root);
    let incoming_data = incoming_root.get("data").unwrap_or(&incoming_root);
    let existing_items = existing_data
        .get("items")
        .and_then(serde_json::Value::as_array)?
        .clone();
    let incoming_items = incoming_data
        .get("items")
        .and_then(serde_json::Value::as_array)?
        .clone();

    let mut merged_items = Vec::new();
    let mut item_indexes = HashMap::<String, usize>::new();
    for item in existing_items.into_iter().chain(incoming_items) {
        let key = longcat_pack_item_key(&item)
            .unwrap_or_else(|| serde_json::to_string(&item).unwrap_or_default());
        if let Some(index) = item_indexes.get(&key).copied() {
            merged_items[index] = item;
        } else {
            item_indexes.insert(key, merged_items.len());
            merged_items.push(item);
        }
    }

    let count_fields = [
        "activeCount",
        "historyCount",
        "total",
        "pageSize",
        "totalPage",
    ];
    let merged_counts = count_fields.map(|field| {
        let existing_value = existing_data
            .get(field)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let incoming_value = incoming_data
            .get(field)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        (field, existing_value.max(incoming_value))
    });
    let merged_len = merged_items.len() as u64;
    let data = if existing_root.get("data").is_some() {
        existing_root.get_mut("data")?
    } else {
        &mut existing_root
    };
    let data = data.as_object_mut()?;
    data.insert("items".to_string(), serde_json::Value::Array(merged_items));
    for (field, mut value) in merged_counts {
        if field == "total" {
            value = value.max(merged_len);
        }
        data.insert(
            field.to_string(),
            serde_json::Value::Number(serde_json::Number::from(value)),
        );
    }
    serde_json::to_string(&existing_root).ok()
}

fn longcat_pack_item_key(item: &serde_json::Value) -> Option<String> {
    let id = item.get("resourceId").or_else(|| item.get("packageId"))?;
    id.as_str()
        .map(ToOwned::to_owned)
        .or_else(|| id.as_u64().map(|value| value.to_string()))
        .or_else(|| id.as_i64().map(|value| value.to_string()))
}

/// 当前导航阶段必须等到的响应槽位。
///
/// - 单页面聚合模式（Qwen）必须在本阶段收齐全部 required_slots；
/// - 多页面聚合模式（LongCat）按配置顺序让每个页面等待自己的槽位；
/// - 配置无法一一对应时，最后一个阶段兜底等待全部必需槽位。
pub fn required_slots_for_phase(
    mode: &ScrapeModeRuntime,
    phase_index: usize,
    phase_count: usize,
) -> Vec<String> {
    if !mode.aggregate || mode.required_slots.is_empty() {
        return Vec::new();
    }
    if phase_count <= 1 {
        return mode.required_slots.clone();
    }
    if mode.required_slots.len() == phase_count {
        return mode
            .required_slots
            .get(phase_index)
            .cloned()
            .into_iter()
            .collect();
    }
    if phase_index + 1 == phase_count {
        return mode.required_slots.clone();
    }
    Vec::new()
}

pub fn missing_required_slots(
    slots: &HashMap<String, String>,
    required_slots: &[String],
) -> Vec<String> {
    required_slots
        .iter()
        .filter(|slot| !slots.contains_key(slot.as_str()))
        .cloned()
        .collect()
}

/// 聚合模式:检查是否收齐所有必需的响应槽。
/// - 聚合模式(required_slots 非空):要求全部 required_slots 到位。
/// - 单响应模式:任意一个目标槽(token_packs_summary / api_usage_summary)到位即可。
pub fn aggregate_complete(slots: &HashMap<String, String>, mode: &ScrapeModeRuntime) -> bool {
    if mode.aggregate {
        if mode.required_slots.is_empty() {
            // 防御性:聚合模式未配置 required_slots 时退化为"任意目标槽到位"。
            return slots
                .keys()
                .any(|k| k == "token_packs_summary" || k == "api_usage_summary");
        }
        mode.required_slots
            .iter()
            .all(|slot| slots.contains_key(slot))
    } else {
        slots
            .keys()
            .any(|k| k == "token_packs_summary" || k == "api_usage_summary")
    }
}

/// 组装聚合模式的 bundle(传给 extractor 的 JSON 对象)。
pub fn build_aggregate_bundle(slots: &HashMap<String, String>) -> serde_json::Value {
    let mut bundle = serde_json::Map::new();
    for (key, body) in slots {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
            bundle.insert(key.clone(), value);
        }
    }
    serde_json::Value::Object(bundle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_response_url() {
        assert_eq!(
            classify_response_url(
                "https://cs-data.qianwenai.com/data/api.json?api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fsubscription"
            ),
            "subscription"
        );
        assert_eq!(
            classify_response_url(
                "https://cs-data.qianwenai.com/data/api.json?api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fquota-config"
            ),
            "quota_config"
        );
        assert_eq!(
            classify_response_url(
                "https://cs-data.qianwenai.com/data/api.json?api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage"
            ),
            "usage"
        );
        assert_eq!(
            classify_response_url(
                "https://cs-data.qianwenai.com/data/api.json?api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Freset-card%2Flist"
            ),
            "reset_card_list"
        );
        assert_eq!(
            classify_response_url(
                "https://cs-data.qianwenai.com/data/api.json?api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Freset-card%2Fdetail"
            ),
            "unknown"
        );
        assert_eq!(
            classify_response_url(
                "https://longcat.chat/api/pay/quota/metering/token-packs/summary"
            ),
            "token_packs_summary"
        );
        assert_eq!(
            classify_response_url(
                "https://longcat.chat/api/pay/commercial/entitlements/token-packs/list"
            ),
            "token_packs_list"
        );
        assert_eq!(
            classify_response_url("https://longcat.chat/api/pay/quota/metering/api-usage/summary"),
            "api_usage_summary"
        );
        assert_eq!(
            classify_response_url("https://longcat.chat/platform/usage?tab=token"),
            "unknown"
        );
        assert_eq!(
            classify_response_url(
                "https://catfront.dianping.com/api/pvts?pageurl=longcat.chat%2Fplatform%2Fusage"
            ),
            "unknown"
        );
        assert_eq!(
            classify_response_url(
                "https://longcat.chat/api/pay/quota/metering/token-usage/overview/details"
            ),
            "unknown"
        );
    }

    #[test]
    fn longcat_list_waits_for_history_response_and_merges_parallel_filters() {
        let url = "https://longcat.chat/api/pay/commercial/entitlements/token-packs/list";
        let active_probe = r#"{
          "code":0,
          "data":{
            "activeCount":1,
            "historyCount":3,
            "total":1,
            "pageNo":1,
            "pageSize":1,
            "totalPage":1,
            "items":[{"resourceId":"active-1","statusCode":1,"statusText":"生效中"}]
          }
        }"#;
        let history_list = r#"{
          "code":0,
          "data":{
            "activeCount":1,
            "historyCount":3,
            "total":3,
            "pageNo":1,
            "pageSize":9,
            "totalPage":1,
            "items":[
              {"resourceId":"history-1","statusCode":4,"statusText":"已用尽"},
              {"resourceId":"history-2","statusCode":4,"statusText":"已用尽"},
              {"resourceId":"history-3","statusCode":4,"statusText":"已用尽"}
            ]
          }
        }"#;

        assert!(!captured_response_satisfies_slot(
            "token_packs_list",
            active_probe
        ));
        assert!(captured_response_satisfies_slot(
            "token_packs_list",
            history_list
        ));
        assert!(!captured_response_satisfies_slot(
            "token_packs_list",
            r#"{"code":0,"data":{"activeCount":0,"historyCount":0,"total":0,"pageSize":1,"items":[]}}"#
        ));
        assert!(captured_response_satisfies_slot(
            "token_packs_list",
            r#"{"code":0,"data":{"activeCount":0,"historyCount":0,"total":0,"pageSize":9,"items":[]}}"#
        ));

        for responses in [[active_probe, history_list], [history_list, active_probe]] {
            let mut entry = Vec::new();
            for body in responses {
                record_captured_response(&mut entry, url.to_string(), body.to_string());
            }
            assert_eq!(entry.len(), 1);
            assert!(captured_response_satisfies_slot(
                "token_packs_list",
                &entry[0].1
            ));
            let merged: serde_json::Value =
                serde_json::from_str(&entry[0].1).expect("merged list response");
            let items = merged["data"]["items"].as_array().expect("merged items");
            assert_eq!(items.len(), 4);
            assert_eq!(
                items
                    .iter()
                    .filter(|item| item["statusCode"].as_i64() == Some(4))
                    .count(),
                3
            );
        }
    }

    #[test]
    fn waits_for_all_qwen_slots_but_one_slot_per_longcat_phase() {
        let qwen = ScrapeModeRuntime {
            console_url:
                "https://platform.qianwenai.com/home/billing/subscription/token-plan-individual"
                    .to_string(),
            console_url_secondary: None,
            console_url_tertiary: None,
            interceptor_js: String::new(),
            extractor_js: String::new(),
            aggregate: true,
            required_slots: vec![
                "subscription".to_string(),
                "quota_config".to_string(),
                "usage".to_string(),
            ],
        };
        assert_eq!(
            required_slots_for_phase(&qwen, 0, 1),
            vec!["subscription", "quota_config", "usage"]
        );

        let longcat = ScrapeModeRuntime {
            console_url: "https://longcat.chat/platform/usage?tab=token".to_string(),
            console_url_secondary: Some("https://longcat.chat/platform/usage?tab=api".to_string()),
            console_url_tertiary: Some("https://longcat.chat/platform/fuel_pack".to_string()),
            interceptor_js: String::new(),
            extractor_js: String::new(),
            aggregate: true,
            required_slots: vec![
                "token_packs_summary".to_string(),
                "api_usage_summary".to_string(),
                "token_packs_list".to_string(),
            ],
        };
        assert_eq!(
            required_slots_for_phase(&longcat, 0, 3),
            vec!["token_packs_summary"]
        );
        assert_eq!(
            required_slots_for_phase(&longcat, 1, 3),
            vec!["api_usage_summary"]
        );
        assert_eq!(
            required_slots_for_phase(&longcat, 2, 3),
            vec!["token_packs_list"]
        );
    }

    #[test]
    fn test_resolve_scrape_mode_longcat_hybrid() {
        use crate::core::channels_config::ChannelsConfig;
        use crate::core::config::ChannelPreset;
        let config = ChannelsConfig {
            presets: vec![ChannelPreset::longcat()],
            prices: vec![],
            default_exposed_models: HashMap::new(),
            endpoints: HashMap::new(),
            scrape: HashMap::new(),
        };
        // scrape 为空时返回 None(真实场景会从 config.json 加载)
        // LongCat 统一走 hybrid,不再区分 token_pack / pay_as_you_go
        assert!(resolve_scrape_mode(&config, "longcat", Some("token_pack")).is_none());
        assert!(resolve_scrape_mode(&config, "longcat", Some("hybrid")).is_none());
        assert!(resolve_scrape_mode(&config, "qwen", None).is_none());
    }

    #[test]
    fn resolve_scrape_mode_qwen_only_for_token_plan() {
        use crate::core::channels_config::{ChannelsConfig, ScrapeModeConfig};
        use crate::core::config::ChannelPreset;
        use std::collections::HashMap;
        let mut modes = HashMap::new();
        modes.insert(
            "token_plan".to_string(),
            ScrapeModeConfig {
                console_url:
                    "https://platform.qianwenai.com/home/billing/subscription/token-plan-individual"
                        .to_string(),
                console_url_secondary: None,
                console_url_tertiary: None,
                interceptor_js: String::new(),
                extractor_js: String::new(),
                aggregate: true,
                required_slots: vec![
                    "subscription".to_string(),
                    "quota_config".to_string(),
                    "usage".to_string(),
                ],
            },
        );
        let mut scrape = HashMap::new();
        scrape.insert("qwen".to_string(), modes);
        let config = ChannelsConfig {
            presets: vec![ChannelPreset::qwen()],
            prices: vec![],
            default_exposed_models: HashMap::new(),
            endpoints: HashMap::new(),
            scrape,
        };
        // Token Plan 订阅账号使用控制台抓取。
        let mode = resolve_scrape_mode(&config, "qwen", Some("token_plan")).unwrap();
        assert!(mode.aggregate);
        assert_eq!(
            mode.required_slots,
            vec!["subscription", "quota_config", "usage"]
        );
        // API 按量付费账号没有可用的抓取模式，即使配置了 token_plan scrape 也不返回。
        assert!(resolve_scrape_mode(&config, "qwen", Some("pay_as_you_go")).is_none());
        assert!(resolve_scrape_mode(&config, "qwen", None).is_none());
    }

    #[test]
    fn test_resolve_scrape_mode_longcat_hybrid_three_phase() {
        use crate::core::channels_config::{ChannelsConfig, ScrapeModeConfig};
        use crate::core::config::ChannelPreset;
        use std::collections::HashMap;
        let mut modes = HashMap::new();
        modes.insert(
            "hybrid".to_string(),
            ScrapeModeConfig {
                console_url: "https://longcat.chat/platform/usage?tab=token".to_string(),
                console_url_secondary: Some(
                    "https://longcat.chat/platform/usage?tab=api".to_string(),
                ),
                console_url_tertiary: Some("https://longcat.chat/platform/fuel_pack".to_string()),
                interceptor_js: String::new(),
                extractor_js: String::new(),
                aggregate: true,
                required_slots: vec![
                    "token_packs_summary".to_string(),
                    "api_usage_summary".to_string(),
                    "token_packs_list".to_string(),
                ],
            },
        );
        let mut scrape = HashMap::new();
        scrape.insert("longcat".to_string(), modes);
        let config = ChannelsConfig {
            presets: vec![ChannelPreset::longcat()],
            prices: vec![],
            default_exposed_models: HashMap::new(),
            endpoints: HashMap::new(),
            scrape,
        };
        let mode = resolve_scrape_mode(&config, "longcat", Some("hybrid")).unwrap();
        assert!(mode.aggregate);
        assert_eq!(
            mode.console_url_secondary.as_deref(),
            Some("https://longcat.chat/platform/usage?tab=api")
        );
        assert_eq!(
            mode.console_url_tertiary.as_deref(),
            Some("https://longcat.chat/platform/fuel_pack")
        );
        assert_eq!(
            mode.required_slots,
            vec![
                "token_packs_summary",
                "api_usage_summary",
                "token_packs_list"
            ]
        );
    }

    #[test]
    fn test_resolve_scrape_mode_longcat_hybrid_runtime() {
        use crate::core::channels_config::{ChannelsConfig, ScrapeModeConfig};
        use crate::core::config::ChannelPreset;
        use std::collections::HashMap;
        let mut modes = HashMap::new();
        modes.insert(
            "hybrid".to_string(),
            ScrapeModeConfig {
                console_url: "https://longcat.chat/platform/usage?tab=token".to_string(),
                console_url_secondary: Some(
                    "https://longcat.chat/platform/usage?tab=api".to_string(),
                ),
                console_url_tertiary: None,
                interceptor_js: String::new(),
                extractor_js: String::new(),
                aggregate: true,
                required_slots: vec![
                    "token_packs_summary".to_string(),
                    "api_usage_summary".to_string(),
                ],
            },
        );
        let mut scrape = HashMap::new();
        scrape.insert("longcat".to_string(), modes);
        let config = ChannelsConfig {
            presets: vec![ChannelPreset::longcat()],
            prices: vec![],
            default_exposed_models: HashMap::new(),
            endpoints: HashMap::new(),
            scrape,
        };
        let mode = resolve_scrape_mode(&config, "longcat", Some("hybrid")).unwrap();
        assert!(mode.aggregate);
        assert_eq!(
            mode.console_url_secondary.as_deref(),
            Some("https://longcat.chat/platform/usage?tab=api")
        );
        assert!(mode.console_url_tertiary.is_none());
        assert_eq!(
            mode.required_slots,
            vec!["token_packs_summary", "api_usage_summary"]
        );
    }

    #[test]
    fn qwen_reset_card_list_is_optional_slot() {
        let mode = ScrapeModeRuntime {
            console_url: "https://example.com".to_string(),
            console_url_secondary: None,
            console_url_tertiary: None,
            interceptor_js: String::new(),
            extractor_js: String::new(),
            aggregate: true,
            required_slots: vec![
                "subscription".to_string(),
                "quota_config".to_string(),
                "usage".to_string(),
            ],
        };
        // 无重置卡响应时不阻断聚合完成。
        let mut slots = HashMap::new();
        slots.insert("subscription".to_string(), "{}".to_string());
        slots.insert("quota_config".to_string(), "{}".to_string());
        slots.insert("usage".to_string(), "{}".to_string());
        assert!(aggregate_complete(&slots, &mode));

        // 有重置卡响应时同样完成，且进入数据 bundle 供 extractor/前端解析。
        slots.insert(
            "reset_card_list".to_string(),
            r#"{"data":{"DataV2":{"data":{"data":[]}}}}"#.to_string(),
        );
        assert!(aggregate_complete(&slots, &mode));
        let bundle = build_aggregate_bundle(&slots);
        assert!(bundle.get("reset_card_list").is_some());

        // 缺少必需槽位时即使有重置卡也不完成。
        let mut incomplete = HashMap::new();
        incomplete.insert("subscription".to_string(), "{}".to_string());
        incomplete.insert("reset_card_list".to_string(), "{}".to_string());
        assert!(!aggregate_complete(&incomplete, &mode));
    }

    #[test]
    fn test_aggregate_complete() {
        // 千问 token_plan:聚合模式,要求 subscription + quota_config + usage
        let mode_qwen = ScrapeModeRuntime {
            console_url: "https://example.com".to_string(),
            console_url_secondary: None,
            console_url_tertiary: None,
            interceptor_js: String::new(),
            extractor_js: String::new(),
            aggregate: true,
            required_slots: vec![
                "subscription".to_string(),
                "quota_config".to_string(),
                "usage".to_string(),
            ],
        };
        // LongCat hybrid:三阶段聚合模式,要求 token_packs_summary + api_usage_summary + token_packs_list
        let mode_longcat = ScrapeModeRuntime {
            console_url: "https://longcat.chat/platform/usage?tab=token".to_string(),
            console_url_secondary: Some("https://longcat.chat/platform/usage?tab=api".to_string()),
            console_url_tertiary: Some("https://longcat.chat/platform/fuel_pack".to_string()),
            interceptor_js: String::new(),
            extractor_js: String::new(),
            aggregate: true,
            required_slots: vec![
                "token_packs_summary".to_string(),
                "api_usage_summary".to_string(),
                "token_packs_list".to_string(),
            ],
        };
        let mode_single = ScrapeModeRuntime {
            console_url: "https://example.com".to_string(),
            console_url_secondary: None,
            console_url_tertiary: None,
            interceptor_js: String::new(),
            extractor_js: String::new(),
            aggregate: false,
            required_slots: vec![],
        };
        let mut slots = HashMap::new();
        assert!(!aggregate_complete(&slots, &mode_qwen));
        assert!(!aggregate_complete(&slots, &mode_longcat));
        slots.insert("token_packs_summary".to_string(), "{}".to_string());
        // LongCat hybrid 只有一个槽位时仍不完整
        assert!(!aggregate_complete(&slots, &mode_longcat));
        slots.insert("api_usage_summary".to_string(), "{}".to_string());
        // 仍缺少 token_packs_list,还不完整
        assert!(!aggregate_complete(&slots, &mode_longcat));
        slots.insert("token_packs_list".to_string(), "{}".to_string());
        assert!(aggregate_complete(&slots, &mode_longcat));
        // 千问在仅有 LongCat 槽位时不完整
        assert!(!aggregate_complete(&slots, &mode_qwen));

        slots.clear();
        slots.insert("subscription".to_string(), "{}".to_string());
        slots.insert("quota_config".to_string(), "{}".to_string());
        assert!(!aggregate_complete(&slots, &mode_qwen));
        slots.insert("usage".to_string(), "{}".to_string());
        assert!(aggregate_complete(&slots, &mode_qwen));

        let mut slots_single = HashMap::new();
        assert!(!aggregate_complete(&slots_single, &mode_single));
        slots_single.insert("token_packs_summary".to_string(), "{}".to_string());
        assert!(aggregate_complete(&slots_single, &mode_single));
    }
}
