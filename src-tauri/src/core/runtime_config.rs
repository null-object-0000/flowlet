use super::config::{ChannelAccount, ChannelPreset, RouteCandidate, RouteRule, VirtualModel};
use std::sync::{Arc, RwLock};

/// 代理与管理面共享的不可变配置视图。
///
/// 一次请求只获取一次 `Arc<RuntimeConfigSnapshot>`，因此它看到的渠道、账号、
/// 路由、规则和虚拟模型必定来自同一个 revision。更新方在持久化成功后构造并
/// 原子发布下一版快照，不会把多个集合的中间状态暴露给代理。
#[derive(Debug, Clone)]
pub struct RuntimeConfigSnapshot {
    pub revision: u64,
    pub channels: Vec<ChannelPreset>,
    pub accounts: Vec<ChannelAccount>,
    pub routes: Vec<RouteCandidate>,
    pub rules: Vec<RouteRule>,
    pub virtual_models: Vec<VirtualModel>,
}

impl RuntimeConfigSnapshot {
    pub fn new(
        channels: Vec<ChannelPreset>,
        accounts: Vec<ChannelAccount>,
        routes: Vec<RouteCandidate>,
        rules: Vec<RouteRule>,
        virtual_models: Vec<VirtualModel>,
    ) -> Self {
        Self {
            revision: 1,
            channels,
            accounts,
            routes,
            rules,
            virtual_models,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeConfigStore {
    current: Arc<RwLock<Arc<RuntimeConfigSnapshot>>>,
}

impl RuntimeConfigStore {
    pub fn new(snapshot: RuntimeConfigSnapshot) -> Self {
        Self {
            current: Arc::new(RwLock::new(Arc::new(snapshot))),
        }
    }

    /// 获取当前不可变快照。返回后不再持有锁。
    pub fn snapshot(&self) -> Arc<RuntimeConfigSnapshot> {
        self.current
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// 基于最新 revision 修改并发布完整快照。
    pub fn update(&self, mutate: impl FnOnce(&mut RuntimeConfigSnapshot)) -> u64 {
        let mut guard = self
            .current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut next = (**guard).clone();
        mutate(&mut next);
        next.revision = next.revision.saturating_add(1);
        let revision = next.revision;
        *guard = Arc::new(next);
        revision
    }

    /// 先执行持久化操作，只有成功时才发布下一版快照。
    ///
    /// operation 在获取快照写锁前执行，避免 SQLite / 文件 IO 阻塞代理读取；失败时
    /// mutate 不会执行，当前 snapshot 和 revision 都保持不变。
    pub fn update_after<T, E>(
        &self,
        operation: impl FnOnce() -> Result<T, E>,
        mutate: impl FnOnce(&mut RuntimeConfigSnapshot, &T),
    ) -> Result<T, E> {
        let value = operation()?;
        self.update(|snapshot| mutate(snapshot, &value));
        Ok(value)
    }

    /// 仅在调用方确认内容发生变化时发布下一版快照。
    /// 返回 `None` 表示当前值已满足要求，没有复制或递增 revision。
    pub fn update_if(
        &self,
        should_update: impl FnOnce(&RuntimeConfigSnapshot) -> bool,
        mutate: impl FnOnce(&mut RuntimeConfigSnapshot),
    ) -> Option<u64> {
        let mut guard = self
            .current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !should_update(&guard) {
            return None;
        }
        let mut next = (**guard).clone();
        mutate(&mut next);
        next.revision = next.revision.saturating_add(1);
        let revision = next.revision;
        *guard = Arc::new(next);
        Some(revision)
    }

    pub fn replace(&self, mut snapshot: RuntimeConfigSnapshot) -> u64 {
        let mut guard = self
            .current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        snapshot.revision = guard.revision.saturating_add(1);
        let revision = snapshot.revision;
        *guard = Arc::new(snapshot);
        revision
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;

    fn empty_store() -> RuntimeConfigStore {
        RuntimeConfigStore::new(RuntimeConfigSnapshot::new(
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        ))
    }

    #[test]
    fn retained_snapshot_stays_consistent_after_publish() {
        let store = empty_store();
        let before = store.snapshot();
        let revision = store.update(|next| {
            next.accounts.push(ChannelAccount {
                id: "account-1".to_string(),
                channel_id: "deepseek".to_string(),
                ..Default::default()
            });
        });
        let after = store.snapshot();

        assert_eq!(before.revision, 1);
        assert!(before.accounts.is_empty());
        assert_eq!(revision, 2);
        assert_eq!(after.revision, 2);
        assert_eq!(after.accounts.len(), 1);
    }

    #[test]
    fn replacement_advances_from_current_revision() {
        let store = empty_store();
        store.update(|next| next.rules.clear());
        let replacement =
            RuntimeConfigSnapshot::new(Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());

        assert_eq!(store.replace(replacement), 3);
        assert_eq!(store.snapshot().revision, 3);
    }

    #[test]
    fn conditional_update_keeps_revision_when_nothing_changed() {
        let store = empty_store();
        let result = store.update_if(|snapshot| !snapshot.accounts.is_empty(), |_| {});

        assert_eq!(result, None);
        assert_eq!(store.snapshot().revision, 1);
    }

    #[test]
    fn concurrent_readers_never_observe_mixed_config_generations() {
        const READERS: usize = 8;
        const PUBLISHES: usize = 2_000;
        let store = empty_store();
        let start = Arc::new(Barrier::new(READERS + 1));
        let readers = (0..READERS)
            .map(|_| {
                let store = store.clone();
                let start = start.clone();
                thread::spawn(move || {
                    start.wait();
                    for _ in 0..PUBLISHES * 4 {
                        let snapshot = store.snapshot();
                        let generations = [
                            snapshot.channels.first().map(|item| item.id.as_str()),
                            snapshot.accounts.first().map(|item| item.id.as_str()),
                            snapshot.routes.first().map(|item| item.id.as_str()),
                            snapshot.rules.first().map(|item| item.id.as_str()),
                            snapshot.virtual_models.first().map(|item| item.id.as_str()),
                        ];
                        let present: Vec<_> = generations.into_iter().flatten().collect();
                        if let Some(first) = present.first() {
                            assert!(present.iter().all(|value| value == first));
                        }
                    }
                })
            })
            .collect::<Vec<_>>();

        start.wait();
        for generation in 1..=PUBLISHES {
            let id = format!("generation-{generation}");
            store.update(|snapshot| {
                snapshot.channels = vec![ChannelPreset {
                    id: id.clone(),
                    ..Default::default()
                }];
                snapshot.accounts = vec![ChannelAccount {
                    id: id.clone(),
                    ..Default::default()
                }];
                snapshot.routes = vec![RouteCandidate {
                    id: id.clone(),
                    ..Default::default()
                }];
                snapshot.rules = vec![RouteRule {
                    id: id.clone(),
                    ..Default::default()
                }];
                snapshot.virtual_models = vec![VirtualModel {
                    id: id.clone(),
                    ..Default::default()
                }];
            });
        }

        for reader in readers {
            reader.join().expect("snapshot reader panicked");
        }
        assert_eq!(store.snapshot().revision, PUBLISHES as u64 + 1);
    }

    #[test]
    fn successful_operation_publishes_and_advances_revision() {
        let store = empty_store();
        let result = store.update_after(
            || Ok::<_, &'static str>("account-1".to_string()),
            |snapshot, account_id| {
                snapshot.accounts = vec![ChannelAccount {
                    id: account_id.clone(),
                    ..Default::default()
                }];
            },
        );

        assert_eq!(result.as_deref(), Ok("account-1"));
        let snapshot = store.snapshot();
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.accounts[0].id, "account-1");
    }

    #[test]
    fn failed_operation_keeps_snapshot_and_revision_unchanged() {
        let store = empty_store();
        let before = store.snapshot();
        let result = store.update_after(
            || Err::<String, _>("sqlite write failed"),
            |snapshot, value| {
                snapshot.accounts = vec![ChannelAccount {
                    id: value.clone(),
                    ..Default::default()
                }];
            },
        );

        assert_eq!(result, Err("sqlite write failed"));
        let after = store.snapshot();
        assert!(Arc::ptr_eq(&before, &after));
        assert_eq!(after.revision, 1);
        assert!(after.accounts.is_empty());
    }
}
