use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

/// 记录当前已打开的「项目详情独立窗口」对应的 project_id，并持久化到磁盘。
///
/// 应用关闭（退出）时这些窗口仍打开，因此 next 启动会根据该记录自动重建
/// 这些独立窗口，让用户的工作区布局得以延续。用户主动关闭某个独立窗口后，
/// 其 project_id 会从记录中移除，下次启动便不再恢复。
pub(crate) struct DetailWindowRegistry {
    opened: Mutex<HashSet<String>>,
    file: PathBuf,
}

impl DetailWindowRegistry {
    pub(crate) fn new(file: PathBuf) -> Self {
        let opened = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .map(|ids| ids.into_iter().collect())
            .unwrap_or_default();
        Self {
            opened: Mutex::new(opened),
            file,
        }
    }

    /// 当前记录的需要恢复的 project_id 列表（已打开/上次退出时仍打开的窗口）。
    pub(crate) fn snapshot(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .opened
            .lock()
            .map(|guard| guard.iter().cloned().collect())
            .unwrap_or_default();
        ids.sort();
        ids
    }

    pub(crate) fn add(&self, project_id: &str) {
        let changed = self
            .opened
            .lock()
            .map(|mut guard| guard.insert(project_id.to_string()))
            .unwrap_or(false);
        if changed {
            self.persist();
        }
    }

    pub(crate) fn remove(&self, project_id: &str) {
        let changed = self
            .opened
            .lock()
            .map(|mut guard| guard.remove(project_id))
            .unwrap_or(false);
        if changed {
            self.persist();
        }
    }

    fn persist(&self) {
        let ids = self.snapshot();
        if let Ok(json) = serde_json::to_string(&ids) {
            let _ = std::fs::write(&self.file, json);
        }
    }
}
