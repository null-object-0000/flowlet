//! Prometheus-compatible metrics collection

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Clone)]
pub struct Metrics {
    pub requests_total: Arc<AtomicU64>,
    pub failures_total: Arc<AtomicU64>,
    pub fallbacks_total: Arc<AtomicU64>,
    pub tokens_input_total: Arc<AtomicU64>,
    pub tokens_output_total: Arc<AtomicU64>,
    pub cost_total: Arc<AtomicU64>, // 存储为 微单位 (cost * 1_000_000)
    pub active_requests: Arc<AtomicU64>,
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            requests_total: Arc::new(AtomicU64::new(0)),
            failures_total: Arc::new(AtomicU64::new(0)),
            fallbacks_total: Arc::new(AtomicU64::new(0)),
            tokens_input_total: Arc::new(AtomicU64::new(0)),
            tokens_output_total: Arc::new(AtomicU64::new(0)),
            cost_total: Arc::new(AtomicU64::new(0)),
            active_requests: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn record_request(&self) {
        self.requests_total.fetch_add(1, Ordering::Relaxed);
        self.active_requests.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_response(&self, status: u16) {
        self.active_requests.fetch_sub(1, Ordering::Relaxed);
        if status >= 400 {
            self.failures_total.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn record_fallback(&self) {
        self.fallbacks_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_tokens(&self, input: u64, output: u64) {
        self.tokens_input_total.fetch_add(input, Ordering::Relaxed);
        self.tokens_output_total
            .fetch_add(output, Ordering::Relaxed);
    }

    pub fn record_cost(&self, cost: f64) {
        let micros = (cost * 1_000_000.0) as u64;
        self.cost_total.fetch_add(micros, Ordering::Relaxed);
    }

    pub fn render_prometheus(&self) -> String {
        let requests = self.requests_total.load(Ordering::Relaxed);
        let failures = self.failures_total.load(Ordering::Relaxed);
        let fallbacks = self.fallbacks_total.load(Ordering::Relaxed);
        let tokens_in = self.tokens_input_total.load(Ordering::Relaxed);
        let tokens_out = self.tokens_output_total.load(Ordering::Relaxed);
        let cost_micros = self.cost_total.load(Ordering::Relaxed);
        let active = self.active_requests.load(Ordering::Relaxed);

        let cost = cost_micros as f64 / 1_000_000.0;

        format!(
            "# HELP flowlet_requests_total Total number of requests processed.\n\
             # TYPE flowlet_requests_total counter\n\
             flowlet_requests_total {}\n\
             # HELP flowlet_failures_total Total number of failed requests (status >= 400).\n\
             # TYPE flowlet_failures_total counter\n\
             flowlet_failures_total {}\n\
             # HELP flowlet_fallbacks_total Total number of fallback events.\n\
             # TYPE flowlet_fallbacks_total counter\n\
             flowlet_fallbacks_total {}\n\
             # HELP flowlet_tokens_input_total Total input tokens processed.\n\
             # TYPE flowlet_tokens_input_total counter\n\
             flowlet_tokens_input_total {}\n\
             # HELP flowlet_tokens_output_total Total output tokens processed.\n\
             # TYPE flowlet_tokens_output_total counter\n\
             flowlet_tokens_output_total {}\n\
             # HELP flowlet_cost_total_total Total estimated cost in USD.\n\
             # TYPE flowlet_cost_total_total counter\n\
             flowlet_cost_total_total {:.6}\n\
             # HELP flowlet_active_requests Current number of active requests.\n\
             # TYPE flowlet_active_requests gauge\n\
             flowlet_active_requests {}\n",
            requests, failures, fallbacks, tokens_in, tokens_out, cost, active
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_render_prometheus() {
        let m = Metrics::new();
        m.record_request();
        m.record_request();
        m.record_response(200);
        m.record_response(429);
        m.record_fallback();
        m.record_tokens(1000, 500);
        m.record_cost(0.0025);

        let output = m.render_prometheus();
        assert!(output.contains("flowlet_requests_total 2"));
        assert!(output.contains("flowlet_failures_total 1"));
        assert!(output.contains("flowlet_fallbacks_total 1"));
        assert!(output.contains("flowlet_tokens_input_total 1000"));
        assert!(output.contains("flowlet_tokens_output_total 500"));
        assert!(output.contains("flowlet_cost_total_total 0.002500"));
    }

    #[test]
    fn metrics_active_requests() {
        let m = Metrics::new();
        m.record_request();
        m.record_request();
        assert_eq!(m.active_requests.load(Ordering::Relaxed), 2);
        m.record_response(200);
        assert_eq!(m.active_requests.load(Ordering::Relaxed), 1);
    }
}
