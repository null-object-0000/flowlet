use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

mod adapters;
mod process;

#[cfg(all(test, windows))]
use process::decode_windows_acp;
#[cfg(test)]
use process::{decode_process_output, parse_package_version};
use process::{parse_version, read_version};
// CREATE_NO_WINDOW：用于 Windows 子进程。非 Windows 平台剥离 cfg 函数后该
// import 在 `cargo check`（Linux）下会被误报未使用，故显式放行。
#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) fn has_environment_adapter(adapter_id: &str) -> bool {
    adapters::has(adapter_id)
}

// 让子进程在 Windows 上不弹出可见控制台窗口。概览页等场景会并发
// spawn 多个 powershell.exe / cmd.exe / 目标 exe 子进程去读版本，
// 在无可附加控制台的 GUI 构建（如 portable）上每个都会抢到一个新控制台。
// 该标志（CREATE_NO_WINDOW）仅控制是否新建可见控制台，不影响 pipe 捕获和子进程生命周期。
#[cfg(windows)]
pub(crate) fn configure_hidden_console(command: &mut Command) {
    command.creation_flags(0x08000000);
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentInstallMethod {
    Native,
    Winget,
    Npm,
    Bun,
    LegacyNpm,
    Homebrew,
    SystemPackage,
    Desktop,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSurface {
    Cli,
    Desktop,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AgentInstallation {
    pub surface: AgentSurface,
    pub executable_path: String,
    pub install_dir: String,
    pub install_method: AgentInstallMethod,
    pub version: Option<String>,
    pub version_output: Option<String>,
    pub available_on_path: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AgentEnvironmentReport {
    pub agent_id: String,
    pub agent_name: String,
    pub installed: bool,
    pub primary: Option<AgentInstallation>,
    pub installations: Vec<AgentInstallation>,
}

pub async fn detect_agent_environment(agent_id: &str) -> Result<AgentEnvironmentReport, String> {
    let plugin = super::plugin_registry::plugin_registry().agent(agent_id);
    let environment_id = plugin
        .map(|descriptor| descriptor.environment_adapter_id.as_str())
        .unwrap_or(agent_id);
    let adapter =
        adapters::get(environment_id).ok_or_else(|| format!("暂不支持检测 Agent：{agent_id}"))?;
    let mut report = (adapter.detect)().await;
    if let Some(plugin) = plugin {
        report.agent_id = plugin.id.clone();
        report.agent_name = plugin.name.clone();
    }
    Ok(report)
}

#[derive(Debug)]
pub(self) struct Candidate {
    pub(self) path: PathBuf,
    pub(self) available_on_path: bool,
}

fn pi_cli_candidates() -> Vec<Candidate> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for file_name in executable_names("pi") {
                push_candidate(&mut candidates, &mut seen, directory.join(file_name), true);
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        for relative in known_pi_cli_locations() {
            push_candidate(&mut candidates, &mut seen, home.join(relative), false);
        }
    }
    #[cfg(windows)]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        let directory = PathBuf::from(app_data).join("npm");
        for file_name in executable_names("pi") {
            push_candidate(&mut candidates, &mut seen, directory.join(file_name), false);
        }
    }
    candidates
}

fn opencode_cli_candidates() -> Vec<Candidate> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for file_name in executable_names("opencode") {
                push_opencode_cli_candidate(
                    &mut candidates,
                    &mut seen,
                    directory.join(file_name),
                    true,
                );
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        for relative in known_opencode_cli_locations() {
            push_opencode_cli_candidate(&mut candidates, &mut seen, home.join(relative), false);
        }
    }
    #[cfg(windows)]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        let directory = PathBuf::from(app_data).join("npm");
        for file_name in executable_names("opencode") {
            push_opencode_cli_candidate(
                &mut candidates,
                &mut seen,
                directory.join(file_name),
                false,
            );
        }
    }
    candidates
}

fn codex_cli_candidates() -> Vec<Candidate> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for file_name in executable_names("codex") {
                let candidate = directory.join(file_name);
                if !is_external_codex_cli_candidate(&candidate) {
                    continue;
                }
                push_codex_cli_candidate(&mut candidates, &mut seen, candidate, true);
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        for relative in known_codex_cli_locations() {
            push_codex_cli_candidate(&mut candidates, &mut seen, home.join(relative), false);
        }
    }
    #[cfg(windows)]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        let directory = PathBuf::from(app_data).join("npm");
        for file_name in executable_names("codex") {
            push_codex_cli_candidate(&mut candidates, &mut seen, directory.join(file_name), false);
        }
    }
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        push_codex_cli_candidate(
            &mut candidates,
            &mut seen,
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("OpenAI")
                .join("Codex")
                .join("bin")
                .join("codex.exe"),
            false,
        );
    }
    candidates
}

fn push_codex_cli_candidate(
    candidates: &mut Vec<Candidate>,
    seen: &mut HashSet<String>,
    path: PathBuf,
    available_on_path: bool,
) {
    #[cfg(windows)]
    let path = resolve_windows_codex_executable(path);
    push_candidate(candidates, seen, path, available_on_path);
}

#[cfg(windows)]
fn resolve_windows_codex_executable(path: PathBuf) -> PathBuf {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "cmd" && extension != "ps1" {
        return path;
    }

    let Some(npm_bin) = path.parent() else {
        return path;
    };
    if !normalized_path_key(npm_bin).ends_with("/npm") {
        return path;
    }

    let (platform_package, target_triple) = match std::env::consts::ARCH {
        "x86_64" => ("codex-win32-x64", "x86_64-pc-windows-msvc"),
        "aarch64" => ("codex-win32-arm64", "aarch64-pc-windows-msvc"),
        _ => return path,
    };
    let package_root = npm_bin.join("node_modules").join("@openai").join("codex");
    let candidates = [
        package_root
            .join("node_modules")
            .join("@openai")
            .join(platform_package)
            .join("vendor")
            .join(target_triple)
            .join("bin")
            .join("codex.exe"),
        package_root
            .join("vendor")
            .join(target_triple)
            .join("bin")
            .join("codex.exe"),
    ];
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .unwrap_or(path)
}

#[cfg(windows)]
fn is_external_codex_cli_candidate(path: &Path) -> bool {
    !is_windows_store_codex_executable(path)
}

#[cfg(not(windows))]
fn is_external_codex_cli_candidate(_path: &Path) -> bool {
    true
}

fn opencode_desktop_candidates() -> Vec<Candidate> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for path in known_opencode_desktop_locations() {
        push_candidate(&mut candidates, &mut seen, path, false);
    }
    candidates
}

fn claude_candidates() -> Vec<Candidate> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for file_name in executable_names("claude") {
                push_candidate(&mut candidates, &mut seen, directory.join(file_name), true);
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        for relative in known_claude_locations() {
            push_candidate(&mut candidates, &mut seen, home.join(relative), false);
        }
    }

    #[cfg(windows)]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        let npm_bin = PathBuf::from(app_data).join("npm");
        for file_name in executable_names("claude") {
            push_candidate(&mut candidates, &mut seen, npm_bin.join(file_name), false);
        }
    }

    candidates
}

fn push_candidate(
    candidates: &mut Vec<Candidate>,
    seen: &mut HashSet<String>,
    path: PathBuf,
    available_on_path: bool,
) {
    if !path.is_file() {
        return;
    }

    let resolved = std::fs::canonicalize(&path).unwrap_or(path);
    let key = normalized_path_key(&resolved);
    if let Some(existing) = candidates
        .iter_mut()
        .find(|candidate| normalized_path_key(&candidate.path) == key)
    {
        existing.available_on_path |= available_on_path;
        return;
    }
    if seen.insert(key) {
        candidates.push(Candidate {
            path: resolved,
            available_on_path,
        });
    }
}

fn push_opencode_cli_candidate(
    candidates: &mut Vec<Candidate>,
    seen: &mut HashSet<String>,
    path: PathBuf,
    available_on_path: bool,
) {
    #[cfg(windows)]
    let Some(path) = resolve_windows_opencode_executable(path) else {
        return;
    };
    push_candidate(candidates, seen, path, available_on_path);
}

#[cfg(windows)]
fn resolve_windows_opencode_executable(path: PathBuf) -> Option<PathBuf> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension.is_empty() {
        return None;
    }
    if extension == "cmd" || extension == "ps1" {
        let parent = path.parent()?;
        if normalized_path_key(parent).ends_with("/npm") {
            let executable = parent
                .join("node_modules")
                .join("opencode-ai")
                .join("bin")
                .join("opencode.exe");
            return executable.is_file().then_some(executable);
        }
    }
    Some(path)
}

#[cfg(windows)]
fn executable_names(command: &str) -> Vec<String> {
    let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let mut names = Vec::new();
    names.extend(
        extensions
            .split(';')
            .filter(|extension| !extension.trim().is_empty())
            .map(|extension| format!("{command}{}", extension.to_ascii_lowercase())),
    );
    names
}

#[cfg(not(windows))]
fn executable_names(command: &str) -> Vec<String> {
    vec![command.to_string()]
}

#[cfg(windows)]
fn known_claude_locations() -> &'static [&'static str] {
    &[
        ".local/bin/claude.exe",
        ".claude/local/claude.exe",
        ".claude/local/claude.cmd",
    ]
}

#[cfg(windows)]
fn known_opencode_cli_locations() -> &'static [&'static str] {
    &[
        ".opencode/bin/opencode.exe",
        ".local/bin/opencode.exe",
        ".bun/bin/opencode.exe",
    ]
}

#[cfg(windows)]
fn known_codex_cli_locations() -> &'static [&'static str] {
    &[".local/bin/codex.exe"]
}

#[cfg(not(windows))]
fn known_codex_cli_locations() -> &'static [&'static str] {
    &[".local/bin/codex"]
}

// Pi 官方安装脚本优先使用 npm 全局前缀，不可写时回退到 `$HOME/.local`，
// 因此独立安装的二进制通常位于 `~/.local/bin/pi`。
#[cfg(windows)]
fn known_pi_cli_locations() -> &'static [&'static str] {
    &[".local/bin/pi.exe", ".local/bin/pi.cmd"]
}

#[cfg(not(windows))]
fn known_pi_cli_locations() -> &'static [&'static str] {
    &[".local/bin/pi"]
}

#[cfg(not(windows))]
fn known_opencode_cli_locations() -> &'static [&'static str] {
    &[
        ".opencode/bin/opencode",
        ".local/bin/opencode",
        ".bun/bin/opencode",
    ]
}

#[cfg(windows)]
fn known_opencode_desktop_locations() -> Vec<PathBuf> {
    let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else {
        return Vec::new();
    };
    let local_app_data = PathBuf::from(local_app_data);
    vec![
        local_app_data
            .join("Programs")
            .join("@opencode-aidesktop")
            .join("OpenCode.exe"),
        local_app_data
            .join("Programs")
            .join("OpenCode")
            .join("OpenCode.exe"),
    ]
}

#[cfg(target_os = "macos")]
fn known_opencode_desktop_locations() -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from(
        "/Applications/OpenCode.app/Contents/MacOS/OpenCode",
    )];
    if let Some(home) = dirs::home_dir() {
        paths.push(
            home.join("Applications")
                .join("OpenCode.app")
                .join("Contents")
                .join("MacOS")
                .join("OpenCode"),
        );
    }
    paths
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn known_opencode_desktop_locations() -> Vec<PathBuf> {
    dirs::home_dir()
        .map(|home| {
            vec![
                home.join(".local").join("bin").join("opencode-desktop"),
                home.join("Applications").join("OpenCode.AppImage"),
            ]
        })
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn known_claude_locations() -> &'static [&'static str] {
    &[".local/bin/claude", ".claude/local/claude"]
}

fn normalized_path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

pub(super) fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{path}");
        }
        if let Some(path) = value.strip_prefix(r"\\?\") {
            return path.to_string();
        }
    }
    value.into_owned()
}

fn classify_install_method(path: &Path) -> AgentInstallMethod {
    let normalized = normalized_path_key(path);
    if normalized.contains("/.claude/local/") {
        AgentInstallMethod::LegacyNpm
    } else if normalized.contains("/winget/packages/")
        || normalized.contains("/microsoft/winget/links/")
    {
        AgentInstallMethod::Winget
    } else if normalized.contains("/node_modules/@anthropic-ai/claude-code")
        || normalized.ends_with("/npm/claude.cmd")
        || normalized.ends_with("/npm/claude.ps1")
        || normalized.ends_with("/npm/claude")
    {
        AgentInstallMethod::Npm
    } else if normalized.contains("/homebrew/")
        || normalized.contains("/cellar/claude-code/")
        || normalized.contains("/caskroom/claude-code/")
    {
        AgentInstallMethod::Homebrew
    } else if normalized.ends_with("/.local/bin/claude")
        || normalized.ends_with("/.local/bin/claude.exe")
    {
        AgentInstallMethod::Native
    } else if normalized.starts_with("/usr/bin/") || normalized.starts_with("/usr/local/bin/") {
        AgentInstallMethod::SystemPackage
    } else {
        AgentInstallMethod::Unknown
    }
}

fn classify_opencode_cli_method(path: &Path) -> AgentInstallMethod {
    let normalized = normalized_path_key(path);
    if normalized.contains("/.bun/bin/") {
        AgentInstallMethod::Bun
    } else if normalized.contains("/node_modules/opencode-ai/")
        || normalized.ends_with("/npm/opencode.cmd")
        || normalized.ends_with("/npm/opencode.ps1")
        || normalized.ends_with("/npm/opencode")
    {
        AgentInstallMethod::Npm
    } else if normalized.contains("/homebrew/") || normalized.contains("/cellar/opencode/") {
        AgentInstallMethod::Homebrew
    } else if normalized.contains("/.opencode/bin/") || normalized.contains("/.local/bin/") {
        AgentInstallMethod::Native
    } else if normalized.starts_with("/usr/bin/") || normalized.starts_with("/usr/local/bin/") {
        AgentInstallMethod::SystemPackage
    } else {
        AgentInstallMethod::Unknown
    }
}

fn classify_codex_cli_method(path: &Path) -> AgentInstallMethod {
    let normalized = normalized_path_key(path);
    if normalized.contains("/node_modules/@openai/codex/")
        || normalized.ends_with("/npm/codex.cmd")
        || normalized.ends_with("/npm/codex.ps1")
        || normalized.ends_with("/npm/codex")
    {
        AgentInstallMethod::Npm
    } else if normalized.contains("/homebrew/") || normalized.contains("/cellar/codex/") {
        AgentInstallMethod::Homebrew
    } else if normalized.ends_with("/.local/bin/codex")
        || normalized.ends_with("/.local/bin/codex.exe")
        || normalized.contains("/programs/openai/codex/bin/")
        || (normalized.contains("/.codex/packages/standalone/releases/")
            && (normalized.ends_with("/bin/codex") || normalized.ends_with("/bin/codex.exe")))
    {
        AgentInstallMethod::Native
    } else if normalized.starts_with("/usr/bin/") || normalized.starts_with("/usr/local/bin/") {
        AgentInstallMethod::SystemPackage
    } else {
        AgentInstallMethod::Unknown
    }
}

fn classify_pi_cli_method(path: &Path) -> AgentInstallMethod {
    let normalized = normalized_path_key(path);
    if normalized.contains("/node_modules/@earendil-works/pi-coding-agent")
        || normalized.ends_with("/npm/pi.cmd")
        || normalized.ends_with("/npm/pi.ps1")
        || normalized.ends_with("/npm/pi")
    {
        AgentInstallMethod::Npm
    } else if normalized.ends_with("/.local/bin/pi") || normalized.ends_with("/.local/bin/pi.exe") {
        AgentInstallMethod::Native
    } else if normalized.starts_with("/usr/bin/") || normalized.starts_with("/usr/local/bin/") {
        AgentInstallMethod::SystemPackage
    } else {
        AgentInstallMethod::Unknown
    }
}

fn resolve_pi_install_dir(path: &Path, method: &AgentInstallMethod) -> PathBuf {
    if matches!(method, AgentInstallMethod::Npm) {
        if let Some(bin_dir) = path.parent() {
            let package_dir = bin_dir
                .join("node_modules")
                .join("@earendil-works")
                .join("pi-coding-agent");
            if package_dir.is_dir() {
                return package_dir;
            }
        }
    }
    path.parent().unwrap_or(path).to_path_buf()
}

fn desktop_version(path: &Path) -> Option<String> {
    #[cfg(windows)]
    if let Some(version) = windows_file_version(path) {
        return Some(version);
    }
    let package_json = path
        .parent()?
        .join("resources")
        .join("app")
        .join("package.json");
    let content = std::fs::read_to_string(package_json).ok()?;
    serde_json::from_str::<serde_json::Value>(&content)
        .ok()?
        .get("version")?
        .as_str()
        .map(ToOwned::to_owned)
}

#[cfg(windows)]
fn windows_file_version(path: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
    };

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut handle = 0;
    let size = unsafe { GetFileVersionInfoSizeW(wide.as_ptr(), &mut handle) };
    if size == 0 {
        return None;
    }
    let mut buffer = vec![0_u8; size as usize];
    if unsafe { GetFileVersionInfoW(wide.as_ptr(), 0, size, buffer.as_mut_ptr().cast()) } == 0 {
        return None;
    }
    let root = ['\\' as u16, 0];
    let mut value = std::ptr::null_mut();
    let mut value_len = 0;
    if unsafe {
        VerQueryValueW(
            buffer.as_ptr().cast(),
            root.as_ptr(),
            &mut value,
            &mut value_len,
        )
    } == 0
        || value.is_null()
        || value_len < std::mem::size_of::<VS_FIXEDFILEINFO>() as u32
    {
        return None;
    }
    let info = unsafe { &*(value.cast::<VS_FIXEDFILEINFO>()) };
    let parts = [
        info.dwFileVersionMS >> 16,
        info.dwFileVersionMS & 0xffff,
        info.dwFileVersionLS >> 16,
        info.dwFileVersionLS & 0xffff,
    ];
    if parts.iter().all(|part| *part == 0) {
        return None;
    }
    let length = parts
        .iter()
        .rposition(|part| *part != 0)
        .map(|index| index + 1)
        .unwrap_or(2)
        .max(2);
    Some(
        parts[..length]
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("."),
    )
}

fn resolve_install_dir(path: &Path, method: &AgentInstallMethod) -> PathBuf {
    if matches!(method, AgentInstallMethod::Npm) {
        if let Some(bin_dir) = path.parent() {
            let package_dir = bin_dir
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code");
            if package_dir.is_dir() {
                return package_dir;
            }
        }
    }
    path.parent().unwrap_or(path).to_path_buf()
}

fn resolve_opencode_install_dir(path: &Path, method: &AgentInstallMethod) -> PathBuf {
    if matches!(method, AgentInstallMethod::Npm)
        && normalized_path_key(path).contains("/node_modules/opencode-ai/bin/")
    {
        if let Some(package_dir) = path.parent().and_then(Path::parent) {
            return package_dir.to_path_buf();
        }
    }
    path.parent().unwrap_or(path).to_path_buf()
}

fn resolve_codex_install_dir(path: &Path, method: &AgentInstallMethod) -> PathBuf {
    if matches!(method, AgentInstallMethod::Npm) {
        if let Some(bin_dir) = path.parent() {
            let package_dir = bin_dir.join("node_modules").join("@openai").join("codex");
            if package_dir.is_dir() {
                return package_dir;
            }
        }
    }
    path.parent().unwrap_or(path).to_path_buf()
}

fn read_package_version(install_dir: &Path) -> Option<String> {
    process::read_package_version(install_dir)
}

#[cfg(windows)]
fn is_windows_store_codex_executable(path: &Path) -> bool {
    process::is_windows_store_codex_executable(path)
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::adapters::codex::parse_chatgpt_windows_package_output;
    use super::*;

    #[test]
    fn parses_claude_version_output() {
        assert_eq!(
            parse_version("2.1.207 (Claude Code)"),
            Some("2.1.207".to_string())
        );
        assert_eq!(
            parse_version("Claude Code v2.0.1"),
            Some("2.0.1".to_string())
        );
        assert_eq!(
            parse_version("opencode 1.17.18"),
            Some("1.17.18".to_string())
        );
    }

    #[test]
    fn decodes_valid_utf8_output_unchanged() {
        assert_eq!(decode_process_output(b"  pi 0.42.1\n"), "pi 0.42.1");
    }

    #[cfg(windows)]
    #[test]
    fn decodes_gbk_process_output_on_windows() {
        // “不是” 的 GBK 字节，直接按 UTF-8 解释会得到替换符乱码。
        let gbk = [0xB2_u8, 0xBB, 0xCA, 0xC7];
        assert_eq!(decode_windows_acp(&gbk), "不是");
        assert_eq!(decode_process_output(&gbk), "不是");
    }

    #[test]
    fn parses_codex_npm_package_version() {
        assert_eq!(
            parse_package_version(r#"{"name":"@openai/codex","version":"0.142.5"}"#),
            Some("0.142.5".to_string())
        );
    }

    #[test]
    fn classifies_official_install_locations() {
        assert_eq!(
            classify_install_method(Path::new("C:/Users/test/.local/bin/claude.exe")),
            AgentInstallMethod::Native
        );
        assert_eq!(
            classify_install_method(Path::new("C:/Users/test/AppData/Roaming/npm/claude.cmd")),
            AgentInstallMethod::Npm
        );
        assert_eq!(
            classify_install_method(Path::new("/Users/test/.claude/local/claude")),
            AgentInstallMethod::LegacyNpm
        );
        assert_eq!(
            classify_opencode_cli_method(Path::new("C:/Users/test/.opencode/bin/opencode.exe")),
            AgentInstallMethod::Native
        );
        assert_eq!(
            classify_opencode_cli_method(Path::new("C:/Users/test/.bun/bin/opencode.exe")),
            AgentInstallMethod::Bun
        );
        assert_eq!(
            classify_codex_cli_method(Path::new("C:/Users/test/AppData/Roaming/npm/codex.cmd")),
            AgentInstallMethod::Npm
        );
        assert_eq!(
            classify_codex_cli_method(Path::new(
                "C:/Users/test/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe"
            )),
            AgentInstallMethod::Native
        );
        assert_eq!(
            classify_codex_cli_method(Path::new(
                "C:/Users/test/.codex/packages/standalone/releases/0.147.0-x86_64-pc-windows-msvc/bin/codex.exe"
            )),
            AgentInstallMethod::Native
        );
        assert_eq!(
            classify_pi_cli_method(Path::new("C:/Users/test/AppData/Roaming/npm/pi.cmd")),
            AgentInstallMethod::Npm
        );
        assert_eq!(
            classify_pi_cli_method(Path::new("/Users/test/.local/bin/pi")),
            AgentInstallMethod::Native
        );
        assert_eq!(
            classify_pi_cli_method(Path::new(
                "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/bin/pi.js"
            )),
            AgentInstallMethod::Npm
        );
    }

    #[cfg(windows)]
    #[test]
    fn recognizes_windows_store_codex_command_target() {
        let path = Path::new(
            "C:/Program Files/WindowsApps/OpenAI.Codex_26.715.4045.0_x64__2p2nqsd0c76g0/app/resources/codex.exe",
        );
        assert!(is_windows_store_codex_executable(path));
        assert!(!is_external_codex_cli_candidate(path));
    }

    #[cfg(windows)]
    #[test]
    fn parses_chatgpt_desktop_appx_package_output() {
        let installation = parse_chatgpt_windows_package_output(
            "26.707.12708.0\tC:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0\tapp\\ChatGPT.exe",
        )
        .unwrap();
        assert_eq!(installation.surface, AgentSurface::Desktop);
        assert_eq!(installation.version.as_deref(), Some("26.707.12708.0"));
        assert_eq!(
            installation.executable_path,
            "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.12708.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe"
        );
    }
    #[cfg(windows)]
    #[test]
    fn hides_windows_extended_path_prefix_for_display() {
        assert_eq!(
            display_path(Path::new(r"\\?\C:\Users\test\.local\bin\claude.exe")),
            r"C:\Users\test\.local\bin\claude.exe"
        );
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\claude.exe")),
            r"\\server\share\claude.exe"
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolves_npm_shims_to_one_real_opencode_executable() {
        let directory =
            std::env::temp_dir().join(format!("flowlet-opencode-shim-{}", uuid::Uuid::new_v4()));
        let npm = directory.join("npm");
        let executable = npm
            .join("node_modules")
            .join("opencode-ai")
            .join("bin")
            .join("opencode.exe");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, []).unwrap();
        std::fs::write(npm.join("opencode.cmd"), "@echo off").unwrap();
        std::fs::write(npm.join("opencode"), "#!/bin/sh").unwrap();

        assert_eq!(
            resolve_windows_opencode_executable(npm.join("opencode.cmd")),
            Some(executable)
        );
        assert_eq!(
            resolve_windows_opencode_executable(npm.join("opencode")),
            None
        );

        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(windows)]
    #[test]
    fn resolves_npm_codex_shim_to_packaged_native_executable() {
        let directory =
            std::env::temp_dir().join(format!("flowlet-codex-shim-{}", uuid::Uuid::new_v4()));
        let npm = directory.join("npm");
        let (platform_package, target_triple) = match std::env::consts::ARCH {
            "x86_64" => ("codex-win32-x64", "x86_64-pc-windows-msvc"),
            "aarch64" => ("codex-win32-arm64", "aarch64-pc-windows-msvc"),
            unsupported => panic!("unsupported Windows test architecture: {unsupported}"),
        };
        let executable = npm
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("node_modules")
            .join("@openai")
            .join(platform_package)
            .join("vendor")
            .join(target_triple)
            .join("bin")
            .join("codex.exe");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, []).unwrap();
        let shim = npm.join("codex.cmd");
        std::fs::write(&shim, "@echo off").unwrap();

        assert_eq!(resolve_windows_codex_executable(shim), executable);

        let _ = std::fs::remove_dir_all(directory);
    }
}
