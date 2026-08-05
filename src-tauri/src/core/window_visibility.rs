use tauri::PhysicalPosition;

/// 确保窗口完整落在某个显示器的工作区内。
///
/// 窗口状态插件在恢复上次的尺寸/位置/最大化时，可能因显示器分辨率或多屏
/// 布局变化、或上次关闭时窗口已处于屏幕边缘，把窗口恢复到「一半在屏外」的
/// 异常位置。此处把窗口拉回其中心所在显示器的可见区域，保证启动后窗口完整可见。
///
/// 规则：
/// - 若窗口中心点已落在某个显示器工作区内，且窗口完全位于该工作区内，则不做任何调整；
/// - 否则把窗口的位置 clamp 到该工作区内，使窗口完整可见。
/// 不会强制跨屏拖拽的窗口回到单屏，仅兜底「整窗不可见/严重越界」的情况。
pub(crate) fn ensure_window_on_screen(window: &tauri::WebviewWindow) {
    let Ok(pos) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let center_x = pos.x as f64 + size.width as f64 / 2.0;
    let center_y = pos.y as f64 + size.height as f64 / 2.0;

    let monitors = match window.available_monitors() {
        Ok(list) if !list.is_empty() => list,
        _ => return,
    };

    // 优先选择包含窗口中心点的显示器；找不到（中心点已完全在屏外）则退回主显示器。
    let fallback = window.primary_monitor().ok().flatten();
    let target = monitors
        .iter()
        .find(|m| {
            let area = m.work_area();
            center_x >= area.position.x as f64
                && center_x <= (area.position.x + area.size.width as i32) as f64
                && center_y >= area.position.y as f64
                && center_y <= (area.position.y + area.size.height as i32) as f64
        })
        .or_else(|| fallback.as_ref());

    let Some(monitor) = target else {
        return;
    };
    let area = monitor.work_area();

    let left = pos.x;
    let top = pos.y;
    let right = pos.x + size.width as i32;
    let bottom = pos.y + size.height as i32;
    let area_left = area.position.x;
    let area_top = area.position.y;
    let area_right = area_left + area.size.width as i32;
    let area_bottom = area_top + area.size.height as i32;

    // 窗口已完全可见，无需调整。
    if left >= area_left && top >= area_top && right <= area_right && bottom <= area_bottom {
        return;
    }

    let new_x = left.clamp(area_left, (area_right - size.width as i32).max(area_left));
    let new_y = top.clamp(area_top, (area_bottom - size.height as i32).max(area_top));
    if new_x != pos.x || new_y != pos.y {
        let _ = window.set_position(PhysicalPosition::new(new_x, new_y));
    }
}