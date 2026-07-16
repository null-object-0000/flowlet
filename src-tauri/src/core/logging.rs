//! 桌面进程文件日志。
//! 正常日志按天写入 logs/flowlet.YYYY-MM-DD.log；
//! 日志系统自身初始化失败或进程 panic 时写入 logs/flowlet-startup.log。

use std::{
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    sync::{Once, OnceLock},
};

static LOG_INIT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
static PANIC_HOOK_INIT: Once = Once::new();

/// 日志目录：始终在 exe 同级下的 logs/ 子目录，与程序完全自包含。
pub fn log_dir() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("logs")
}

/// 尽可能早地初始化文件日志。该函数可重复调用，但进程内只执行一次初始化。
///
/// 使用同步 writer，确保应用在 setup 阶段退出或被强制终止时，已产生的启动日志
/// 仍然已经写入磁盘。
pub fn init_file_logging() -> Result<PathBuf, String> {
    LOG_INIT
        .get_or_init(|| {
            let result = try_init_file_logging();
            if let Err(error) = &result {
                write_emergency_log("logging_init_failed", error);
            }
            result
        })
        .clone()
}

fn try_init_file_logging() -> Result<PathBuf, String> {
    let filter_spec = filter_spec(std::env::var("RUST_LOG").ok().as_deref());
    let mut errors = Vec::new();

    for dir in log_dir_candidates() {
        if let Err(error) = std::fs::create_dir_all(&dir) {
            errors.push(format!("无法创建日志目录 {}: {error}", dir.display()));
            continue;
        }

        let file_appender = match tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .max_log_files(7)
            .filename_prefix("flowlet")
            .filename_suffix("log")
            .build(&dir)
        {
            Ok(appender) => appender,
            Err(error) => {
                errors.push(format!("无法创建滚动日志文件 {}: {error}", dir.display()));
                continue;
            }
        };

        let filter = tracing_subscriber::EnvFilter::try_new(&filter_spec).unwrap_or_else(|_| {
            tracing_subscriber::EnvFilter::new("warn,flowlet=info,flowlet_lib=info")
        });
        let subscriber = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(file_appender)
            .with_ansi(false)
            .with_target(true)
            .with_thread_ids(false)
            .with_line_number(true)
            .with_timer(tracing_subscriber::fmt::time::ChronoLocal::new(
                "%Y-%m-%d %H:%M:%S%.3f".to_string(),
            ))
            .finish();

        tracing::subscriber::set_global_default(subscriber)
            .map_err(|error| format!("无法注册全局日志订阅器: {error}"))?;

        tracing::info!(
            path = %dir.display(),
            pid = std::process::id(),
            "文件日志初始化完成"
        );
        return Ok(dir);
    }

    Err(errors.join("; "))
}

/// 安装全局 panic hook。panic 同时进入正常 tracing 日志和应急启动日志。
pub fn install_panic_hook() {
    PANIC_HOOK_INIT.call_once(|| {
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let message = info.to_string();
            tracing::error!(panic = %message, "Flowlet 发生未捕获 panic");
            write_emergency_log("panic", &message);
            previous_hook(info);
        }));
    });
}

/// 不依赖 tracing subscriber 的最后兜底日志。
pub fn write_emergency_log(kind: &str, message: &str) {
    for dir in log_dir_candidates() {
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }

        let path = dir.join("flowlet-startup.log");
        let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
            continue;
        };
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        if writeln!(
            file,
            "{timestamp} [{kind}] pid={} {message}",
            std::process::id()
        )
        .is_ok()
        {
            return;
        }
    }
}

fn log_dir_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![log_dir()];
    if let Some(data_dir) = dirs::data_local_dir() {
        candidates.push(data_dir.join("Flowlet").join("logs"));
    }
    candidates.push(std::env::temp_dir().join("Flowlet").join("logs"));
    candidates.dedup();
    candidates
}

fn filter_spec(raw: Option<&str>) -> String {
    let mut directives = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("warn")
        .to_string();

    let parts: Vec<String> = directives
        .split(',')
        .map(|part| part.trim().to_string())
        .collect();
    let global_is_verbose = parts
        .iter()
        .any(|part| !part.contains('=') && matches!(part.as_str(), "trace" | "debug" | "info"));

    for target in ["flowlet", "flowlet_lib"] {
        let target_is_verbose = parts.iter().any(|part| {
            part.split_once('=')
                .map(|(name, level)| name == target && matches!(level, "trace" | "debug" | "info"))
                .unwrap_or(false)
        });
        if !global_is_verbose && !target_is_verbose {
            directives.push_str(&format!(",{target}=info"));
        }
    }

    directives
}

#[cfg(test)]
mod tests {
    use super::filter_spec;

    #[test]
    fn warn_environment_keeps_flowlet_startup_logs() {
        assert_eq!(
            filter_spec(Some("warn")),
            "warn,flowlet=info,flowlet_lib=info"
        );
    }

    #[test]
    fn verbose_environment_is_not_lowered() {
        assert_eq!(filter_spec(Some("debug")), "debug");
        assert_eq!(
            filter_spec(Some("warn,flowlet_lib=debug")),
            "warn,flowlet_lib=debug,flowlet=info"
        );
    }
}
