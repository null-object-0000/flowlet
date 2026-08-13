use super::super::*;
use super::DetectionFuture;

pub(super) fn detect_boxed() -> DetectionFuture {
    Box::pin(detect())
}

async fn detect() -> AgentEnvironmentReport {
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
    const QUERY: &str = r#"$found = $false; $packages = @(); $packages += @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue); $packages += @(Get-AppxPackage -Name 'OpenAI.ChatGPT-Desktop' -ErrorAction SilentlyContinue); foreach ($p in @($packages | Sort-Object Version -Descending)) { $relative = ''; try { [xml]$manifest = Get-Content -LiteralPath (Join-Path $p.InstallLocation 'AppxManifest.xml'); $app = @($manifest.Package.Applications.Application) | Where-Object { [IO.Path]::GetFileName([string]$_.Executable) -ieq 'ChatGPT.exe' } | Select-Object -First 1; if ($null -ne $app) { $relative = [string]$app.Executable } } catch {}; if ([string]::IsNullOrWhiteSpace($relative)) { $fallback = Join-Path $p.InstallLocation 'app\ChatGPT.exe'; if (Test-Path -LiteralPath $fallback) { $relative = 'app\ChatGPT.exe' } }; if (-not [string]::IsNullOrWhiteSpace($relative)) { [Console]::Out.Write($p.Version.ToString() + [char]9 + $p.InstallLocation + [char]9 + $relative); $found = $true; break } }; if (-not $found) { $process = Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue | Where-Object { $_.Path -match '\\WindowsApps\\OpenAI\.(Codex|ChatGPT-Desktop)_[^\\]+\\app\\ChatGPT\.exe$' } | Select-Object -First 1; if ($null -ne $process -and $process.Path -match '^(?<install>.*\\OpenAI\.(Codex|ChatGPT-Desktop)_(?<version>[^_]+)_[^\\]+)\\app\\ChatGPT\.exe$') { [Console]::Out.Write($Matches.version + [char]9 + $Matches.install + [char]9 + 'app\ChatGPT.exe') } }"#;
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        QUERY,
    ]);
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
pub(in crate::core::agent_environment) fn parse_chatgpt_windows_package_output(
    output: &str,
) -> Option<AgentInstallation> {
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
