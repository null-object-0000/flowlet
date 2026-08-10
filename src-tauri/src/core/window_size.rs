use tauri::{LogicalSize, PhysicalSize};

/// Flowlet 桌面页面的最小 WebView 客户区，而不是原生窗口外框尺寸。
pub(crate) const MIN_CONTENT_WIDTH: f64 = 1200.0;
pub(crate) const MIN_CONTENT_HEIGHT: f64 = 720.0;

fn minimum_outer_size_for_content(
    inner_size: PhysicalSize<u32>,
    outer_size: PhysicalSize<u32>,
    scale_factor: f64,
) -> LogicalSize<f64> {
    let safe_scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let frame_width = outer_size.width.saturating_sub(inner_size.width) as f64 / safe_scale_factor;
    let frame_height =
        outer_size.height.saturating_sub(inner_size.height) as f64 / safe_scale_factor;

    LogicalSize::new(
        MIN_CONTENT_WIDTH + frame_width,
        MIN_CONTENT_HEIGHT + frame_height,
    )
}

/// 保证窗口最小时仍有 1200×720 的 WebView 客户区。
///
/// Windows 的无边框可缩放窗口仍带有不可见 resize frame。Tao 的最小尺寸约束
/// 当前按外框生效，因此直接设置 1200×720 会让客户区缩至约 1184×711。这里用
/// 运行时测得的 outer-inner 差值做 DPI 感知补偿；其他平台直接使用客户区尺寸。
/// 同时把窗口状态插件恢复出来的旧小尺寸抬回新的合法下限。
pub(crate) fn enforce_minimum_content_size(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let scale_factor = window.scale_factor()?;
    let inner_physical = window.inner_size()?;

    #[cfg(windows)]
    let minimum_outer =
        minimum_outer_size_for_content(inner_physical, window.outer_size()?, scale_factor);
    #[cfg(not(windows))]
    let minimum_outer = LogicalSize::new(MIN_CONTENT_WIDTH, MIN_CONTENT_HEIGHT);

    window.set_min_size(Some(minimum_outer))?;

    let inner_logical = inner_physical.to_logical::<f64>(scale_factor);
    if inner_logical.width < MIN_CONTENT_WIDTH || inner_logical.height < MIN_CONTENT_HEIGHT {
        window.set_size(LogicalSize::new(
            inner_logical.width.max(MIN_CONTENT_WIDTH),
            inner_logical.height.max(MIN_CONTENT_HEIGHT),
        ))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compensates_for_windows_invisible_resize_frame() {
        let minimum = minimum_outer_size_for_content(
            PhysicalSize::new(1184, 711),
            PhysicalSize::new(1200, 720),
            1.0,
        );

        assert_eq!(minimum, LogicalSize::new(1216.0, 729.0));
    }

    #[test]
    fn converts_physical_frame_to_logical_units_for_high_dpi() {
        let minimum = minimum_outer_size_for_content(
            PhysicalSize::new(1776, 1066),
            PhysicalSize::new(1800, 1080),
            1.5,
        );

        assert_eq!(minimum, LogicalSize::new(1216.0, 720.0 + 14.0 / 1.5));
    }

    #[test]
    fn never_treats_shadow_measurement_as_negative_frame() {
        let minimum = minimum_outer_size_for_content(
            PhysicalSize::new(1200, 720),
            PhysicalSize::new(1198, 718),
            1.0,
        );

        assert_eq!(minimum, LogicalSize::new(1200.0, 720.0));
    }
}
