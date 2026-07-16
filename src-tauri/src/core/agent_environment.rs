use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentInstallMethod {
    Native,
    Winget,
    Npm,
    LegacyNpm,
    Homebrew,
    SystemPackage,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AgentInstallation {
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
        _ => Err(format!("暂不支持检测 Agent：{agent_id}")),
    }
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
            executable_path: candidate.path.to_string_lossy().into_owned(),
            install_dir: install_dir.to_string_lossy().into_owned(),
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

#[derive(Debug)]
struct Candidate {
    path: PathBuf,
    available_on_path: bool,
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

#[cfg(windows)]
fn executable_names(command: &str) -> Vec<String> {
    let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let mut names = vec![command.to_string()];
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
    if extension == "cmd" || extension == "bat" {
        let mut command = Command::new("cmd.exe");
        command.arg("/D").arg("/C").arg(path).arg("--version");
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
        command
    } else {
        let mut command = Command::new(path);
        command.arg("--version");
        command
    }
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
    }
}
