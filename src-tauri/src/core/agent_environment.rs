use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
// CREATE_NO_WINDOW：用于 Windows 子进程。非 Windows 平台剥离 cfg 函数后该
// import 在 `cargo check`（Linux）下会被误报未使用，故显式放行。
#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

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
    match agent_id {
        "claude-code" => Ok(detect_claude_code().await),
        "opencode" => Ok(detect_opencode().await),
        "chatgpt-desktop" => Ok(detect_chatgpt_codex().await),
        _ => Err(format!("暂不支持检测 Agent：{agent_id}")),
    }
}

async fn detect_chatgpt_codex() -> AgentEnvironmentReport {
    let mut installations = codex_cli_installations().await;
    installations.extend(chatgpt_desktop_installations().await);
    let primary = installations
        .iter()
        .find(|installation| {
            installation.surface == AgentSurface::Cli
                && installation.available_on_path
                && installation.version.is_some()
        })
        .or_else(|| {
            installations
                .iter()
                .find(|installation| installation.surface == AgentSurface::Cli)
        })
        .or_else(|| installations.first())
        .cloned();
    AgentEnvironmentReport {
        agent_id: "chatgpt-desktop".to_string(),
        agent_name: "ChatGPT (Codex)".to_string(),
        installed: !installations.is_empty(),
        primary,
        installations,
    }
}

async fn codex_cli_installations() -> Vec<AgentInstallation> {
    let mut installations = Vec::new();
    for candidate in codex_cli_candidates() {
        let install_method = classify_codex_cli_method(&candidate.path);
        let install_dir = resolve_codex_install_dir(&candidate.path, &install_method);
        let package_version = read_package_version(&install_dir);
        let version_result = read_version(&candidate.path).await;
        let (version, version_output, error) = match version_result {
            Ok(output) => (
                parse_version(&output).or(package_version),
                Some(output),
                None,
            ),
            Err(_) if package_version.is_some() => (package_version, None, None),
            Err(error) => (None, None, Some(error)),
        };
        installations.push(AgentInstallation {
            surface: AgentSurface::Cli,
            executable_path: display_path(&candidate.path),
            install_dir: display_path(&install_dir),
            install_method,
            version,
            version_output,
            available_on_path: candidate.available_on_path,
            error,
        });
    }
    installations
}

#[cfg(windows)]
async fn chatgpt_desktop_installations() -> Vec<AgentInstallation> {
    // The unified ChatGPT app currently retains the OpenAI.Codex Store package identity.
    // Requiring ChatGPT.exe as the application entry keeps legacy Codex packages excluded.
    const QUERY: &str = r#"$found = $false; $packages = @(); $packages += @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue); $packages += @(Get-AppxPackage -Name 'OpenAI.ChatGPT-Desktop' -ErrorAction SilentlyContinue); foreach ($p in @($packages | Sort-Object Version -Descending)) { $relative = ''; try { [xml]$manifest = Get-Content -LiteralPath (Join-Path $p.InstallLocation 'AppxManifest.xml'); $app = @($manifest.Package.Applications.Application) | Where-Object { [IO.Path]::GetFileName([string]$_.Executable) -ieq 'ChatGPT.exe' } | Select-Object -First 1; if ($null -ne $app) { $relative = [string]$app.Executable } } catch {}; if ([string]::IsNullOrWhiteSpace($relative)) { $fallback = Join-Path $p.InstallLocation 'app\ChatGPT.exe'; if (Test-Path -LiteralPath $fallback) { $relative = 'app\ChatGPT.exe' } }; if (-not [string]::IsNullOrWhiteSpace($relative)) { [Console]::Out.Write($p.Version.ToString() + [char]9 + $p.InstallLocation + [char]9 + $relative); $found = $true; break } }; if (-not $found) { $process = Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue | Where-Object { $_.Path -match '\\WindowsApps\\OpenAI\.(Codex|ChatGPT-Desktop)_[^\\]+\\app\\ChatGPT\.exe$' } | Select-Object -First 1; if ($null -ne $process -and $process.Path -match '^(?<install>.*\\OpenAI\.(Codex|ChatGPT-Desktop)_(?<version>[^_]+)_[^\\]+)\\app\\ChatGPT\.exe$') { [Console]::Out.Write($Matches.version + [char]9 + $Matches.install + [char]9 + 'app\ChatGPT.exe') } }"#;
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        QUERY,
    ]);
    #[cfg(windows)]
    configure_hidden_console(&mut command);
    let output = tokio::time::timeout(
        VERSION_TIMEOUT,
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output(),
    )
    .await;
    let Ok(Ok(output)) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_chatgpt_windows_package_output(&String::from_utf8_lossy(&output.stdout))
        .into_iter()
        .collect()
}

#[cfg(windows)]
fn parse_chatgpt_windows_package_output(output: &str) -> Option<AgentInstallation> {
    let mut fields = output.trim().splitn(3, '\t');
    let version = fields.next()?.trim();
    let install_dir = PathBuf::from(fields.next()?.trim());
    if version.is_empty() || install_dir.as_os_str().is_empty() {
        return None;
    }
    let relative = fields.next().unwrap_or_default().trim();
    let executable = if relative.is_empty() {
        install_dir.join("ChatGPT.exe")
    } else {
        install_dir.join(relative)
    };
    Some(AgentInstallation {
        surface: AgentSurface::Desktop,
        executable_path: display_path(&executable),
        install_dir: display_path(&install_dir),
        install_method: AgentInstallMethod::Desktop,
        version: Some(version.to_string()),
        version_output: None,
        available_on_path: false,
        error: None,
    })
}

#[cfg(target_os = "macos")]
async fn chatgpt_desktop_installations() -> Vec<AgentInstallation> {
    let mut paths = vec![PathBuf::from("/Applications/ChatGPT.app")];
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join("Applications/ChatGPT.app"));
    }
    paths
        .into_iter()
        .filter(|path| path.is_dir())
        .map(|app_path| {
            let plist = std::fs::read_to_string(app_path.join("Contents/Info.plist")).ok();
            let version = plist
                .as_deref()
                .and_then(|value| parse_plist_string(value, "CFBundleShortVersionString"))
                .or_else(|| {
                    plist
                        .as_deref()
                        .and_then(|value| parse_plist_string(value, "CFBundleVersion"))
                });
            AgentInstallation {
                surface: AgentSurface::Desktop,
                executable_path: display_path(&app_path.join("Contents/MacOS/ChatGPT")),
                install_dir: display_path(&app_path),
                install_method: AgentInstallMethod::Desktop,
                version,
                version_output: None,
                available_on_path: false,
                error: None,
            }
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn parse_plist_string(content: &str, key: &str) -> Option<String> {
    let after_key = content.split_once(&format!("<key>{key}</key>"))?.1;
    let value = after_key
        .split_once("<string>")?
        .1
        .split_once("</string>")?
        .0
        .trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
async fn chatgpt_desktop_installations() -> Vec<AgentInstallation> {
    Vec::new()
}
async fn detect_claude_code() -> AgentEnvironmentReport {
    let candidates = claude_candidates();
    let mut installations = Vec::with_capacity(candidates.len());

    for candidate in candidates {
        let install_method = classify_install_method(&candidate.path);
        let install_dir = resolve_install_dir(&candidate.path, &install_method);
        let version_result = read_version(&candidate.path).await;
        let (version, version_output, error) = match version_result {
            Ok(output) => (parse_version(&output), Some(output), None),
            Err(error) => (None, None, Some(error)),
        };

        installations.push(AgentInstallation {
            surface: AgentSurface::Cli,
            executable_path: display_path(&candidate.path),
            install_dir: display_path(&install_dir),
            install_method,
            version,
            version_output,
            available_on_path: candidate.available_on_path,
            error,
        });
    }

    let primary_index = installations
        .iter()
        .position(|installation| installation.available_on_path && installation.version.is_some())
        .or_else(|| {
            installations
                .iter()
                .position(|installation| installation.version.is_some())
        })
        .or_else(|| {
            installations
                .iter()
                .position(|installation| installation.available_on_path)
        })
        .or_else(|| (!installations.is_empty()).then_some(0));
    let primary = primary_index.map(|index| installations[index].clone());

    AgentEnvironmentReport {
        agent_id: "claude-code".to_string(),
        agent_name: "Claude Code CLI".to_string(),
        installed: !installations.is_empty(),
        primary,
        installations,
    }
}

async fn detect_opencode() -> AgentEnvironmentReport {
    let mut installations = Vec::new();
    for candidate in opencode_cli_candidates() {
        let install_method = classify_opencode_cli_method(&candidate.path);
        let install_dir = resolve_opencode_install_dir(&candidate.path, &install_method);
        let version_result = read_version(&candidate.path).await;
        let (version, version_output, error) = match version_result {
            Ok(output) => (parse_version(&output), Some(output), None),
            Err(error) => (None, None, Some(error)),
        };
        installations.push(AgentInstallation {
            surface: AgentSurface::Cli,
            executable_path: display_path(&candidate.path),
            install_dir: display_path(&install_dir),
            install_method,
            version,
            version_output,
            available_on_path: candidate.available_on_path,
            error,
        });
    }
    for candidate in opencode_desktop_candidates() {
        installations.push(AgentInstallation {
            surface: AgentSurface::Desktop,
            executable_path: display_path(&candidate.path),
            install_dir: display_path(candidate.path.parent().unwrap_or(&candidate.path)),
            install_method: AgentInstallMethod::Desktop,
            version: desktop_version(&candidate.path),
            version_output: None,
            available_on_path: false,
            error: None,
        });
    }

    let primary = installations
        .iter()
        .find(|installation| {
            installation.surface == AgentSurface::Cli
                && installation.available_on_path
                && installation.version.is_some()
        })
        .or_else(|| {
            installations.iter().find(|installation| {
                installation.surface == AgentSurface::Cli && installation.version.is_some()
            })
        })
        .or_else(|| {
            installations.iter().find(|installation| {
                installation.surface == AgentSurface::Desktop && installation.version.is_some()
            })
        })
        .or_else(|| {
            installations.iter().find(|installation| {
                installation.surface == AgentSurface::Cli
                    && installation.available_on_path
                    && installation.error.is_none()
            })
        })
        .or_else(|| installations.first())
        .cloned();

    AgentEnvironmentReport {
        agent_id: "opencode".to_string(),
        agent_name: "OpenCode".to_string(),
        installed: !installations.is_empty(),
        primary,
        installations,
    }
}

#[derive(Debug)]
struct Candidate {
    path: PathBuf,
    available_on_path: bool,
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
                push_candidate(&mut candidates, &mut seen, directory.join(file_name), true);
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        for relative in known_codex_cli_locations() {
            push_candidate(&mut candidates, &mut seen, home.join(relative), false);
        }
    }
    #[cfg(windows)]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        let directory = PathBuf::from(app_data).join("npm");
        for file_name in executable_names("codex") {
            push_candidate(&mut candidates, &mut seen, directory.join(file_name), false);
        }
    }
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        push_candidate(
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
    {
        AgentInstallMethod::Native
    } else if normalized.starts_with("/usr/bin/") || normalized.starts_with("/usr/local/bin/") {
        AgentInstallMethod::SystemPackage
    } else {
        AgentInstallMethod::Unknown
    }
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
    let content = std::fs::read_to_string(install_dir.join("package.json")).ok()?;
    parse_package_version(&content)
}

fn parse_package_version(content: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(content)
        .ok()?
        .get("version")?
        .as_str()
        .filter(|version| !version.is_empty())
        .map(str::to_owned)
}

async fn read_version(path: &Path) -> Result<String, String> {
    let mut command = version_command(path);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = tokio::time::timeout(VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| "版本检测超时".to_string())?
        .map_err(|error| format!("无法执行版本命令：{error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let text = if !stdout.is_empty() { stdout } else { stderr };
    if !output.status.success() {
        return Err(if text.is_empty() {
            format!("版本命令退出状态：{}", output.status)
        } else {
            text
        });
    }
    if text.is_empty() {
        Err("版本命令未返回内容".to_string())
    } else {
        Ok(text)
    }
}

#[cfg(windows)]
fn version_command(path: &Path) -> Command {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if is_windows_store_codex_executable(path) {
        // Packaged executables can fail when spawned directly from a
        // CreateProcess-based host. PowerShell preserves the package launch
        // behavior and still gives us the real Codex CLI version output.
        let escaped = path.to_string_lossy().replace('\'', "''");
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("& '{escaped}' --version"),
        ]);
        #[cfg(windows)]
        configure_hidden_console(&mut command);
        command
    } else if extension == "cmd" || extension == "bat" {
        let mut command = Command::new("cmd.exe");
        command.arg("/D").arg("/C").arg(path).arg("--version");
        #[cfg(windows)]
        configure_hidden_console(&mut command);
        command
    } else if extension == "ps1" {
        let mut command = Command::new("powershell.exe");
        command
            .arg("-NoLogo")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(path)
            .arg("--version");
        #[cfg(windows)]
        configure_hidden_console(&mut command);
        command
    } else {
        let mut command = Command::new(path);
        command.arg("--version");
        #[cfg(windows)]
        configure_hidden_console(&mut command);
        command
    }
}

#[cfg(windows)]
fn is_windows_store_codex_executable(path: &Path) -> bool {
    let normalized = normalized_path_key(path);
    (normalized.contains("/windowsapps/openai.codex_")
        || normalized.contains("/windowsapps/openai.chatgpt-desktop_"))
        && normalized.ends_with("/app/resources/codex.exe")
}

#[cfg(not(windows))]
fn version_command(path: &Path) -> Command {
    let mut command = Command::new(path);
    command.arg("--version");
    command
}

fn parse_version(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .map(|part| {
            part.trim_matches(|character: char| {
                !character.is_ascii_alphanumeric() && character != '.'
            })
            .trim_start_matches(['v', 'V'])
        })
        .find(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_digit())
                && part.contains('.')
                && part
                    .chars()
                    .all(|character| character.is_ascii_digit() || character == '.')
        })
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
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
    }

    #[cfg(windows)]
    #[test]
    fn recognizes_windows_store_codex_command_target() {
        let path = Path::new(
            "C:/Program Files/WindowsApps/OpenAI.Codex_26.715.4045.0_x64__2p2nqsd0c76g0/app/resources/codex.exe",
        );
        assert!(is_windows_store_codex_executable(path));
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
}
