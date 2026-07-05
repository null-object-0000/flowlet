//! 文件日志。日志文件统一写入 exe 同级下的 logs/ 子目录，完全自包含。
//!
//! 用法:
//!   init_file_logging();   // 尽早调用一次

use std::path::PathBuf;

/// 日志目录：始终在 exe 同级下的 logs/ 子目录，与程序完全自包含。
pub fn log_dir() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("logs")
}

/// Init file-based logging. 非阻塞写入，按天滚动保留 7 天。
/// 如果初始化失败（比如权限问题），静默降级到不写文件（不影响程序本身）。
pub fn init_file_logging() {
    // RUST_LOG 默认 info（生产环境避免 debug 噪音）
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var("RUST_LOG", "info");
    }

    let _ = (|| -> Result<(), Box<dyn std::error::Error>> {
        let dir = log_dir();
        std::fs::create_dir_all(&dir)?;

        // 按天滚动，保留最近 7 天文件
        let file_appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .max_log_files(7)
            .filename_prefix("flowlet")
            .filename_suffix("log")
            .build(&dir)?;

        let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
        // 记住 guard 以免被 drop 后刷新失效
        // （Box::leak 让它在进程生命周期里始终有效）
        Box::leak(Box::new(_guard));

        // 用 set_global_default (fallible) 而非 init()，避免 tauri 内部
        // 已经设置好 tracing-subscriber 时我们的第二次 init panic。
        let built = tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| "info".into()),
            )
            .with_writer(non_blocking)
            .with_ansi(false)
            .with_target(true)
            .with_thread_ids(false)
            .with_line_number(true)
            .with_timer(tracing_subscriber::fmt::time::ChronoLocal::new(
                "%Y-%m-%d %H:%M:%S%.3f".to_string(),
            ));

        let _ = tracing::subscriber::set_global_default(built.finish());

        // 之后通过 tracing::info 打点都会落盘
        tracing::info!(path = %dir.display(), "file logging initialized");
        Ok(())
    })();
}
