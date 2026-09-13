use super::super::*;
use crate::core::config::{
    AgentSessionNativeSummary, AgentSessionNativeUsage, AgentSessionTimelineEvent,
    AgentSessionTrace,
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

const RUNNING_FRESHNESS: Duration = Duration::from_secs(30 * 60);

/// Flowlet 能投影为轨迹的最新一代 DSH 会话格式。DSH 用「不可变代际」的方式持久化：
/// 迁移不会就地改写旧文件，而是在同一会话目录里新增 `session.vN.jsonl[.zstd]`，
/// 旧代文件保留在同一目录。因此一个会话目录可能同时有 v0 与 v3 两份记录，
/// 必须按代际取最新的一份，而不是把同一次会话列成两行。
const DSH_CURRENT_FORMAT_VERSION: i64 = 3;

/// 会话列表按文件元数据缓存的解析结果。DSH 会话文件是整段 zstd 流，列出会话时
/// 不需要反复解压/解析 100+ 个文件；只有文件长度或 mtime 变化时才重新读取，
/// 避免 15 秒自动刷新反复触发全量原生会话解析造成界面无响应。
#[derive(Clone)]
struct CachedDshSession {
    file_len: u64,
    modified: Option<SystemTime>,
    row: AgentSessionRow,
    /// 解析时文件里是否存在未闭合的 turn（最后一条 turn/start 晚于最后一条 turn/end）。
    /// 缓存命中时据此结合当前 mtime 重新计算运行态，避免“运行中”徽标过期后不回落。
    has_open_turn: bool,
}

static DSH_SESSION_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedDshSession>>> = OnceLock::new();

pub(super) struct DeepSeekHarnessSessionAdapter;

impl AgentSessionAdapter for DeepSeekHarnessSessionAdapter {
    fn id(&self) -> &'static str {
        "deepseek-harness"
    }
    fn agent_types(&self) -> &'static [&'static str] {
        &["deepseek-harness"]
    }
    fn source_watches(&self) -> Vec<NativeAgentSourceWatch> {
        dsh_sessions_root()
            .filter(|path| path.is_dir())
            .map(|path| {
                vec![NativeAgentSourceWatch {
                    agent_type: "deepseek-harness".to_string(),
                    path,
                    recursive: true,
                }]
            })
            .unwrap_or_default()
    }
    fn list_sessions(&self) -> Vec<AgentSessionRow> {
        let files = session_files();
        let current_paths = files.iter().cloned().collect::<HashSet<_>>();
        let cache = DSH_SESSION_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        let Ok(mut cache) = cache.lock() else {
            let mut rows = files
                .into_iter()
                .filter_map(|path| session_row(&path).ok().map(|(row, _)| row))
                .collect::<Vec<_>>();
            rows.sort_by(|a, b| b.activity_at.cmp(&a.activity_at));
            return rows;
        };
        cache.retain(|path, _| current_paths.contains(path));
        let mut rows = files
            .into_iter()
            .filter_map(|path| cached_or_refresh_dsh_session(&mut cache, &path))
            .collect::<Vec<_>>();
        rows.sort_by(|a, b| b.activity_at.cmp(&a.activity_at));
        rows
    }
    fn timeline(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<AgentSessionTimeline, String> {
        let path = find_session_file(session_id)
            .ok_or_else(|| format!("未找到 DeepSeek Harness 会话 {session_id}"))?;
        read_timeline(&path)
    }
    fn last_interaction(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<Option<AgentSessionTimeline>, String> {
        let Some(path) = find_session_file(session_id) else {
            return Ok(None);
        };
        let mut timeline = read_timeline(&path)?;
        if let Some(index) = timeline
            .events
            .iter()
            .rposition(|event| event.kind == "user-message")
        {
            timeline.events = timeline.events.split_off(index);
        }
        Ok(Some(timeline))
    }
}

fn dsh_sessions_root() -> Option<PathBuf> {
    std::env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".dsh")))
        .map(|home| home.join("sessions"))
}

/// 收集会话目录下的候选文件。DSH 的规范文件名是 `session.jsonl`（v0）与
/// `session.vN.jsonl`（N ≥ 1），可再带 `.zstd` 压缩后缀；`sessionFormatLogFilename`
/// 是同一规则的唯一真源。临时文件、大写、前导零和 `.v0` 都是非规范名，直接忽略。
fn session_files() -> Vec<PathBuf> {
    let Some(root) = dsh_sessions_root() else {
        return Vec::new();
    };
    let mut pending = vec![root];
    let mut files = Vec::new();
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
                if let Some(version) = parse_session_log_filename(name) {
                    files.push(CandidateSessionFile { path, version });
                }
            }
        }
    }
    select_generation_files(files)
}

/// 一个会话目录内按 DSH 代际命名规则解析出的候选文件。
#[derive(Clone, Debug)]
struct CandidateSessionFile {
    path: PathBuf,
    /// 文件名声明的物理代际（v0 编码为 0）。
    version: i64,
}

/// 解析 `session[.vN].jsonl[.zstd]`，返回文件名声明的会话格式版本。
/// 与官方 `parseSessionFormatLogFilename` 一致：只接纳小写、无前导零的规范名，
/// 且 `.v0`、临时名、大写名返回 `None`。
fn parse_session_log_filename(filename: &str) -> Option<i64> {
    let stem = filename.strip_suffix(".zstd").unwrap_or(filename);
    let stem = stem.strip_suffix(".jsonl")?;
    if stem == "session" {
        return Some(0);
    }
    let raw = stem.strip_prefix("session.v")?;
    // 前导零（`v01`）与空数字都非规范。
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) || raw.starts_with('0') {
        return None;
    }
    raw.parse::<i64>().ok()
}

/// 同一会话目录可能同时保留多个代际的日志（迁移不改写旧文件）。列表按会话目录
/// 归并，只保留能读取的最高代际：优先不超过 Flowlet 支持版本的最新代，若目录里
/// 只有更早的代际则退回其中最新的一份，保证老会话仍可见。
///
/// 新版 DSH 也把 `session-<uuid>/session.vN.jsonl.zstd` 直接放在项目目录下，
/// 此时每个文件各自成组（文件名主干即会话标识），不会互相覆盖。
fn select_generation_files(candidates: Vec<CandidateSessionFile>) -> Vec<PathBuf> {
    let mut groups: HashMap<PathBuf, Vec<CandidateSessionFile>> = HashMap::new();
    for candidate in candidates {
        let key = session_directory_key(&candidate.path);
        groups.entry(key).or_default().push(candidate);
    }
    let mut selected = Vec::new();
    for (_, mut group) in groups {
        group.sort_by(|left, right| {
            left.version
                .cmp(&right.version)
                .then_with(|| left.path.cmp(&right.path))
        });
        let pick = group
            .iter()
            .filter(|candidate| candidate.version <= DSH_CURRENT_FORMAT_VERSION)
            .next_back()
            .or_else(|| group.last());
        if let Some(pick) = pick {
            selected.push(pick.path.clone());
        }
    }
    selected.sort();
    selected
}

/// 归并组键：文件名主干不含版本号，因此同一个会话目录里的所有代际共享同一个键。
/// 目录名带会话标识（`session-<uuid>`）时，不同会话仍分属不同目录。
fn session_directory_key(path: &Path) -> PathBuf {
    match path.parent() {
        Some(parent) => parent.to_path_buf(),
        None => path.to_path_buf(),
    }
}

/// 会话在本机的落盘目录，供会话详情面板展示。
fn session_directory(path: &Path) -> Option<String> {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.to_string_lossy().into_owned())
}

/// 解析后的 DSH 会话头。`version` 来自文件内 header（0..=3），与文件名声明的代际
/// 应当一致；`is_seeded` 表示该会话继承了一段父会话前缀（seeded 会话），
/// 前缀必须在投影前裁掉，否则父子会话的对话会重复。
struct DshSessionHeader {
    /// 逻辑会话格式版本（0..=3）；由文件内 header 声明，用于校验 Flowlet 能否投影。
    /// 仅在 `read_session` 的完整性断言中使用，投影分支本身对 v0-v3 是同一套代码。
    #[allow(dead_code)]
    version: i64,
    session_id: String,
    created_at_millis: i64,
    cwd: Option<String>,
    parent_session_id: Option<String>,
    is_seeded: bool,
}

/// 校验并解析会话头。版本高于 Flowlet 支持的代际时只降级该会话，不隐藏整份列表。
fn parse_session_header(header: &Value) -> Result<DshSessionHeader, String> {
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Err("DSH 会话缺少 session 头".to_string());
    }
    let version = header
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| "DSH 会话 header 缺少 version".to_string())?;
    if !(0..=DSH_CURRENT_FORMAT_VERSION).contains(&version) {
        return Err(format!(
            "DSH 会话格式 v{version} 尚未支持（Flowlet 当前支持 v0-v{DSH_CURRENT_FORMAT_VERSION}）"
        ));
    }
    let session_id = header
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "DSH 会话 header 缺少 id".to_string())?
        .to_string();
    Ok(DshSessionHeader {
        version,
        session_id,
        created_at_millis: header
            .get("createdAt")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        cwd: header
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string),
        parent_session_id: header
            .get("parentSession")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string),
        // v0/v1 用 header.seedLength 声明继承前缀；v2 起改用 `isSeeded`。
        is_seeded: header
            .get("isSeeded")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || header
                .get("seedLength")
                .and_then(Value::as_i64)
                .is_some_and(|length| length > 0),
    })
}

/// 裁掉 seeded 会话继承自父会话的前缀。
///
/// 官方语义：v2/v3 用最后一条带 `data.inherited: true` 的 `session/end-seed`
/// 标记切点；v0/v1 的标记没有该字段，但同一条 `session/end-seed` 记录仍精确落在
/// 切点上（v0→v1 是恒等转换，v1→v2 会在切点补写 `inherited: true`）。
/// 因此对三种代际统一取「最后一条 session/end-seed」的下一条作为本地正文起点。
/// 未声明 seeded 的会话不做裁剪，避免误伤把 `session/end-seed` 当普通记录写入的会话。
fn local_event_records(
    records: Vec<Value>,
    mut header: DshSessionHeader,
) -> (DshSessionHeader, Vec<Value>) {
    if !header.is_seeded {
        return (header, records);
    }
    let Some(cut) = records
        .iter()
        .enumerate()
        .filter(|(_, value)| value.get("type").and_then(Value::as_str) == Some("session/end-seed"))
        .map(|(index, _)| index)
        .next_back()
    else {
        return (header, records);
    };
    let mut local = records;
    // 保留切点记录本身：它在 seq 上占位，裁剪后其余事件的坐标与文本都不变。
    local.drain(..cut.min(local.len()));
    header.is_seeded = false;
    (header, local)
}

/// 读取一份 DSH 会话记录，并返回裁剪掉继承前缀后的「本地正文」记录。
/// 与上游 `dsh-session-persistence-jsonl` 一致，容忍撕裂尾部（torn tail）：
/// 崩溃时最后一条记录可能不完整，或 zstd 最后一个分帧未落盘完整。这里永远保留
/// 「已完整提交的前缀」，不因尾部损坏隐藏整个会话。
fn read_session(path: &Path) -> Result<(DshSessionHeader, Vec<Value>), String> {
    let records = read_records(path)?;
    let header = records
        .first()
        .ok_or_else(|| "DSH 会话缺少 header".to_string())?;
    let header = parse_session_header(header)?;
    // 不变量：文件名声明的代际与 header 声明一致（官方持久化两处同写）。
    // 不一致时以 header 为准，只记诊断，不因此隐藏整份会话。
    if let Some(declared) = path
        .file_name()
        .and_then(|value| value.to_str())
        .and_then(parse_session_log_filename)
    {
        debug_assert_eq!(
            declared,
            header.version,
            "DSH 会话文件名代际与 header 不一致：{}",
            path.display()
        );
    }
    Ok(local_event_records(records, header))
}

/// 读取 DSH 会话记录。与上游 `dsh-session-persistence-jsonl` 一致，容忍
/// 撕裂尾部（torn tail）：崩溃时最后一条记录可能不完整，或 zstd 最后一个分帧
/// 未落盘完整。这里永远保留「已完整提交的前缀」，不因尾部损坏隐藏整个会话。
fn read_records(path: &Path) -> Result<Vec<Value>, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("读取 DSH 会话 {} 失败：{e}", path.display()))?;
    let text = if path.extension().and_then(|value| value.to_str()) == Some("zstd") {
        // 快路径：整流解码。
        match zstd::stream::read::Decoder::new(BufReader::new(&bytes[..])).and_then(
            |mut decoder| {
                let mut text = String::new();
                decoder.read_to_string(&mut text).map(|_| text)
            },
        ) {
            Ok(text) => text,
            Err(_) => {
                // 慢路径：按官方 `scanZstdFrames` 结构遍历完整分帧，逐一解码；
                // 撕裂的最后一个分帧尝试尽力恢复其已送达的完整记录。
                let (frames, torn_start) = zstd_frame_ranges(&bytes);
                let mut recovered = String::new();
                for (start, end) in frames {
                    if let Ok(mut decoder) = zstd::stream::read::Decoder::new(BufReader::new(
                        Cursor::new(&bytes[start..end]),
                    )) {
                        let _ = decoder.read_to_string(&mut recovered);
                    }
                }
                if let Some(torn_start) = torn_start {
                    if let Ok(mut decoder) = zstd::stream::read::Decoder::new(BufReader::new(
                        Cursor::new(&bytes[torn_start..]),
                    )) {
                        let mut partial = String::new();
                        // 撕裂帧只能尽力：解码失败时丢弃这部分。
                        if decoder.read_to_string(&mut partial).is_ok() {
                            // 只保留以换行结尾的完整记录（撕裂尾部没有换行的最后一条丢弃）。
                            if let Some(last_newline) = partial.rfind('\n') {
                                recovered.push_str(&partial[..=last_newline]);
                            }
                        }
                    }
                }
                recovered
            }
        }
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let mut records = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(value) => records.push(value),
            // 只读视角的尽力语义：跳过解析失败的行，保留其余已提交记录。
            Err(_) => {}
        }
    }
    Ok(records)
}

/// 结构遍历 zstd 完整分帧（不解压块），返回 `(frames, torn_start)`。
/// 与官方 `scanZstdFrames` 逐字段一致：`blockSize = header >>> 3` 不掩码，
/// 块头 24 位中 3 位标志、其余 21 位为块大小（最大 128KiB 由此可编码）。
/// 差异仅在于对损坏的适应性：官方在坏魔数/保留位处抛错，这里把损坏点当作
/// 撕裂起点，保留此前已解码内容（只读查看器不应因一个坏帧隐藏整个会话）。
fn zstd_frame_ranges(bytes: &[u8]) -> (Vec<(usize, usize)>, Option<usize>) {
    const MAGIC: u32 = 0xFD2FB528;
    let mut frames = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        let start = offset;
        if bytes.len() - offset < 4 {
            return (frames, Some(start));
        }
        let magic = u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]);
        if magic != MAGIC {
            return (frames, Some(start));
        }
        offset += 4;
        if offset == bytes.len() {
            return (frames, Some(start));
        }
        let descriptor = bytes[offset];
        offset += 1;
        let content_size_flag = descriptor >> 6;
        let single_segment = descriptor & 32 != 0;
        let checksum = descriptor & 4 != 0;
        let dictionary_flag = (descriptor & 3) as usize;
        let dictionary_bytes = if dictionary_flag == 3 {
            4
        } else {
            dictionary_flag
        };
        let content_size_bytes = if content_size_flag == 0 {
            if single_segment {
                1
            } else {
                0
            }
        } else {
            1usize << content_size_flag
        };
        let remaining_header_bytes =
            (if single_segment { 0 } else { 1 }) + dictionary_bytes + content_size_bytes;
        if bytes.len() - offset < remaining_header_bytes {
            return (frames, Some(start));
        }
        offset += remaining_header_bytes;
        loop {
            if bytes.len() - offset < 3 {
                return (frames, Some(start));
            }
            let block_header =
                u32::from_le_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], 0]);
            offset += 3;
            let last_block = block_header & 1 != 0;
            let block_type = (block_header >> 1) & 3;
            let block_size = (block_header >> 3) as usize;
            if block_type == 3 {
                return (frames, Some(start));
            }
            let payload_bytes = if block_type == 1 { 1 } else { block_size };
            if bytes.len() - offset < payload_bytes {
                return (frames, Some(start));
            }
            offset += payload_bytes;
            if last_block {
                break;
            }
        }
        if checksum {
            if bytes.len() - offset < 4 {
                return (frames, Some(start));
            }
            offset += 4;
        }
        frames.push((start, offset));
    }
    (frames, None)
}

/// 按会话 id 查找当前代际的会话文件。读取只需第 0 行（header），
/// 因此先解压首个完整分帧即可，不必解压整份会话。
fn find_session_file(session_id: &str) -> Option<PathBuf> {
    session_files()
        .into_iter()
        .find(|path| session_header(path).is_some_and(|header| header.session_id == session_id))
}

/// 只解析会话头（不解压整份正文）。
fn session_header(path: &Path) -> Option<DshSessionHeader> {
    read_header_record(path)
        .ok()
        .as_ref()
        .and_then(|value| parse_session_header(value).ok())
}

/// 读取物理第一行（header）。zstd 是多分帧流，header 总在第一个分帧里，
/// 因此只解码首个完整分帧就能拿到；非压缩文件直接按行读取。
fn read_header_record(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("读取 DSH 会话 {} 失败：{error}", path.display()))?;
    if path.extension().and_then(|value| value.to_str()) == Some("zstd") {
        let (frames, _) = zstd_frame_ranges(&bytes);
        for (start, end) in frames {
            if let Ok(mut decoder) =
                zstd::stream::read::Decoder::new(BufReader::new(Cursor::new(&bytes[start..end])))
            {
                let mut text = String::new();
                if decoder.read_to_string(&mut text).is_ok() {
                    for line in text.lines() {
                        if line.trim().is_empty() {
                            continue;
                        }
                        return serde_json::from_str::<Value>(line)
                            .map_err(|error| format!("解析 DSH 会话头失败：{error}"));
                    }
                }
            }
        }
        return Err("DSH 会话缺少可解压的 header".to_string());
    }
    for line in String::from_utf8_lossy(&bytes).lines() {
        if line.trim().is_empty() {
            continue;
        }
        return serde_json::from_str::<Value>(line)
            .map_err(|error| format!("解析 DSH 会话头失败：{error}"));
    }
    Err("DSH 会话缺少 header".to_string())
}

/// 以秒为精度归一化时间戳：DSH 时间是毫秒，且 zstd 多分帧读取时同一批事件的
/// 时间戳可能相同或轻微乱序，按秒聚合只用于排序展示。
fn millis_time(value: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(value)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339()
}

/// 命中缓存时直接复用上次解析的行，否则重新读取并写回缓存。缓存键是文件路径，
/// 失效条件为文件长度或修改时间变化（与 Claude Code 会话缓存策略一致）。
fn cached_or_refresh_dsh_session(
    cache: &mut HashMap<PathBuf, CachedDshSession>,
    path: &Path,
) -> Option<AgentSessionRow> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().ok();
    if let Some(cached) = cache.get(path) {
        if cached.file_len == metadata.len() && cached.modified == modified {
            // mtime/大小未变，复用解析结果；但运行态要按当前时间重新收敛，
            // 避免缓存把“运行中”永久钉住（DSH 关闭后文件 mtime 不再变化）。
            let mut row = cached.row.clone();
            row.runtime_status = dsh_runtime_status_from_open_turn(
                cached.has_open_turn,
                modified,
                SystemTime::now(),
            );
            return Some(row);
        }
    }
    let (row, open_turn) = session_row(path).ok()?;
    cache.insert(
        path.to_path_buf(),
        CachedDshSession {
            file_len: metadata.len(),
            modified,
            row: row.clone(),
            has_open_turn: open_turn,
        },
    );
    Some(row)
}

fn session_row(path: &Path) -> Result<(AgentSessionRow, bool), String> {
    let (header, records) = read_session(path)?;
    let session_id = header.session_id.clone();
    let created = millis_time(header.created_at_millis);
    let modified = std::fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok());
    let updated = modified
        .map(DateTime::<Utc>::from)
        .map(|time| time.to_rfc3339())
        .unwrap_or_else(|| created.clone());
    let timeline = read_timeline_records(&records)?;
    let open_turn = has_open_turn(&records);
    let runtime_status = infer_runtime_status(&records, modified, SystemTime::now());
    Ok((
        AgentSessionRow {
            agent_type: "deepseek-harness".to_string(),
            session_id,
            runtime_status,
            title: native_session_title(&records).or_else(|| first_user_text(&records)),
            project_path: header.cwd.clone(),
            parent_session_id: header.parent_session_id.clone(),
            client_id: None,
            client_name: Some("DeepSeek Harness".to_string()),
            native_started_at: Some(created.clone()),
            native_updated_at: Some(updated.clone()),
            activity_at: updated.clone(),
            flowlet_observed: false,
            started_at: created,
            updated_at: updated,
            request_count: 0,
            success_count: 0,
            error_count: 0,
            known_tokens: 0,
            input_tokens: 0,
            input_cached_tokens: 0,
            input_uncached_tokens: 0,
            cache_measured_input_tokens: 0,
            output_tokens: 0,
            unknown_usage_count: 0,
            estimated_cost: 0.0,
            estimated_input_uncached_cost: 0.0,
            estimated_input_cached_cost: 0.0,
            estimated_input_cache_write_cost: 0.0,
            estimated_output_cost: 0.0,
            native_summary: Some(AgentSessionNativeSummary {
                source_available: true,
                truncated: false,
                turn_count: timeline.turn_count,
                usage: timeline.usage.clone(),
                models: timeline.models.clone(),
            }),
            native_synced_at: None,
            native_source: None,
            native_profile: None,
            native_session_dir: session_directory(path),
            has_flowlet_requests: false,
        },
        open_turn,
    ))
}

/// 官方 surface 事件类型：只有这四类会出现在轨迹的「当前 surface」上。
fn is_surface_type(kind: &str) -> bool {
    matches!(
        kind,
        "system/message" | "user/message" | "assistant/message" | "tool/result"
    )
}

/// 收集被 surface 替换覆盖的序号。
///
/// 官方规范信封用 `surfaceOp: { op: 'replace', start|startSeq, end|endSeq }` 表示
/// 「这些早先的 surface 事件已被本条取代」（压缩检查点即典型：尾部插入一条
/// `plugin=compact` 的 user/message，覆盖整段被摘要掉的历史）。v2 以前用
/// `start`/`end`，v3 重命名为 `startSeq`/`endSeq`，两者都按闭区间处理。
fn shadowed_event_seqs(events: &[&Value]) -> HashSet<i64> {
    let mut shadowed = HashSet::new();
    for value in events {
        let (Some(start), Some(end)) = (
            value
                .pointer("/surfaceOp/startSeq")
                .or_else(|| value.pointer("/surfaceOp/start"))
                .and_then(Value::as_i64),
            value
                .pointer("/surfaceOp/endSeq")
                .or_else(|| value.pointer("/surfaceOp/end"))
                .and_then(Value::as_i64),
        ) else {
            continue;
        };
        for seq in start..=end {
            shadowed.insert(seq);
        }
    }
    shadowed
}

/// 计算最终存活的 surface 序号集合。
///
/// 一个 surface 事件只要没被任何后续替换覆盖就默认存活；被覆盖的事件仅当被某条
/// 存活 surface 的 `sourceEventSeqs` 重新引用时才回到 surface 上（官方
/// `surfaceOp` 的还原语义）。该集合只用于跳过已被替换掉的重复投影，
/// 不参与任何写入或费用计算。
fn surface_survivor_seqs(events: &[&Value], shadowed: &HashSet<i64>) -> HashSet<i64> {
    let mut survivors = HashSet::new();
    for value in events {
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !is_surface_type(kind) {
            continue;
        }
        let seq = value.get("seq").and_then(Value::as_i64).unwrap_or_default();
        // 官方约束：assistant/message 禁止携带 sourceEventSeqs（它自身是产物）；
        // 其余 surface 可以引用更早的事件，作为替换后的溯源。
        if shadowed.contains(&seq) && kind != "assistant/message" {
            continue;
        }
        survivors.insert(seq);
    }
    for value in events {
        let Some(referenced) = value.get("sourceEventSeqs").and_then(Value::as_array) else {
            continue;
        };
        for item in referenced {
            // v0/v1 的溯源是 `[start, end]` 区间，v2 起是密集序号数组。
            match item {
                Value::Array(range) => {
                    if let (Some(start), Some(end)) = (
                        range.first().and_then(Value::as_i64),
                        range.get(1).and_then(Value::as_i64),
                    ) {
                        for seq in start..=end {
                            survivors.insert(seq);
                        }
                    }
                }
                _ => {
                    if let Some(seq) = item.as_i64() {
                        survivors.insert(seq);
                    }
                }
            }
        }
    }
    survivors
}

/// DSH 的 `turn/end` 只结束当前一轮，不能代表整个 Web 会话已经结束。
/// 最新 `turn/start` 晚于最新 `turn/end` 且文件仍在活跃更新时，才视为运行中；
/// 异常退出留下的未闭合 turn 在新鲜度窗口后降级为空闲。
/// 是否存在未闭合的 turn：最后一条 `turn/start` 晚于最后一条 `turn/end`。
fn has_open_turn(records: &[Value]) -> bool {
    let last_turn_start = records
        .iter()
        .rposition(|value| value.get("type").and_then(Value::as_str) == Some("turn/start"));
    let last_turn_end = records
        .iter()
        .rposition(|value| value.get("type").and_then(Value::as_str) == Some("turn/end"));
    last_turn_start.is_some_and(|start| last_turn_end.is_none_or(|end| start > end))
}

fn infer_runtime_status(
    records: &[Value],
    modified: Option<SystemTime>,
    now: SystemTime,
) -> String {
    dsh_runtime_status_from_open_turn(has_open_turn(records), modified, now)
}

fn dsh_runtime_status_from_open_turn(
    open_turn: bool,
    modified: Option<SystemTime>,
    now: SystemTime,
) -> String {
    let recently_modified = modified.is_some_and(|modified| {
        now.duration_since(modified)
            .map_or(true, |age| age <= RUNNING_FRESHNESS)
    });
    if open_turn && recently_modified {
        "running"
    } else {
        "idle"
    }
    .to_string()
}

fn first_user_text(records: &[Value]) -> Option<String> {
    records
        .iter()
        .find(|v| v.get("type").and_then(Value::as_str) == Some("user/message"))
        .and_then(|v| message_text(v.get("data")?))
        .map(|text| text.chars().take(120).collect())
}

fn native_session_title(records: &[Value]) -> Option<String> {
    records.iter().rev().find_map(|value| {
        if value.get("type").and_then(Value::as_str) != Some("session/title") {
            return None;
        }
        value
            .pointer("/data/title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(str::to_string)
    })
}

fn read_timeline(path: &Path) -> Result<AgentSessionTimeline, String> {
    let (_, records) = read_session(path)?;
    read_timeline_records(&records)
}

fn read_timeline_records(records: &[Value]) -> Result<AgentSessionTimeline, String> {
    // 记录可能是裁剪过继承前缀的本地切片（首条为 session/end-seed 而非 header），
    // 因此按类型而不是按位置剔除 header 与 seed 标记。header 存在时仍要过一遍
    // 版本闸门，否则未来代际会被当成本地正文静默投影。
    if let Some(header) = records
        .iter()
        .find(|value| value.get("type").and_then(Value::as_str) == Some("session"))
    {
        parse_session_header(header)?;
    }
    let events = records
        .iter()
        .filter(|value| {
            !matches!(
                value.get("type").and_then(Value::as_str),
                Some("session" | "session/end-seed")
            )
        })
        .collect::<Vec<_>>();
    let mut timeline = AgentSessionTimeline {
        source_available: true,
        truncated: false,
        turn_count: 0,
        usage: None,
        models: Vec::new(),
        events: Vec::new(),
        event_limit: None,
        content_limit: None,
    };
    let mut total = AgentSessionNativeUsage::default();

    // 预扫描轮次状态：turn/end 的 reason.kind → 轮次状态；缺失 turn/end 视为运行中。
    // reason.kind 枚举（官方）：completed / aborted(user|parent|hook|disposed|legacy) /
    // blocked / error / max-tokens / interrupted。aborted/blocked/interrupted 统一映射为
    // 前端已支持的 cancelled，error 单独保留，max-tokens 保留独立状态（对话按官方展示
    // 独立提示，而不是当作中断）。
    let mut turn_status: HashMap<i64, String> = HashMap::new();
    let mut turn_ended_at: HashMap<i64, i64> = HashMap::new();
    let mut turn_error_message: HashMap<i64, String> = HashMap::new();
    for value in events.iter().copied() {
        if value.get("type").and_then(Value::as_str) != Some("turn/end") {
            continue;
        }
        let Some(turn) = value.pointer("/data/turn").and_then(Value::as_i64) else {
            continue;
        };
        turn_ended_at.insert(
            turn,
            value
                .get("time")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
        );
        let status = match value.pointer("/data/reason/kind").and_then(Value::as_str) {
            Some("completed") => "completed",
            Some("error") => "error",
            Some("max-tokens") => "max-tokens",
            _ => "cancelled",
        };
        turn_status.insert(turn, status.to_string());
        if status == "error" {
            let message = value
                .pointer("/data/reason/error/message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| "Unknown error".to_string());
            turn_error_message.insert(turn, message);
        }
    }

    // 预扫描 steering：agent/inbox/spliced（target=next-step，outcome != canceled）
    // 从 pending 队列移除的消息 id 会被下一轮采纳（官方 applySplice），作为 steering 标记。
    let mut steered_message_ids = HashSet::<String>::new();
    {
        let mut pending: Vec<String> = Vec::new();
        for value in events.iter().copied() {
            if value.get("type").and_then(Value::as_str) != Some("agent/inbox/spliced") {
                continue;
            }
            let data = value.get("data").unwrap_or(&Value::Null);
            if data.get("target").and_then(Value::as_str) != Some("next-step") {
                continue;
            }
            let start = data
                .get("start")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                .max(0) as usize;
            let removed_count = data
                .get("removedCount")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                .max(0) as usize;
            let inserted: Vec<String> = data
                .get("inserted")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            item.get("id").and_then(Value::as_str).map(str::to_string)
                        })
                        .collect()
                })
                .unwrap_or_default();
            if start > pending.len() {
                continue;
            }
            let removed: Vec<String> = pending
                .drain(start..start.saturating_add(removed_count))
                .collect();
            for identity in &inserted {
                steered_message_ids.remove(identity);
            }
            if data.get("outcome").and_then(Value::as_str) != Some("canceled") {
                for identity in &removed {
                    steered_message_ids.insert(identity.clone());
                }
            }
            pending.splice(start..start, inserted);
        }
    }

    // 预扫描 surface 存活集：官方轨迹只呈现「当前 surface」。压缩检查点用
    // surfaceOp 覆盖被压缩掉的区间（checkpoint 落在尾部，被覆盖的是更早的历史），
    // 若原样投影，同一个回答会同时以「原始事件」和「压缩摘要」两种形态出现。
    // 这里按官方语义收集被覆盖的序号并剔除，只保留最后存活的 surface。
    let shadowed_seqs = shadowed_event_seqs(&events);
    let survivor_seqs = surface_survivor_seqs(&events, &shadowed_seqs);

    let mut turn_started_at = HashMap::<i64, i64>::new();
    let mut tool_names = HashMap::<String, String>::new();
    let mut tool_started_at = HashMap::<String, i64>::new();
    let mut step_started_at = HashMap::<(i64, i64), i64>::new();
    let mut first_token_at = HashMap::<(i64, i64), i64>::new();
    let mut open_tools = HashMap::<String, (i64, i64)>::new();
    let mut compaction_started_at = HashMap::<String, i64>::new();
    let mut compaction_turn = HashMap::<String, Option<i64>>::new();
    let mut visible_turns = HashSet::<i64>::new();
    let mut current_turn = None;
    let mut current_step = None;
    let mut last_system_prompt: Option<String> = None;
    let mut unlocated_assistant_count = 0i64;
    for (record_index, value) in events.iter().enumerate() {
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let seq = value.get("seq").and_then(Value::as_i64).unwrap_or_default();
        let event_time = value.get("time").and_then(Value::as_i64);
        let timestamp = event_time.map(millis_time);
        let fallback_duration_ms = event_time
            .zip(
                events
                    .get(record_index + 1)
                    .and_then(|next| next.get("time"))
                    .and_then(Value::as_i64),
            )
            .map(|(started, ended)| ended.saturating_sub(started));
        let data = value.get("data").unwrap_or(&Value::Null);
        // 被后续 surface 替换覆盖、且自身不再存活的事件直接跳过。
        if is_surface_type(kind) && !survivor_seqs.contains(&seq) {
            continue;
        }

        if kind == "turn/start" {
            current_turn = data.get("turn").and_then(Value::as_i64);
            current_step = None;
            if let Some(turn) = current_turn {
                visible_turns.insert(turn);
                turn_started_at.insert(turn, event_time.unwrap_or_default());
                // 轮次状态事件：放在轮次起点，状态/耗时在收尾处才确定（上面已预扫描）。
                let mut trace = trace_from(seq, "turn/start", data);
                trace.turn = Some(turn);
                push_event(
                    &mut timeline,
                    seq,
                    "turn",
                    timestamp,
                    None,
                    // error 轮次把失败消息带上（对话按官方 turn-error 行展示安全消息）。
                    Some(turn_error_message.get(&turn).cloned().unwrap_or_default())
                        .filter(|message| !message.is_empty()),
                    None,
                    None,
                    turn_started_at
                        .get(&turn)
                        .zip(turn_ended_at.get(&turn))
                        .map(|(started, ended)| ended.saturating_sub(*started)),
                    None,
                    Some(trace),
                    Some(
                        turn_status
                            .get(&turn)
                            .cloned()
                            .unwrap_or_else(|| "running".to_string()),
                    ),
                );
            }
            continue;
        }
        if kind == "step/start" {
            current_turn = data.get("turn").and_then(Value::as_i64).or(current_turn);
            current_step = data.get("step").and_then(Value::as_i64);
            if let (Some(turn), Some(step), Some(started)) =
                (current_turn, current_step, event_time)
            {
                step_started_at.insert((turn, step), started);
            }
            continue;
        }
        if kind == "step/end" {
            let coordinate = current_turn.zip(current_step);
            // 该步骤结束时仍未返回的 tool/call → 合成中断的 tool-result（官方行为）。
            close_interrupted_tools(
                &mut timeline,
                &mut open_tools,
                &tool_names,
                &tool_started_at,
                seq,
                event_time,
                coordinate,
            );
            continue;
        }
        if kind == "turn/end" {
            // 轮次结束时仍未返回的工具调用一并闭合。
            let coordinate = current_turn.map(|turn| (turn, i64::MAX));
            close_interrupted_tools(
                &mut timeline,
                &mut open_tools,
                &tool_names,
                &tool_started_at,
                seq,
                event_time,
                coordinate,
            );
            continue;
        }
        if kind == "assistant/chunk" {
            // 首 token 计时：第一个携带内容的 delta（text/reasoning/tool-call）即为 TTFT 起点。
            let chunk_type = data.pointer("/chunk/type").and_then(Value::as_str);
            if let (Some(turn), Some(step), Some(time)) = (current_turn, current_step, event_time) {
                if matches!(
                    chunk_type,
                    Some("text-delta" | "reasoning-delta" | "tool-call-delta")
                ) && !first_token_at.contains_key(&(turn, step))
                {
                    first_token_at.insert((turn, step), time);
                }
            }
            continue;
        }
        // 同块 chunk delta 的打包存储行（官方 DEFAULT_PACK_CHUNKS=true）：不是事件，不含
        // 顶层 seq/time，携带 seq0/time0 与 data.{turn,step,index,dt[],texts[]}。
        // 其 time0 即该块第一个 delta 的时间，同样参与首 token 计时。
        if matches!(
            kind,
            "text-chunks" | "reasoning-chunks" | "tool-call-chunks"
        ) {
            let turn = data.get("turn").and_then(Value::as_i64).or(current_turn);
            let step = data.get("step").and_then(Value::as_i64).or(current_step);
            let packed_time = value.get("time0").and_then(Value::as_i64);
            if let (Some(turn), Some(step), Some(time)) = (turn, step, packed_time) {
                first_token_at.entry((turn, step)).or_insert(time);
            }
            continue;
        }
        if kind == "compaction/start" {
            if let Some(id) = data.get("compactionId").and_then(Value::as_str) {
                compaction_started_at.insert(id.to_string(), event_time.unwrap_or_default());
                compaction_turn.insert(id.to_string(), data.get("turn").and_then(Value::as_i64));
            }
            continue;
        }
        if kind == "compaction/summary" {
            let id = data.get("compactionId").and_then(Value::as_str);
            let text = compaction_summary_text(data);
            let start_time = id
                .and_then(|id| compaction_started_at.get(id).copied())
                .or(event_time);
            let mut trace = trace_from(seq, "compaction/summary", data);
            trace.turn = id.and_then(|id| compaction_turn.get(id).copied()).flatten();
            trace.input = None;
            trace.output = text.clone();
            trace.provider = data
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_string);
            let usage = native_usage(data.get("usage"));
            push_event(
                &mut timeline,
                seq,
                "compacted",
                timestamp,
                None,
                text,
                data.get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                usage,
                start_time
                    .zip(event_time)
                    .map(|(started, ended)| ended.saturating_sub(started)),
                None,
                Some(trace),
                None,
            );
            continue;
        }
        // 压缩过程的其余记录（end/prune）与 checkpoint user/message 由 summary 承接，不单列。
        if kind == "compaction/end" || kind == "compaction/prune" {
            continue;
        }
        // 审批历史：asked 投影为 approval 事件（status=pending），decided 回写结果。
        if kind == "approval/asked" {
            let approval_id = data.get("id").and_then(Value::as_str).map(str::to_string);
            let mut trace = trace_from(seq, "approval/asked", data);
            trace.turn = current_turn;
            trace.step = current_step;
            trace.request_reason = approval_id;
            push_event(
                &mut timeline,
                seq,
                "approval",
                timestamp,
                data.get("toolName")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                data.get("reason")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                None,
                None,
                None,
                None,
                Some(trace),
                Some("pending".to_string()),
            );
            continue;
        }
        if kind == "approval/decided" {
            let outcome = data
                .get("outcome")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let approval_id = data.get("id").and_then(Value::as_str);
            if let Some(id) = approval_id {
                if let Some(event) = timeline.events.iter_mut().find(|event| {
                    event.kind == "approval"
                        && event
                            .trace
                            .as_ref()
                            .and_then(|t| t.request_reason.as_deref())
                            == Some(id)
                }) {
                    event.status = Some(outcome);
                    continue;
                }
            }
            // 无对应 asked（如窗口外/老化）：单独投影一行。
            let mut trace = trace_from(seq, "approval/decided", data);
            trace.turn = current_turn;
            trace.step = current_step;
            trace.request_reason = data.get("id").and_then(Value::as_str).map(str::to_string);
            push_event(
                &mut timeline,
                seq,
                "approval",
                timestamp,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(trace),
                Some(outcome),
            );
            continue;
        }
        // 模型重试：投影为 model-retry 事件（官方 model-retry 行：次数/延迟/失败原因）。
        if kind == "llm/retry" {
            let retry = data
                .get("retry")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            let max_retries = data
                .get("maxRetries")
                .and_then(Value::as_i64)
                .map(|value| value.to_string())
                .unwrap_or_else(|| "?".to_string());
            let delay_ms = data
                .get("delayMs")
                .and_then(Value::as_f64)
                .map(|value| value.round() as i64)
                .unwrap_or_default();
            let failure = data.get("failure").and_then(json_text);
            let mut trace = trace_from(seq, "llm/retry", data);
            trace.turn = data.get("turn").and_then(Value::as_i64).or(current_turn);
            trace.step = data.get("step").and_then(Value::as_i64).or(current_step);
            trace.provider = data
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_string);
            trace.output = failure.clone();
            let title = format!("retry {retry}/{max_retries} · {delay_ms} ms");
            push_event(
                &mut timeline,
                seq,
                "model-retry",
                timestamp,
                Some(title),
                failure,
                None,
                None,
                None,
                None,
                Some(trace),
                None,
            );
            continue;
        }

        let mut trace = trace_from(seq, kind, data);
        trace.turn = trace.turn.or(current_turn);
        trace.step = trace.step.or(current_step);
        match kind {
            "user/message" => {
                // 压缩检查点（source.plugin == "compact"）不做 context 行，避免与
                // compacted 事件重复；其内容已随 compaction/summary 投射。
                if data.pointer("/source/plugin").and_then(Value::as_str) == Some("compact") {
                    continue;
                }
                let content = message_text(data);
                trace.input = content.clone();
                let source_kind = data.pointer("/source/kind").and_then(Value::as_str);
                // 来源透传（官方 MessageSourceMap 合并可扩展）：kind/form/producer。
                trace.source_kind = source_kind.map(str::to_string);
                trace.source_form = data
                    .pointer("/source/form")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                trace.producer = data
                    .pointer("/source/plugin")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        data.pointer("/source/changes")
                            .and_then(Value::as_array)
                            .map(|changes| {
                                changes
                                    .iter()
                                    .filter_map(|change| change.get("path").and_then(Value::as_str))
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            })
                    });
                let message_id = data.get("id").and_then(Value::as_str).map(str::to_string);
                let is_user = source_kind.is_none_or(|source| source == "user");
                // 从 next-step inbox 被采纳的消息：官方同用户气泡呈现（steering），
                // 走 user-message 分支并在 trace 里标记。
                let is_steering = message_id
                    .as_ref()
                    .is_some_and(|id| steered_message_ids.contains(id));
                if is_steering {
                    trace.request_reason = Some("steering".to_string());
                }
                push_event(
                    &mut timeline,
                    seq,
                    if is_user || is_steering {
                        "user-message"
                    } else {
                        "context"
                    },
                    timestamp,
                    (!is_user && !is_steering).then(|| "Context".to_string()),
                    content,
                    None,
                    None,
                    Some(0),
                    None,
                    Some(trace),
                    None,
                );
            }
            "assistant/message" => {
                let message = data.get("message").unwrap_or(data);
                // v2/v3 起模型归属写在 `data.message.source`（v0 也曾用过
                // `data.provenance`），两者都读，避免历史会话丢失模型列。
                let model = message
                    .pointer("/source/model")
                    .or_else(|| message.pointer("/provenance/model"))
                    .or_else(|| data.pointer("/provenance/model"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(model) = model
                    .as_ref()
                    .filter(|model| !timeline.models.contains(model))
                {
                    timeline.models.push(model.clone());
                }
                let usage =
                    native_usage(data.get("usage").or_else(|| data.pointer("/message/usage")));
                if let Some(value) = &usage {
                    add_usage(&mut total, value);
                }
                let duration_ms = trace
                    .turn
                    .zip(trace.step)
                    .and_then(|coordinate| step_started_at.get(&coordinate).copied())
                    .zip(event_time)
                    .map(|(started, ended)| ended.saturating_sub(started))
                    .or(fallback_duration_ms);
                let time_to_first_token_ms = trace
                    .turn
                    .zip(trace.step)
                    .and_then(|coordinate| first_token_at.get(&coordinate).copied())
                    .zip(
                        trace
                            .turn
                            .zip(trace.step)
                            .and_then(|coordinate| step_started_at.get(&coordinate).copied()),
                    )
                    .map(|(first, started)| first.saturating_sub(started));
                if let Some(reasoning) = message_block_text(message, "reasoning") {
                    let mut reasoning_trace = trace.clone();
                    reasoning_trace.output = Some(reasoning.clone());
                    push_event(
                        &mut timeline,
                        seq,
                        "reasoning",
                        timestamp.clone(),
                        Some("Thinking".to_string()),
                        Some(reasoning),
                        model.clone(),
                        None,
                        duration_ms,
                        None,
                        Some(reasoning_trace),
                        None,
                    );
                }
                let content = message_block_text(message, "text").or_else(|| message_text(message));
                trace.output = content.clone();
                if let Some(turn) = trace.turn {
                    visible_turns.insert(turn);
                } else {
                    unlocated_assistant_count += 1;
                }
                push_event(
                    &mut timeline,
                    seq,
                    "assistant-message",
                    timestamp,
                    None,
                    content,
                    model,
                    usage,
                    duration_ms,
                    time_to_first_token_ms,
                    Some(trace),
                    None,
                );
            }
            // v3 起系统提示词从 `request/header.data.header.system` 提升为独立
            // surface 事件（官方 v2→v3 迁移把提示词变成消息）。投影为 request 行，
            // 保留 system prompt 列与官方「Initial System Prompt / Updated」文案。
            "system/message" => {
                let message = data.get("message").unwrap_or(data);
                let prompt = message_block_text(message, "text").or_else(|| message_text(message));
                // 只有真正发生变化的提示词才产生一行（官方仅替换受保护的头节点）；
                // 空提示词只清空前值，不新增轨迹行。
                let changed = prompt.is_some() && last_system_prompt.as_ref() != prompt.as_ref();
                if !changed {
                    last_system_prompt = prompt;
                    continue;
                }
                let initial_prompt = last_system_prompt.is_none();
                trace.system_prompt = prompt.clone();
                last_system_prompt = prompt;
                push_event(
                    &mut timeline,
                    seq,
                    "request",
                    timestamp,
                    Some(
                        if initial_prompt {
                            "Initial System Prompt"
                        } else {
                            "System Prompt Updated"
                        }
                        .to_string(),
                    ),
                    None,
                    None,
                    None,
                    Some(0),
                    None,
                    Some(trace),
                    None,
                );
            }
            "tool/call" => {
                let input = data
                    .get("arguments")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                trace.input = input.clone();
                if let (Some(call_id), Some(name)) = (
                    trace.call_id.clone(),
                    data.get("name").and_then(Value::as_str),
                ) {
                    tool_names.insert(call_id.clone(), name.to_string());
                    if let Some(coordinate) = trace.turn.zip(trace.step).or(Some((0, 0))) {
                        open_tools.insert(call_id, coordinate);
                    }
                }
                if let (Some(call_id), Some(started)) = (trace.call_id.clone(), event_time) {
                    tool_started_at.insert(call_id, started);
                }
                push_event(
                    &mut timeline,
                    seq,
                    "tool-call",
                    timestamp,
                    data.get("name").and_then(Value::as_str).map(str::to_string),
                    input,
                    None,
                    None,
                    None,
                    None,
                    Some(trace),
                    None,
                );
            }
            "tool/result" => {
                let output = data.get("message").and_then(message_text);
                trace.output = output.clone();
                let title = trace
                    .call_id
                    .as_ref()
                    .and_then(|call_id| tool_names.get(call_id))
                    .cloned()
                    .or_else(|| {
                        data.pointer("/message/toolName")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                if let Some(call_id) = trace.call_id.as_ref() {
                    open_tools.remove(call_id);
                }
                let duration_ms = trace
                    .call_id
                    .as_ref()
                    .and_then(|call_id| tool_started_at.get(call_id).copied())
                    .zip(event_time)
                    .map(|(started, ended)| ended.saturating_sub(started))
                    .or(fallback_duration_ms);
                push_event(
                    &mut timeline,
                    seq,
                    "tool-result",
                    timestamp,
                    title,
                    output,
                    None,
                    None,
                    duration_ms,
                    None,
                    Some(trace),
                    None,
                );
            }
            // v3 把 code dispatch 词汇重命名为 PTC（官方 v2→v3：tool/code-dispatch-start
            // → tool/ptc-dispatch-start，tool/code-dispatch → tool/ptc-dispatch），
            // 载荷不变；两个名字都要接纳，否则升级后子工具调用会整段消失。
            "tool/code-dispatch-start" | "tool/ptc-dispatch-start" => {
                // 官方子工具（code dispatch）：callId=subCallId，parentCallId=父调用，
                // arguments 是对象（官方 JSON.stringify 后入树）。
                let call_id = data
                    .get("subCallId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let parent_call_id = data
                    .get("parentCallId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let input = data.get("arguments").and_then(json_text);
                if let Some(call_id) = &call_id {
                    if let Some(name) = data.get("name").and_then(Value::as_str) {
                        tool_names.insert(call_id.clone(), name.to_string());
                        if let Some(coordinate) = trace.turn.zip(trace.step).or(Some((0, 0))) {
                            open_tools.insert(call_id.clone(), coordinate);
                        }
                    }
                    if let Some(started) = event_time {
                        tool_started_at.insert(call_id.clone(), started);
                    }
                }
                trace.call_id = call_id;
                trace.parent_call_id = parent_call_id;
                trace.input = input.clone();
                push_event(
                    &mut timeline,
                    seq,
                    "tool-call",
                    timestamp,
                    data.get("name").and_then(Value::as_str).map(str::to_string),
                    input,
                    None,
                    None,
                    None,
                    None,
                    Some(trace),
                    None,
                );
            }
            "tool/code-dispatch" | "tool/ptc-dispatch" => {
                // 子工具结果：content 为 ContentBlock[]；isError 投影为 error 状态。
                let call_id = data
                    .get("subCallId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let parent_call_id = data
                    .get("parentCallId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let output = data
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter_map(content_block_text)
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .filter(|text| !text.is_empty());
                let is_error = data
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if let Some(call_id) = &call_id {
                    open_tools.remove(call_id);
                }
                let duration_ms = call_id
                    .as_ref()
                    .and_then(|call_id| tool_started_at.get(call_id).copied())
                    .zip(event_time)
                    .map(|(started, ended)| ended.saturating_sub(started))
                    .or(fallback_duration_ms);
                let title = call_id
                    .as_ref()
                    .and_then(|call_id| tool_names.get(call_id))
                    .cloned();
                trace.call_id = call_id;
                trace.parent_call_id = parent_call_id;
                trace.output = output.clone();
                push_event(
                    &mut timeline,
                    seq,
                    "tool-result",
                    timestamp,
                    title,
                    output,
                    None,
                    None,
                    duration_ms,
                    None,
                    Some(trace),
                    is_error.then(|| "error".to_string()),
                );
            }
            // 官方 v2 起把未产出 surface message 的失败/取消尝试记录为
            // `assistant/attempt`（内嵌 stream 保存 usage 与 finish 原因）。
            // 投影为 error 行，否则用户只看到「这一轮什么都没有」。
            "assistant/attempt" => {
                let attempt_usage =
                    native_usage(data.pointer("/stream/0/chunk/usage")).or_else(|| {
                        data.get("stream")
                            .and_then(Value::as_array)
                            .and_then(|stream| {
                                stream
                                    .iter()
                                    .find_map(|item| native_usage(item.pointer("/chunk/usage")))
                            })
                    });
                if let Some(value) = &attempt_usage {
                    add_usage(&mut total, value);
                }
                let failure = data
                    .get("stream")
                    .and_then(Value::as_array)
                    .and_then(|stream| {
                        stream
                            .iter()
                            .find_map(|item| item.pointer("/chunk/reason/failure").map(json_text))
                    })
                    .flatten();
                let interrupted = data
                    .get("interrupted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let status = if interrupted { "cancelled" } else { "error" };
                let title = if interrupted {
                    "Attempt cancelled"
                } else {
                    "Attempt failed"
                };
                push_event(
                    &mut timeline,
                    seq,
                    "error",
                    timestamp,
                    Some(title.to_string()),
                    failure,
                    None,
                    attempt_usage,
                    None,
                    None,
                    Some(trace),
                    Some(status.to_string()),
                );
            }
            "request/header" => {
                let header = data.get("header").unwrap_or(&Value::Null);
                trace.provider = header
                    .pointer("/config/provider")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                trace.system_prompt = header
                    .get("system")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                trace.tools = header.get("tools").and_then(json_text);
                let model = header
                    .pointer("/config/model")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let config = header.get("config").and_then(json_text);
                trace.input = config.clone();
                let prompt_changed = trace
                    .system_prompt
                    .as_ref()
                    .is_some_and(|prompt| last_system_prompt.as_ref() != Some(prompt));
                if !prompt_changed {
                    continue;
                }
                let initial_prompt = last_system_prompt.is_none();
                last_system_prompt = trace.system_prompt.clone();
                push_event(
                    &mut timeline,
                    seq,
                    "request",
                    timestamp,
                    Some(
                        if initial_prompt {
                            "Initial System Prompt"
                        } else {
                            "System Prompt Updated"
                        }
                        .to_string(),
                    ),
                    None,
                    model,
                    None,
                    Some(0),
                    None,
                    Some(trace),
                    None,
                );
            }
            // These are transport/request facts, not durable trajectory rows.
            // Visible context comes from non-user `user/message` records.
            "request/context" | "agent/inbox/spliced" => {}
            _ => {}
        }
    }
    // 文件收尾时仍未闭合的工具调用（异常退出等）→ 合成中断结果。
    let last_seq = records
        .last()
        .and_then(|v| v.get("seq"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let last_time = records
        .last()
        .and_then(|v| v.get("time"))
        .and_then(Value::as_i64);
    close_interrupted_tools(
        &mut timeline,
        &mut open_tools,
        &tool_names,
        &tool_started_at,
        last_seq,
        last_time,
        None,
    );
    timeline.turn_count = visible_turns.len() as i64 + unlocated_assistant_count;
    if total.total_tokens > 0 {
        timeline.usage = Some(total);
    }
    Ok(timeline)
}

/// 合成“被打断”的工具结果：DSH 官方在 step/turn 关闭或会话结束时，为仍未收到
/// result 的 callId 生成 `{isError, error:{name:"Interrupted", code:"interrupted"}}`
/// 记录。这里投影为 status=error 的 tool-result 事件，供轨迹视图合并到调用行。
fn close_interrupted_tools(
    timeline: &mut AgentSessionTimeline,
    open_tools: &mut HashMap<String, (i64, i64)>,
    tool_names: &HashMap<String, String>,
    tool_started_at: &HashMap<String, i64>,
    at_seq: i64,
    at_time: Option<i64>,
    within: Option<(i64, i64)>,
) {
    // within: Some((turn, step)) 仅闭合该步骤；Some((turn, i64::MAX)) 闭合该轮次；None 全部。
    let pending: Vec<String> = open_tools
        .iter()
        .filter(|(_, coordinate)| match within {
            Some((w_turn, w_step)) => w_turn == coordinate.0 && coordinate.1 <= w_step,
            None => true,
        })
        .map(|(call_id, _)| call_id.clone())
        .collect();
    for call_id in pending {
        open_tools.remove(&call_id);
        let started = tool_started_at.get(&call_id).copied();
        let name = tool_names
            .get(&call_id)
            .cloned()
            .unwrap_or_else(|| "Tool".to_string());
        let mut trace = AgentSessionTrace {
            sequence: at_seq,
            event_type: "tool/result".to_string(),
            turn: None,
            step: None,
            call_id: Some(call_id),
            parent_call_id: None,
            provider: None,
            request_reason: Some("interrupted".to_string()),
            input: None,
            output: Some("Interrupted".to_string()),
            system_prompt: None,
            tools: None,
            source_kind: None,
            source_form: None,
            producer: None,
        };
        if let Some((turn, step)) = within {
            if step != i64::MAX {
                trace.turn = Some(turn);
                trace.step = Some(step);
            } else {
                trace.turn = Some(turn);
            }
        }
        push_event(
            timeline,
            at_seq,
            "tool-result",
            at_time.map(millis_time),
            Some(name),
            None,
            None,
            None,
            started
                .zip(at_time)
                .map(|(started, ended)| ended.saturating_sub(started)),
            None,
            Some(trace),
            Some("error".to_string()),
        );
    }
}

/// 压缩总结正文：拼接 summary 中面向模型展示的 text 块（真实形状见
/// `compaction/summary.summary`，含 `## Primary Request and Intent` 等）。
fn compaction_summary_text(data: &Value) -> Option<String> {
    data.get("summary")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.is_empty())
}

fn push_event(
    timeline: &mut AgentSessionTimeline,
    seq: i64,
    kind: &str,
    timestamp: Option<String>,
    title: Option<String>,
    content: Option<String>,
    model: Option<String>,
    usage: Option<AgentSessionNativeUsage>,
    duration_ms: Option<i64>,
    time_to_first_token_ms: Option<i64>,
    trace: Option<AgentSessionTrace>,
    status: Option<String>,
) {
    timeline.events.push(AgentSessionTimelineEvent {
        id: format!("dsh-{seq}-{kind}"),
        kind: kind.to_string(),
        source: "agent-native".to_string(),
        timestamp,
        title,
        content,
        model,
        status,
        duration_ms,
        time_to_first_token_ms,
        usage,
        trace,
    });
}

fn trace_from(sequence: i64, event_type: &str, data: &Value) -> AgentSessionTrace {
    AgentSessionTrace {
        sequence,
        event_type: event_type.to_string(),
        turn: data.get("turn").and_then(Value::as_i64),
        step: data.get("step").and_then(Value::as_i64),
        call_id: data
            .get("callId")
            .or_else(|| data.pointer("/message/source/callId"))
            .or_else(|| data.pointer("/message/content/0/toolCallId"))
            .and_then(Value::as_str)
            .map(str::to_string),
        parent_call_id: data
            .get("parentCallId")
            .and_then(Value::as_str)
            .map(str::to_string),
        provider: None,
        request_reason: data
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_string),
        input: None,
        output: None,
        system_prompt: None,
        tools: None,
        source_kind: None,
        source_form: None,
        producer: None,
    }
}

fn json_text(value: &Value) -> Option<String> {
    if value.is_null() {
        None
    } else if let Some(text) = value.as_str() {
        Some(text.to_string())
    } else {
        serde_json::to_string_pretty(value).ok()
    }
}

fn message_block_text(value: &Value, block_type: &str) -> Option<String> {
    value
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some(block_type))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.is_empty())
}

fn message_text(value: &Value) -> Option<String> {
    value
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(content_block_text)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.is_empty())
}

fn content_block_text(block: &Value) -> Option<String> {
    block
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            block.get("content").and_then(|content| {
                content.as_str().map(str::to_string).or_else(|| {
                    content.as_array().map(|nested| {
                        nested
                            .iter()
                            .filter_map(content_block_text)
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                })
            })
        })
        .filter(|text| !text.is_empty())
}

fn native_usage(value: Option<&Value>) -> Option<AgentSessionNativeUsage> {
    let value = value?;
    let input = value
        .get("inputTokens")
        .or_else(|| value.get("input"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let cached = value
        .get("cacheReadTokens")
        .or_else(|| value.get("cacheRead"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let write = value
        .get("cacheWriteTokens")
        .or_else(|| value.get("cacheWrite"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let output = value
        .get("outputTokens")
        .or_else(|| value.get("output"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let reasoning = value
        .get("reasoningTokens")
        .or_else(|| value.get("reasoning"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    // DSH TokenUsage 将 uncached input、cache read、cache write 分开计数；reasoning
    // 是 output 的细分，不再额外叠加到总量。
    let total_tokens = input + cached + write + output;
    (total_tokens > 0 || cached > 0 || write > 0).then_some(AgentSessionNativeUsage {
        input_tokens: input,
        cached_input_tokens: cached,
        cache_write_input_tokens: write,
        output_tokens: output,
        reasoning_tokens: reasoning,
        total_tokens,
        cost: None,
        cost_currency: None,
        api_equivalent: None,
    })
}

fn add_usage(total: &mut AgentSessionNativeUsage, value: &AgentSessionNativeUsage) {
    total.input_tokens += value.input_tokens;
    total.cached_input_tokens += value.cached_input_tokens;
    total.cache_write_input_tokens += value.cache_write_input_tokens;
    total.output_tokens += value.output_tokens;
    total.reasoning_tokens += value.reasoning_tokens;
    total.total_tokens += value.total_tokens;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_the_latest_native_session_title() {
        let records = vec![
            serde_json::json!({"type":"session","version":0}),
            serde_json::json!({"type":"session/title","seq":10,"data":{"title":"我开始怀疑我为啥要做这个项目了"}}),
            serde_json::json!({"type":"session/title","seq":14,"data":{"title":"开始怀疑项目价值意义"}}),
        ];

        assert_eq!(
            native_session_title(&records).as_deref(),
            Some("开始怀疑项目价值意义")
        );
    }

    #[test]
    fn projects_native_context_and_hides_transport_only_records() {
        let records = vec![
            serde_json::json!({"type":"session","version":0,"id":"session-context","createdAt":1_700_000_000_000i64}),
            serde_json::json!({"type":"agent/inbox/spliced","seq":3,"time":1_700_000_000_001i64,"data":{"inserted":[]}}),
            serde_json::json!({"type":"turn/start","seq":4,"time":1_700_000_000_002i64,"data":{"turn":1}}),
            serde_json::json!({"type":"step/start","seq":6,"time":1_700_000_000_003i64,"data":{"turn":1,"step":1}}),
            serde_json::json!({"type":"user/message","seq":7,"time":1_700_000_000_004i64,"data":{"source":{"kind":"user"},"content":[{"type":"text","text":"question"}]}}),
            serde_json::json!({"type":"user/message","seq":8,"time":1_700_000_000_005i64,"data":{"source":{"kind":"agent-instructions"},"content":[{"type":"text","text":"workspace instructions"}]}}),
            serde_json::json!({"type":"request/header","seq":11,"time":1_700_000_000_006i64,"data":{"header":{"config":{"provider":"flowlet","model":"flowlet-pro"},"system":"system"}}}),
            serde_json::json!({"type":"request/context","seq":12,"time":1_700_000_000_007i64,"data":{"provider":"flowlet"}}),
            serde_json::json!({"type":"assistant/message","seq":20,"time":1_700_000_000_103i64,"data":{"turn":1,"step":1,"content":[{"type":"text","text":"answer"}]}}),
        ];

        let timeline = read_timeline_records(&records).unwrap();
        assert_eq!(timeline.turn_count, 1);
        assert_eq!(
            timeline
                .events
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec![
                "turn",
                "user-message",
                "context",
                "request",
                "assistant-message",
            ]
        );
        // 轮次状态事件位于轮次起点：turn=1、status=running（文件内无 turn/end）。
        assert_eq!(timeline.events[0].kind, "turn");
        assert_eq!(timeline.events[0].status.as_deref(), Some("running"));
        assert_eq!(timeline.events[0].trace.as_ref().unwrap().turn, Some(1));
        assert_eq!(timeline.events[1].trace.as_ref().unwrap().turn, Some(1));
        assert_eq!(timeline.events[2].trace.as_ref().unwrap().step, Some(1));
        assert_eq!(timeline.events[4].duration_ms, Some(100));
    }

    #[test]
    fn turn_end_reasons_project_turn_statuses() {
        let records = vec![
            serde_json::json!({"type":"session","version":0,"id":"session-status","createdAt":1_700_000_000_000i64}),
            serde_json::json!({"type":"turn/start","seq":1,"time":1_700_000_000_010i64,"data":{"turn":1}}),
            serde_json::json!({"type":"assistant/message","seq":2,"time":1_700_000_000_020i64,"data":{"turn":1,"step":1,"content":[{"type":"text","text":"ok"}]}}),
            serde_json::json!({"type":"turn/end","seq":3,"time":1_700_000_000_030i64,"data":{"turn":1,"reason":{"kind":"completed"}}}),
            serde_json::json!({"type":"turn/start","seq":4,"time":1_700_000_000_040i64,"data":{"turn":2}}),
            serde_json::json!({"type":"turn/end","seq":5,"time":1_700_000_000_050i64,"data":{"turn":2,"reason":{"kind":"aborted","user":true}}}),
            serde_json::json!({"type":"turn/start","seq":6,"time":1_700_000_000_060i64,"data":{"turn":3}}),
            serde_json::json!({"type":"turn/end","seq":7,"time":1_700_000_000_070i64,"data":{"turn":3,"reason":{"kind":"error","error":{"message":"boom","code":"E"}}}}),
            serde_json::json!({"type":"turn/start","seq":8,"time":1_700_000_000_080i64,"data":{"turn":4}}),
            serde_json::json!({"type":"turn/end","seq":9,"time":1_700_000_000_090i64,"data":{"turn":4,"reason":{"kind":"max-tokens"}}}),
            serde_json::json!({"type":"turn/start","seq":10,"time":1_700_000_000_100i64,"data":{"turn":5}}),
        ];

        let timeline = read_timeline_records(&records).unwrap();
        let turns: Vec<_> = timeline
            .events
            .iter()
            .filter(|event| event.kind == "turn")
            .map(|event| {
                (
                    event.status.clone().unwrap_or_default(),
                    event.duration_ms,
                    event.content.clone().unwrap_or_default(),
                )
            })
            .collect();
        assert_eq!(
            turns,
            vec![
                ("completed".to_string(), Some(20), String::new()),
                ("cancelled".to_string(), Some(10), String::new()),
                ("error".to_string(), Some(10), "boom".to_string()),
                ("max-tokens".to_string(), Some(10), String::new()),
                ("running".to_string(), None, String::new()),
            ]
        );
    }

    #[test]
    fn compaction_projects_compacted_row_and_skips_checkpoint() {
        // 形状来自真实会话（compaction/start 带 turn；checkpoint 是
        // source.plugin == "compact" 的 user/message，后随 compaction/end）。
        let records = vec![
            serde_json::json!({"type":"session","version":0,"id":"session-compact","createdAt":1_784_998_000_000i64}),
            serde_json::json!({"type":"turn/start","seq":1,"time":1_784_998_000_010i64,"data":{"turn":8}}),
            serde_json::json!({"type":"compaction/start","seq":2,"time":1_784_998_000_020i64,"data":{"compactionId":"cc-1","turn":8}}),
            serde_json::json!({"type":"compaction/summary","seq":3,"time":1_784_998_040_000i64,"data":{"compactionId":"cc-1","summary":[{"type":"text","text":"## Primary Request and Intent\n- original goal"}],"rawOutput":[{"type":"reasoning","text":"condense"}],"llmStreamCall":true,"shadowedSeqs":[1,2],"shadowedTokenCount":100,"provider":"flowlet","model":"flowlet-pro","usage":{"inputTokens":10,"outputTokens":5}}}),
            serde_json::json!({"type":"user/message","seq":4,"time":1_784_998_040_001i64,"data":{"content":[{"type":"text","text":"<compacted-summary>"}],"source":{"kind":"plugin","plugin":"compact","compactionId":"cc-1"},"role":"user","id":"checkpoint"},"sourceEventSeqs":[1,2],"surfaceOp":{"op":"replace","start":1,"end":2}}),
            serde_json::json!({"type":"compaction/end","seq":5,"time":1_784_998_040_001i64,"data":{"compactionId":"cc-1","turn":8}}),
            serde_json::json!({"type":"turn/end","seq":6,"time":1_784_998_040_002i64,"data":{"turn":8,"reason":{"kind":"completed"}}}),
        ];

        let timeline = read_timeline_records(&records).unwrap();
        assert_eq!(timeline.turn_count, 1);
        let kinds: Vec<_> = timeline
            .events
            .iter()
            .map(|event| event.kind.as_str())
            .collect();
        // checkpt user/message 不产生独立的 context 行。
        assert_eq!(kinds, vec!["turn", "compacted"]);
        let compacted = &timeline.events[1];
        assert_eq!(compacted.kind, "compacted");
        assert_eq!(
            compacted.content.as_deref().unwrap(),
            "## Primary Request and Intent\n- original goal"
        );
        assert_eq!(compacted.trace.as_ref().unwrap().turn, Some(8));
        assert_eq!(
            compacted.trace.as_ref().unwrap().output.as_deref().unwrap(),
            "## Primary Request and Intent\n- original goal"
        );
        assert_eq!(compacted.duration_ms, Some(39_980));
        let usage = compacted.usage.as_ref().unwrap();
        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.output_tokens, 5);
        // 压缩用量不计入会话总用量（shadowed 事件已在其时点计费）。
        assert!(timeline.usage.is_none());
    }

    #[test]
    fn unclosed_tool_at_step_end_gets_interrupted_closure() {
        let records = vec![
            serde_json::json!({"type":"session","version":0,"id":"session-interrupt","createdAt":1_700_000_000_000i64}),
            serde_json::json!({"type":"turn/start","seq":1,"time":1_700_000_000_010i64,"data":{"turn":1}}),
            serde_json::json!({"type":"step/start","seq":2,"time":1_700_000_000_020i64,"data":{"turn":1,"step":1}}),
            serde_json::json!({"type":"tool/call","seq":3,"time":1_700_000_000_030i64,"data":{"turn":1,"step":1,"callId":"call-1","name":"read_file","arguments":"{}"}}),
            serde_json::json!({"type":"step/end","seq":4,"time":1_700_000_000_050i64,"data":{"turn":1,"step":1}}),
            serde_json::json!({"type":"turn/end","seq":5,"time":1_700_000_000_060i64,"data":{"turn":1,"reason":{"kind":"aborted","user":true}}}),
        ];

        let timeline = read_timeline_records(&records).unwrap();
        let interrupted = timeline
            .events
            .iter()
            .find(|event| {
                event.kind == "tool-result"
                    && event.trace.as_ref().and_then(|t| t.call_id.as_deref()) == Some("call-1")
            })
            .unwrap();
        assert_eq!(interrupted.kind, "tool-result");
        assert_eq!(interrupted.status.as_deref(), Some("error"));
        assert_eq!(interrupted.title.as_deref(), Some("read_file"));
        assert_eq!(
            interrupted
                .trace
                .as_ref()
                .and_then(|trace| trace.request_reason.as_deref()),
            Some("interrupted")
        );
        assert_eq!(interrupted.duration_ms, Some(20));
    }

    #[test]
    fn chunk_streams_provide_ttft_and_step_duration() {
        let records = vec![
            serde_json::json!({"type":"session","version":0,"id":"session-ttft","createdAt":1_700_000_000_000i64}),
            serde_json::json!({"type":"turn/start","seq":1,"time":1_700_000_000_010i64,"data":{"turn":1}}),
            serde_json::json!({"type":"step/start","seq":2,"time":1_700_000_000_020i64,"data":{"turn":1,"step":1}}),
            serde_json::json!({"type":"assistant/chunk","seq":3,"time":1_700_000_000_100i64,"data":{"turn":1,"step":1,"chunk":{"type":"text-delta","text":"he"}}}),
            serde_json::json!({"type":"assistant/chunk","seq":4,"time":1_700_000_000_120i64,"data":{"turn":1,"step":1,"chunk":{"type":"text-delta","text":"llo"}}}),
            serde_json::json!({"type":"assistant/chunk","seq":5,"time":1_700_000_000_500i64,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":0,"outputTokens":0}}}}),
            serde_json::json!({"type":"assistant/message","seq":6,"time":1_700_000_000_520i64,"data":{"turn":1,"step":1,"content":[{"type":"text","text":"hello"}],"usage":{"inputTokens":10,"outputTokens":2}}}),
            serde_json::json!({"type":"step/end","seq":7,"time":1_700_000_000_530i64,"data":{"turn":1,"step":1}}),
            serde_json::json!({"type":"turn/end","seq":8,"time":1_700_000_000_540i64,"data":{"turn":1,"reason":{"kind":"completed"}}}),
        ];

        let timeline = read_timeline_records(&records).unwrap();
        let message = timeline
            .events
            .iter()
            .find(|event| event.kind == "assistant-message")
            .unwrap();
        // TTFT = 首个文本 delta(100) − step/start(20) = 80ms；时长 = message(520) − 20 = 500ms
        assert_eq!(message.time_to_first_token_ms, Some(80));
        assert_eq!(message.duration_ms, Some(500));
    }

    #[test]
    fn packed_chunk_rows_provide_ttft() {
        // 官方打包形态：同块 delta 合并为 text-chunks 存储行（顶层 seq0/time0，无 data.chunk）。
        let records = vec![
            serde_json::json!({"type":"session","version":0,"id":"session-packed","createdAt":1_700_000_000_000i64}),
            serde_json::json!({"type":"turn/start","seq":1,"time":1_700_000_000_010i64,"data":{"turn":1}}),
            serde_json::json!({"type":"step/start","seq":2,"time":1_700_000_000_020i64,"data":{"turn":1,"step":1}}),
            serde_json::json!({"type":"reasoning-chunks","seq0":3,"time0":1_700_000_000_090i64,"data":{"turn":1,"step":1,"index":0,"dt":[0,30],"texts":["think"]}}),
            serde_json::json!({"type":"text-chunks","seq0":4,"time0":1_700_000_000_110i64,"data":{"turn":1,"step":1,"index":0,"dt":[0,20],"texts":["he","llo"]}}),
            serde_json::json!({"type":"assistant/message","seq":6,"time":1_700_000_000_520i64,"data":{"turn":1,"step":1,"content":[{"type":"text","text":"hello"}],"usage":{"inputTokens":10,"outputTokens":2}}}),
            serde_json::json!({"type":"step/end","seq":7,"time":1_700_000_000_530i64,"data":{"turn":1,"step":1}}),
            serde_json::json!({"type":"turn/end","seq":8,"time":1_700_000_000_540i64,"data":{"turn":1,"reason":{"kind":"completed"}}}),
        ];

        let timeline = read_timeline_records(&records).unwrap();
        let message = timeline
            .events
            .iter()
            .find(|event| event.kind == "assistant-message")
            .unwrap();
        // 首 token = 流中最早出现的内容包（reasoning-chunks time0=90）− step/start(20) = 70ms
        assert_eq!(message.time_to_first_token_ms, Some(70));
        assert_eq!(message.duration_ms, Some(500));
    }

    #[test]
    fn context_provenance_carries_kind_form_and_producer() {
        let records = vec![
            serde_json::json!({"type":"session","version":0,"id":"session-provenance","createdAt":1_700_000_000_000i64}),
            serde_json::json!({"type":"turn/start","seq":1,"time":1_700_000_000_010i64,"data":{"turn":1}}),
            serde_json::json!({"type":"user/message","seq":2,"time":1_700_000_000_020i64,"data":{"content":[{"type":"text","text":"instructions"}],"source":{"kind":"agent-instructions","form":"instructions","baseline":true,"changes":[{"action":"set","scope":".\u{0}AGENTS.md","path":"AGENTS.md"},{"action":"set","path":"CLAUDE.md"}]},"role":"user","id":"m1"}}),
            serde_json::json!({"type":"user/message","seq":3,"time":1_700_000_000_030i64,"data":{"content":[{"type":"text","text":"skill"}],"source":{"kind":"plugin","plugin":"dsh-skill","form":"instructions"},"role":"user","id":"m2"}}),
            serde_json::json!({"type":"user/message","seq":4,"time":1_700_000_000_040i64,"data":{"content":[{"type":"text","text":"问题"}],"source":{"kind":"user"},"role":"user","id":"m3"}}),
        ];

        let timeline = read_timeline_records(&records).unwrap();
        let contexts: Vec<_> = timeline
            .events
            .iter()
            .filter(|event| event.kind == "context")
            .collect();
        assert_eq!(contexts.len(), 2);
        let instructions = contexts[0].trace.as_ref().unwrap();
        assert_eq!(
            instructions.source_kind.as_deref(),
            Some("agent-instructions")
        );
        assert_eq!(instructions.source_form.as_deref(), Some("instructions"));
        assert_eq!(
            instructions.producer.as_deref(),
            Some("AGENTS.md, CLAUDE.md")
        );
        let skill = contexts[1].trace.as_ref().unwrap();
        assert_eq!(skill.source_kind.as_deref(), Some("plugin"));
        assert_eq!(skill.producer.as_deref(), Some("dsh-skill"));
    }

    #[test]
    fn next_step_inbox_claim_marks_steering() {
        // next-step splice 采纳 pending 中的消息 → 该 user/message 走 user 分支并标记 steering。
        let records = vec![
            serde_json::json!({"type":"session","version":0,"id":"session-steer","createdAt":1_700_000_000_000i64}),
            serde_json::json!({"type":"turn/start","seq":1,"time":1_700_000_000_010i64,"data":{"turn":1}}),
            serde_json::json!({"type":"agent/inbox/spliced","seq":2,"time":1_700_000_000_020i64,"data":{"target":"next-step","start":0,"removedCount":0,"inserted":[{"id":"m1"}]}}),
            serde_json::json!({"type":"agent/inbox/spliced","seq":3,"time":1_700_000_000_030i64,"data":{"target":"next-step","start":0,"removedCount":1,"inserted":[]}}),
            serde_json::json!({"type":"agent/inbox/spliced","seq":4,"time":1_700_000_000_040i64,"data":{"target":"next-step","start":0,"removedCount":0,"inserted":[{"id":"m2"}]}}),
            serde_json::json!({"type":"user/message","seq":5,"time":1_700_000_000_050i64,"data":{"content":[{"type":"text","text":"继续"}],"source":{"kind":"user"},"role":"user","id":"m1"}}),
            serde_json::json!({"type":"user/message","seq":6,"time":1_700_000_000_060i64,"data":{"content":[{"type":"text","text":"排队未采纳"}],"source":{"kind":"user"},"role":"user","id":"m2"}}),
        ];

        let timeline = read_timeline_records(&records).unwrap();
        let messages: Vec<_> = timeline
            .events
            .iter()
            .filter(|event| event.kind == "user-message")
            .collect();
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0]
                .trace
                .as_ref()
                .and_then(|t| t.request_reason.as_deref()),
            Some("steering")
        );
        // m2 仍留在 pending，未被采纳 → 不标记。
        assert_eq!(
            messages[1]
                .trace
                .as_ref()
                .and_then(|t| t.request_reason.as_deref()),
            None
        );
    }

    #[test]
    fn llm_retry_projects_model_retry_event() {
        let records = vec![
            serde_json::json!({"type":"session","version":0,"id":"session-retry","createdAt":1_700_000_000_000i64}),
            serde_json::json!({"type":"turn/start","seq":1,"time":1_700_000_000_010i64,"data":{"turn":1}}),
            serde_json::json!({"type":"step/start","seq":2,"time":1_700_000_000_020i64,"data":{"turn":1,"step":1}}),
            serde_json::json!({"type":"llm/retry","seq":3,"time":1_700_000_000_030i64,"data":{"retryId":"r1","turn":1,"step":1,"provider":"flowlet","mode":"normal","retry":1,"maxRetries":2,"delayMs":463.34,"failure":{"message":"429 status code (no body)","code":"RATE_LIMIT"}}}),
            serde_json::json!({"type":"assistant/message","seq":4,"time":1_700_000_000_300i64,"data":{"turn":1,"step":1,"content":[{"type":"text","text":"ok"}],"usage":{"inputTokens":10,"outputTokens":2}}}),
            serde_json::json!({"type":"step/end","seq":5,"time":1_700_000_000_310i64,"data":{"turn":1,"step":1}}),
            serde_json::json!({"type":"turn/end","seq":6,"time":1_700_000_000_320i64,"data":{"turn":1,"reason":{"kind":"completed"}}}),
        ];

        let timeline = read_timeline_records(&records).unwrap();
        let retry = timeline
            .events
            .iter()
            .find(|event| event.kind == "model-retry")
            .unwrap();
        assert_eq!(retry.title.as_deref(), Some("retry 1/2 · 463 ms"));
        // origin 序列化无保留键序（serde_json Value 默认按字母序），断言关键内容即可。
        let failure = retry.content.as_deref().unwrap();
        assert!(failure.contains("RATE_LIMIT"), "实际内容: {failure}");
        assert!(failure.contains("429 status code"), "实际内容: {failure}");
        assert_eq!(retry.trace.as_ref().unwrap().turn, Some(1));
        assert_eq!(retry.trace.as_ref().unwrap().step, Some(1));
        assert_eq!(
            retry.trace.as_ref().unwrap().provider.as_deref(),
            Some("flowlet")
        );
        // 事件顺序：model-retry 在 assistant-message 之前（原记录顺序）。
        let positions: Vec<_> = timeline
            .events
            .iter()
            .map(|event| event.kind.as_str())
            .collect();
        assert_eq!(positions, vec!["turn", "model-retry", "assistant-message"]);
    }

    #[test]
    fn approval_asked_decided_project_history_rows() {
        let records = vec![
            serde_json::json!({"type":"session","version":0,"id":"session-approval","createdAt":1_700_000_000_000i64}),
            serde_json::json!({"type":"turn/start","seq":1,"time":1_700_000_000_010i64,"data":{"turn":1}}),
            serde_json::json!({"type":"approval/asked","seq":2,"time":1_700_000_000_020i64,"data":{"id":"ap-1","toolName":"bash","callId":"call-9","reason":"run chmod +x deploy.sh"}}),
            serde_json::json!({"type":"approval/decided","seq":3,"time":1_700_000_000_030i64,"data":{"id":"ap-1","outcome":"allowed-once"}}),
            serde_json::json!({"type":"turn/end","seq":4,"time":1_700_000_000_040i64,"data":{"turn":1,"reason":{"kind":"completed"}}}),
        ];

        let timeline = read_timeline_records(&records).unwrap();
        let approvals: Vec<_> = timeline
            .events
            .iter()
            .filter(|event| event.kind == "approval")
            .collect();
        assert_eq!(approvals.len(), 1, "decided 应回写同一行而不是新增");
        let approval = approvals[0];
        assert_eq!(approval.title.as_deref(), Some("bash"));
        assert_eq!(approval.content.as_deref(), Some("run chmod +x deploy.sh"));
        assert_eq!(approval.status.as_deref(), Some("allowed-once"));
        assert_eq!(
            approval
                .trace
                .as_ref()
                .and_then(|t| t.request_reason.as_deref()),
            Some("ap-1")
        );
    }

    #[test]
    fn code_dispatch_projects_subtool_rows() {
        let records = vec![
            serde_json::json!({"type":"session","version":0,"id":"session-dispatch","createdAt":1_700_000_000_000i64}),
            serde_json::json!({"type":"turn/start","seq":1,"time":1_700_000_000_010i64,"data":{"turn":1}}),
            serde_json::json!({"type":"step/start","seq":2,"time":1_700_000_000_020i64,"data":{"turn":1,"step":1}}),
            serde_json::json!({"type":"tool/call","seq":3,"time":1_700_000_000_030i64,"data":{"turn":1,"step":1,"callId":"call-1","name":"apply_patch","arguments":"{\"patch\":\"diff\"}"}}),
            serde_json::json!({"type":"tool/code-dispatch-start","seq":4,"time":1_700_000_000_040i64,"data":{"rootCallId":"call-1","parentCallId":"call-1","subCallId":"sub-1","name":"write_file","arguments":{"path":"a.txt","content":"x"}}}),
            serde_json::json!({"type":"tool/code-dispatch","seq":5,"time":1_700_000_000_060i64,"data":{"rootCallId":"call-1","parentCallId":"call-1","subCallId":"sub-1","name":"write_file","isError":false,"content":[{"type":"text","text":"wrote a.txt"}]}}),
            serde_json::json!({"type":"tool/result","seq":6,"time":1_700_000_000_070i64,"data":{"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":"call-1"},"content":[{"type":"tool-result","toolCallId":"call-1","content":[{"type":"text","text":"done"}]}]}}}),
            serde_json::json!({"type":"step/end","seq":7,"time":1_700_000_000_080i64,"data":{"turn":1,"step":1}}),
            serde_json::json!({"type":"turn/end","seq":8,"time":1_700_000_000_090i64,"data":{"turn":1,"reason":{"kind":"completed"}}}),
        ];

        let timeline = read_timeline_records(&records).unwrap();
        let sub_call = timeline
            .events
            .iter()
            .find(|event| event.trace.as_ref().and_then(|t| t.call_id.as_deref()) == Some("sub-1"))
            .expect("应有子工具 call");
        assert_eq!(sub_call.kind, "tool-call");
        assert_eq!(sub_call.title.as_deref(), Some("write_file"));
        assert_eq!(
            sub_call
                .trace
                .as_ref()
                .and_then(|t| t.parent_call_id.as_deref()),
            Some("call-1")
        );
        assert!(
            sub_call.content.as_deref().unwrap().contains("\"path\""),
            "arguments 应 JSON 化: {:?}",
            sub_call.content
        );
        let sub_result = timeline
            .events
            .iter()
            .find(|event| {
                event.kind == "tool-result"
                    && event.trace.as_ref().and_then(|t| t.call_id.as_deref()) == Some("sub-1")
            })
            .expect("应有子工具 result");
        assert_eq!(sub_result.content.as_deref(), Some("wrote a.txt"));
        assert_eq!(sub_result.duration_ms, Some(20));
        assert_eq!(sub_result.status, None);
    }

    #[test]
    fn torn_plaintext_tail_keeps_committed_prefix() {
        let dir = std::env::temp_dir().join(format!("dsh-torn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"session\",\"version\":0,\"id\":\"torn\",\"createdAt\":1}\n\
             {\"type\":\"turn/start\",\"seq\":1,\"time\":2,\"data\":{\"turn\":1}}\n\
             {\"type\":\"assistant/message\",\"seq\":2,\"time\":3,\"data\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}\n\
             {\"type\":\"assistant/message\",\"se",
        )
        .unwrap();
        let records = read_records(&path).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].get("id").and_then(Value::as_str), Some("torn"));
        assert_eq!(records[2].get("seq").and_then(Value::as_i64), Some(2));
    }

    #[test]
    fn zstd_frame_walker_finds_complete_frames_and_torn_tail() {
        let jsonl =
            b"{\"type\":\"session\",\"version\":0,\"id\":\"frame\",\"createdAt\":1}\n{\"type\":\"turn/start\",\"seq\":1,\"time\":2,\"data\":{\"turn\":1}}\n";
        let encoded = zstd::stream::encode_all(Cursor::new(&jsonl[..]), 3).unwrap();
        let (frames, torn) = zstd_frame_ranges(&encoded);
        assert_eq!(torn, None);
        assert_eq!(frames, vec![(0, encoded.len())]);

        // 撕裂尾部：完整帧后追加一个不完整的 zstd 帧头。
        let torn_bytes = [&encoded[..], &[0x28, 0xB5, 0x2F, 0xFD, 0x00][..]].concat();
        let (frames, torn) = zstd_frame_ranges(&torn_bytes);
        assert_eq!(frames, vec![(0, encoded.len())]);
        assert_eq!(torn, Some(encoded.len()));
    }

    #[test]
    fn torn_zstd_tail_decodes_committed_frames() {
        let jsonl = "{\"type\":\"session\",\"version\":0,\"id\":\"zstd-torn\",\"createdAt\":1}\n\
                     {\"type\":\"turn/start\",\"seq\":1,\"time\":2,\"data\":{\"turn\":1}}\n";
        let encoded = zstd::stream::encode_all(Cursor::new(jsonl.as_bytes()), 3).unwrap();
        let dir = std::env::temp_dir().join(format!("dsh-zstd-torn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl.zstd");
        std::fs::write(&path, [&encoded[..], b"garbage-tail"].concat()).unwrap();
        let records = read_records(&path).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(records.len(), 2);
        assert_eq!(
            records[0].get("id").and_then(Value::as_str),
            Some("zstd-torn")
        );
    }

    #[test]
    fn parses_committed_messages_tools_and_disjoint_usage() {
        let records = vec![
            serde_json::json!({"type":"session","version":0,"id":"session-1","createdAt":1_700_000_000_000i64,"cwd":"C:/repo","delegationDepth":0}),
            serde_json::json!({"type":"user/message","seq":0,"time":1_700_000_000_001i64,"data":{"role":"user","content":[{"type":"text","text":"inspect the repo"}]}}),
            serde_json::json!({"type":"tool/call","seq":1,"time":1_700_000_000_002i64,"data":{"name":"read_file","arguments":"{\"path\":\"README.md\"}"}}),
            serde_json::json!({"type":"assistant/message","seq":2,"time":1_700_000_000_003i64,"data":{"message":{"role":"assistant","source":{"provider":"flowlet","model":"flowlet-pro"},"content":[{"type":"text","text":"done"}]},"usage":{"inputTokens":10,"cacheReadTokens":20,"cacheWriteTokens":3,"outputTokens":5,"reasoningTokens":2}}}),
        ];

        let timeline = read_timeline_records(&records).unwrap();
        assert_eq!(timeline.turn_count, 1);
        assert_eq!(timeline.models, vec!["flowlet-pro"]);
        assert_eq!(timeline.events.len(), 3);
        assert_eq!(
            timeline.events[0].content.as_deref(),
            Some("inspect the repo")
        );
        assert_eq!(timeline.events[1].kind, "tool-call");
        let usage = timeline.usage.unwrap();
        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.cached_input_tokens, 20);
        assert_eq!(usage.cache_write_input_tokens, 3);
        assert_eq!(usage.output_tokens, 5);
        assert_eq!(usage.reasoning_tokens, 2);
        assert_eq!(usage.total_tokens, 38);
    }

    #[test]
    fn preserves_official_v0_trajectory_coordinates_and_payloads() {
        let records = vec![
            serde_json::json!({"type":"session","version":0,"id":"session-trajectory","createdAt":1_784_998_084_441i64,"cwd":"C:/repo"}),
            serde_json::json!({"type":"turn/start","seq":0,"time":1_784_998_084_454i64,"data":{"turn":1}}),
            serde_json::json!({"type":"user/message","seq":1,"time":1_784_998_084_454i64,"data":{"turn":1,"content":[{"type":"text","text":"inspect the repo"}]}}),
            serde_json::json!({"type":"request/header","seq":2,"time":1_784_998_084_520i64,"data":{"turn":1,"step":1,"reason":"initial","header":{"config":{"provider":"flowlet","model":"flowlet-pro"},"system":"You are an agent.","tools":[{"name":"read_file"}]}}}),
            serde_json::json!({"type":"tool/call","seq":3,"time":1_784_998_084_600i64,"data":{"turn":1,"step":1,"callId":"call-1","name":"read_file","arguments":"{\"path\":\"README.md\"}"}}),
            serde_json::json!({"type":"tool/result","seq":4,"time":1_784_998_084_700i64,"data":{"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":"call-1"},"content":[{"type":"tool-result","toolCallId":"call-1","content":[{"type":"text","text":"contents"}]}]}}}),
            serde_json::json!({"type":"assistant/message","seq":5,"time":1_784_998_084_800i64,"data":{"turn":1,"step":1,"content":[{"type":"reasoning","text":"I should summarize it."},{"type":"text","text":"Done."}],"provenance":{"provider":"flowlet","model":"flowlet-pro"},"usage":{"inputTokens":10,"outputTokens":2,"reasoningTokens":4}}}),
        ];

        let timeline = read_timeline_records(&records).unwrap();
        let request = timeline
            .events
            .iter()
            .find(|event| event.kind == "request")
            .unwrap();
        let request_trace = request.trace.as_ref().unwrap();
        assert_eq!(request_trace.turn, Some(1));
        assert_eq!(request_trace.step, Some(1));
        assert_eq!(request_trace.provider.as_deref(), Some("flowlet"));
        assert_eq!(
            request_trace.system_prompt.as_deref(),
            Some("You are an agent.")
        );
        assert!(request_trace
            .tools
            .as_deref()
            .unwrap()
            .contains("read_file"));

        let result = timeline
            .events
            .iter()
            .find(|event| event.kind == "tool-result")
            .unwrap();
        assert_eq!(result.title.as_deref(), Some("read_file"));
        assert_eq!(
            result
                .trace
                .as_ref()
                .and_then(|trace| trace.call_id.as_deref()),
            Some("call-1")
        );
        assert_eq!(result.content.as_deref(), Some("contents"));

        let reasoning = timeline
            .events
            .iter()
            .find(|event| event.kind == "reasoning")
            .unwrap();
        assert_eq!(reasoning.content.as_deref(), Some("I should summarize it."));
        let message = timeline
            .events
            .iter()
            .find(|event| event.kind == "assistant-message")
            .unwrap();
        assert_eq!(message.content.as_deref(), Some("Done."));
        assert_eq!(message.model.as_deref(), Some("flowlet-pro"));
    }

    #[test]
    fn accepts_every_released_session_format_and_rejects_newer_generations() {
        // v0（预发布）到 v3（当前）都必须可投影：DSH 用不可变代际持久化，
        // 老会话继续以老版本留在磁盘上。
        for version in 0..=DSH_CURRENT_FORMAT_VERSION {
            let records = vec![
                serde_json::json!({"type":"session","version":version,"id":format!("session-v{version}"),"createdAt":1_700_000_000_000i64}),
                serde_json::json!({"type":"turn/start","seq":0,"time":1_700_000_000_001i64,"data":{"turn":1}}),
                serde_json::json!({"type":"turn/end","seq":1,"time":1_700_000_000_002i64,"data":{"turn":1,"reason":{"kind":"completed"}}}),
            ];
            let timeline = read_timeline_records(&records)
                .unwrap_or_else(|error| panic!("v{version} 应可读取：{error}"));
            assert_eq!(timeline.events.len(), 1, "v{version}");
        }

        // 更高的未来代际只降级该会话。
        let records = vec![
            serde_json::json!({"type":"session","version":4,"id":"future","createdAt":0,"isSeeded":false,"delegationDepth":0}),
        ];
        let error = read_timeline_records(&records).unwrap_err();
        assert!(error.contains("尚未支持"), "实际错误: {error}");
    }

    #[test]
    fn a_new_turn_after_a_completed_turn_is_running() {
        let now = SystemTime::now();
        let records = vec![
            serde_json::json!({"type":"session","version":0}),
            serde_json::json!({"type":"turn/start","seq":1}),
            serde_json::json!({"type":"turn/end","seq":2,"data":{"reason":{"kind":"completed"}}}),
            serde_json::json!({"type":"turn/start","seq":3}),
            serde_json::json!({"type":"assistant/chunk","seq":4}),
        ];

        assert_eq!(infer_runtime_status(&records, Some(now), now), "running");
    }

    #[test]
    fn the_latest_closed_turn_is_idle() {
        let now = SystemTime::now();
        let records = vec![
            serde_json::json!({"type":"session","version":0}),
            serde_json::json!({"type":"turn/start","seq":1}),
            serde_json::json!({"type":"turn/end","seq":2,"data":{"reason":{"kind":"completed"}}}),
        ];

        assert_eq!(infer_runtime_status(&records, Some(now), now), "idle");
    }

    #[test]
    fn a_stale_unclosed_turn_does_not_remain_running_forever() {
        let now = SystemTime::now();
        let stale = now - RUNNING_FRESHNESS - Duration::from_secs(1);
        let records = vec![
            serde_json::json!({"type":"session","version":0}),
            serde_json::json!({"type":"turn/start","seq":1}),
        ];

        assert_eq!(infer_runtime_status(&records, Some(stale), now), "idle");
    }

    // ── 真实会话夹具回归 ───────────────────────────────────────────────────────
    // 夹具取自本机真实 DSH 会话（只截断长文本与 tools 清单，不改结构）。
    // 目的是让「真实形状」而不是「手写想象形状」来固定解析契约。

    fn fixture(name: &str) -> Vec<Value> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("dsh")
            .join(name);
        read_records(&path).unwrap_or_else(|error| panic!("读取夹具 {name} 失败：{error}"))
    }

    #[test]
    fn parses_only_the_current_generation_of_a_session_directory() {
        // 同一会话目录里同时存在 v0 与 v3 时，只保留最新一代。
        let v0 = CandidateSessionFile {
            path: PathBuf::from("/sessions/--D-repo--/session-x/session.jsonl.zstd"),
            version: 0,
        };
        let v3 = CandidateSessionFile {
            path: PathBuf::from("/sessions/--D-repo--/session-x/session.v3.jsonl.zstd"),
            version: 3,
        };
        let selected = select_generation_files(vec![v0.clone(), v3.clone()]);
        assert_eq!(selected, vec![v3.path.clone()]);

        // 只有更高代际时不做静默丢弃：退回可用的一份，保证会话仍可见。
        let future = CandidateSessionFile {
            path: PathBuf::from("/sessions/--D-repo--/session-x/session.v9.jsonl.zstd"),
            version: 9,
        };
        assert_eq!(
            select_generation_files(vec![v0.clone(), future]),
            vec![v0.path.clone()]
        );

        // 不同会话目录互不影响。
        let other = CandidateSessionFile {
            path: PathBuf::from("/sessions/--D-repo--/session-y/session.v3.jsonl.zstd"),
            version: 3,
        };
        let mut expected = vec![other.path.clone(), v3.path.clone()];
        expected.sort();
        assert_eq!(
            select_generation_files(vec![v0.clone(), v3.clone(), other]),
            expected
        );
    }

    #[test]
    fn parses_only_canonical_generation_filenames() {
        assert_eq!(parse_session_log_filename("session.jsonl"), Some(0));
        assert_eq!(parse_session_log_filename("session.jsonl.zstd"), Some(0));
        assert_eq!(parse_session_log_filename("session.v3.jsonl"), Some(3));
        assert_eq!(parse_session_log_filename("session.v3.jsonl.zstd"), Some(3));
        assert_eq!(
            parse_session_log_filename("session.v12.jsonl.zstd"),
            Some(12)
        );
        // 非规范名：官方明确不接纳临时名、大写、前导零与显式 .v0。
        assert_eq!(parse_session_log_filename("session.v0.jsonl.zstd"), None);
        assert_eq!(parse_session_log_filename("session.v03.jsonl.zstd"), None);
        assert_eq!(parse_session_log_filename("session.V3.jsonl.zstd"), None);
        assert_eq!(parse_session_log_filename("session.v3.jsonl.tmp"), None);
        assert_eq!(
            parse_session_log_filename("session.v3.jsonl.zstd.partial"),
            None
        );
        assert_eq!(parse_session_log_filename("timeline-end.jsonl"), None);
        assert_eq!(parse_session_log_filename("other.v3.jsonl"), None);
    }

    #[test]
    fn reads_real_v3_session_into_trajectory() {
        let records = fixture("session-v3-basic.jsonl");
        let header = parse_session_header(&records[0]).expect("v3 header 应可解析");
        assert_eq!(header.version, 3);
        assert!(!header.is_seeded);
        assert_eq!(header.cwd.as_deref(), Some("D:\\community-pulse"));

        let timeline = read_timeline_records(&records).expect("v3 会话应可投影");
        let kinds = timeline
            .events
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>();
        // system/message（v3 把提示词提升为消息）必须投影为 request 行。
        assert!(kinds.contains(&"request"), "实际事件: {kinds:?}");
        assert!(kinds.contains(&"user-message"), "实际事件: {kinds:?}");
        assert!(kinds.contains(&"assistant-message"), "实际事件: {kinds:?}");
        assert!(kinds.contains(&"tool-call"), "实际事件: {kinds:?}");
        assert!(kinds.contains(&"tool-result"), "实际事件: {kinds:?}");

        // 模型归属在 v2/v3 写在 data.message.source.model，不能为空。
        let message = timeline
            .events
            .iter()
            .find(|event| event.kind == "assistant-message")
            .expect("应有 assistant 消息");
        assert_eq!(message.model.as_deref(), Some("flowlet-flash"));
        assert!(message
            .content
            .as_deref()
            .is_some_and(|text| !text.is_empty()));
        assert!(timeline.models.contains(&"flowlet-flash".to_string()));

        // assistant/message 的 usage 是会话总量来源。
        assert!(timeline.usage.is_some(), "v3 usage 应被计入会话总量");

        // 工具调用与结果必须按 callId 配对到同一行（前端据此合并展示）。
        let call_id = timeline
            .events
            .iter()
            .find(|event| event.kind == "tool-call")
            .and_then(|event| event.trace.as_ref())
            .and_then(|trace| trace.call_id.clone())
            .expect("tool-call 应带 callId");
        assert!(
            timeline.events.iter().any(|event| {
                event.kind == "tool-result"
                    && event
                        .trace
                        .as_ref()
                        .and_then(|trace| trace.call_id.as_deref())
                        == Some(call_id.as_str())
            }),
            "callId {call_id} 的结果行缺失"
        );
    }

    #[test]
    fn drops_the_inherited_prefix_of_a_seeded_session() {
        let raw = fixture("session-v3-seeded.jsonl");
        let header = parse_session_header(&raw[0]).expect("seeded v3 header 应可解析");
        assert!(header.is_seeded, "夹具应来自 seeded 会话");
        assert_eq!(
            header.parent_session_id.as_deref(),
            Some("session-3c2db854-d037-461c-88c9-5f58427cf8d8")
        );

        // 夹具保留了继承前缀片段与切点标记，这里必须先裁掉前缀。
        assert!(raw
            .iter()
            .any(|value| value.get("type").and_then(Value::as_str) == Some("session/end-seed")));
        let (local_header, local) = local_event_records(raw.clone(), header);
        assert!(!local_header.is_seeded);
        assert!(local.len() < raw.len(), "继承前缀应被裁掉");
        assert!(
            local
                .iter()
                .all(|value| value.get("type").and_then(Value::as_str) != Some("session")),
            "裁剪后不应残留 header"
        );

        // 两份记录的事件数必须一致：seeded 会话只重复了父会话历史，不重复本地内容。
        let local_timeline = read_timeline_records(&local).expect("seeded 会话应可投影");
        assert!(!local_timeline.events.is_empty(), "裁剪后本地正文不应为空");
        // 继承前缀里的工具调用（已 shutdown）不得出现在本地轨迹中。
        assert!(
            local_timeline
                .events
                .iter()
                .filter(|event| event.kind == "tool-call")
                .count()
                <= raw
                    .iter()
                    .filter(|value| value.get("type").and_then(Value::as_str) == Some("tool/call"))
                    .count(),
            "裁剪不应凭空生成事件"
        );
    }

    #[test]
    fn session_directory_is_the_directory_holding_the_generation_files() {
        // 会话详情面板展示的「会话目录」＝ 所有代际文件所在目录，
        // 同一会话的 v0/v3 文件必然指向同一个目录。
        let v0 = Path::new("/home/u/.dsh/sessions/--D-repo--/session-x/session.jsonl.zstd");
        let v3 = Path::new("/home/u/.dsh/sessions/--D-repo--/session-x/session.v3.jsonl.zstd");
        assert_eq!(session_directory(v0), session_directory(v3));
        assert_eq!(
            session_directory(v3).as_deref(),
            Some("/home/u/.dsh/sessions/--D-repo--/session-x")
        );
        // 无父目录时不产生空字符串（UI 会显示占位符）。
        assert_eq!(session_directory(Path::new("session.jsonl")), None);
    }

    #[test]
    fn reads_real_v0_session_into_trajectory() {        // v0 会话必须继续可读（regression）。
        let records = fixture("session-v0-basic.jsonl");
        let header = parse_session_header(&records[0]).expect("v0 header 应可解析");
        assert_eq!(header.version, 0);

        let timeline = read_timeline_records(&records).expect("v0 会话应可投影");
        assert!(
            timeline
                .events
                .iter()
                .any(|event| event.kind == "assistant-message"),
            "v0 会话应投影出 assistant 消息"
        );
        assert!(timeline
            .events
            .iter()
            .any(|event| event.kind == "tool-call" || event.kind == "tool-result"));
    }

    /// 对真实 `~/.dsh/sessions` 全量跑一遍列出与投影，用于人工核对解析结果。
    /// 默认忽略（依赖本机数据）：`cargo test -- --ignored dsh_real_store`。
    #[test]
    #[ignore]
    fn dsh_real_store_lists_and_projects_every_session() {
        let files = session_files();
        assert!(!files.is_empty(), "本机没有找到 DSH 会话文件");
        let adapter = DeepSeekHarnessSessionAdapter;
        let rows = adapter.list_sessions();
        println!(
            "会话目录候选文件 {} 个，解析出会话 {} 个",
            files.len(),
            rows.len()
        );
        assert!(
            rows.len() <= files.len(),
            "同一会话的代际文件必须归并，不能重复列出"
        );
        // 出现过的会话 id 必须唯一（同目录多代际不得重复成两行）。
        let mut seen = HashSet::new();
        for row in &rows {
            assert!(
                seen.insert(row.session_id.clone()),
                "会话重复列出：{}",
                row.session_id
            );
            println!(
                "{:<46} turns={:<4} tokens={:<9} models={:?} cwd={:?} title={:?}",
                row.session_id,
                row.native_summary
                    .as_ref()
                    .map(|s| s.turn_count)
                    .unwrap_or_default(),
                row.native_summary
                    .as_ref()
                    .and_then(|s| s.usage.as_ref())
                    .map(|u| u.total_tokens)
                    .unwrap_or_default(),
                row.native_summary
                    .as_ref()
                    .map(|s| s.models.clone())
                    .unwrap_or_default(),
                row.project_path,
                row.title,
            );
            // 每个会话都必须能投影。seeded 会话切在父会话未闭合的 turn 内部时，
            // 本地正文可能确实没有完整轮次 → 允许为空，但不得报错。
            let timeline = adapter
                .timeline("deepseek-harness", &row.session_id)
                .unwrap_or_else(|error| panic!("{} 投影失败：{error}", row.session_id));
            let turn_count = row
                .native_summary
                .as_ref()
                .map(|s| s.turn_count)
                .unwrap_or_default();
            if turn_count > 0 {
                assert!(
                    !timeline.events.is_empty(),
                    "{} 有 {turn_count} 轮却投影为空",
                    row.session_id
                );
            }
        }
    }
}
