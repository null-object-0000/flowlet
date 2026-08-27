use super::*;

pub(super) fn read_package_version(install_dir: &Path) -> Option<String> {
    let content = std::fs::read_to_string(install_dir.join("package.json")).ok()?;
    parse_package_version(&content)
}

pub(super) fn parse_package_version(content: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(content)
        .ok()?
        .get("version")?
        .as_str()
        .filter(|version| !version.is_empty())
        .map(str::to_owned)
}

pub(super) async fn read_version(path: &Path) -> Result<String, String> {
    read_version_with_extra_path(path, &[]).await
}

pub(super) async fn read_version_with_extra_path(
    path: &Path,
    extra_path_dirs: &[PathBuf],
) -> Result<String, String> {
    let mut command = version_command(path);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    for directory in extra_path_dirs {
        super::prepend_path(&mut command, directory);
    }

    let output = tokio::time::timeout(VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| "版本检测超时".to_string())?
        .map_err(|error| format!("无法执行版本命令：{error}"))?;

    let stdout = decode_process_output(&output.stdout);
    let stderr = decode_process_output(&output.stderr);
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
        let escaped = path.to_string_lossy().replace('\'', "''");
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("& '{escaped}' --version"),
        ]);
        configure_hidden_console(&mut command);
        command
    } else if extension == "cmd" || extension == "bat" {
        let mut command = Command::new("cmd.exe");
        command.arg("/D").arg("/C").arg(path).arg("--version");
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
        configure_hidden_console(&mut command);
        command
    } else {
        let mut command = Command::new(path);
        command.arg("--version");
        configure_hidden_console(&mut command);
        command
    }
}

#[cfg(windows)]
pub(super) fn is_windows_store_codex_executable(path: &Path) -> bool {
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

pub(super) fn parse_version(output: &str) -> Option<String> {
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

pub(super) fn decode_process_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.trim().to_string();
    }
    #[cfg(windows)]
    {
        return decode_windows_acp(bytes).trim().to_string();
    }
    #[cfg(not(windows))]
    String::from_utf8_lossy(bytes).trim().to_string()
}

#[cfg(windows)]
pub(super) fn decode_windows_acp(bytes: &[u8]) -> String {
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_ACP};
    if bytes.is_empty() {
        return String::new();
    }
    let byte_len = bytes.len().min(i32::MAX as usize) as i32;
    let required = unsafe {
        MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), byte_len, std::ptr::null_mut(), 0)
    };
    if required <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let mut wide = vec![0_u16; required as usize];
    let written = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            0,
            bytes.as_ptr(),
            byte_len,
            wide.as_mut_ptr(),
            required,
        )
    };
    if written <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    String::from_utf16_lossy(&wide[..written as usize])
}
