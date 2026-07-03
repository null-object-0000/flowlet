//! Simple token-bucket rate limiter per client

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct RateLimiter {
    buckets: Arc<Mutex<HashMap<String, Bucket>>>,
    max_tokens: u64,
    refill_rate: u64, // tokens per second
}

struct Bucket {
    tokens: u64,
    last_refill: Instant,
}

impl RateLimiter {
    pub fn new(requests_per_minute: u64) -> Self {
        Self {
            buckets: Arc::new(Mutex::new(HashMap::new())),
            max_tokens: requests_per_minute,
            refill_rate: requests_per_minute / 60,
        }
    }

    /// 尝试消费一个 token，返回是否允许
    pub async fn try_consume(&self, client_id: &str) -> bool {
        let mut buckets = self.buckets.lock().await;
        let now = Instant::now();
        let bucket = buckets.entry(client_id.to_string()).or_insert(Bucket {
            tokens: self.max_tokens,
            last_refill: now,
        });

        // 补充 token
        let elapsed = now.duration_since(bucket.last_refill);
        let refill = (elapsed.as_secs() * self.refill_rate).min(self.max_tokens);
        bucket.tokens = (bucket.tokens + refill).min(self.max_tokens);
        bucket.last_refill = now;

        if bucket.tokens > 0 {
            bucket.tokens -= 1;
            true
        } else {
            false
        }
    }

    /// 获取下次重置的秒数
    pub async fn retry_after(&self, client_id: &str) -> u64 {
        let buckets = self.buckets.lock().await;
        if let Some(bucket) = buckets.get(client_id) {
            if bucket.tokens == 0 {
                let needed = 1u64.saturating_sub(bucket.tokens);
                let rate = self.refill_rate.max(1);
                return (needed + rate - 1) / rate;
            }
        }
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rate_limiter_allows_within_limit() {
        let limiter = RateLimiter::new(10);
        for _ in 0..10 {
            assert!(limiter.try_consume("client-1").await);
        }
        // 第 11 次应该被拒绝
        assert!(!limiter.try_consume("client-1").await);
    }

    #[tokio::test]
    async fn rate_limiter_separate_clients() {
        let limiter = RateLimiter::new(5);
        for _ in 0..5 {
            assert!(limiter.try_consume("client-a").await);
        }
        assert!(!limiter.try_consume("client-a").await);
        // client-b 不受影响
        assert!(limiter.try_consume("client-b").await);
    }
}
