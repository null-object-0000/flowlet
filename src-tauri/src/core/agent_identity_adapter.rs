use super::agent_session_identity::{AgentSessionIdentity, AGENT_CLIENT_HEADER};
use super::config::UaClientRule;
use axum::http::{header, HeaderMap};

mod adapters;

pub(crate) type HeaderLookup<'a> = dyn Fn(&str) -> Option<String> + 'a;

#[derive(Clone, Copy)]
pub(crate) struct AgentUaRule {
    pub(crate) id: &'static str,
    pub(crate) pattern: &'static str,
    pub(crate) name: &'static str,
}

pub(crate) trait AgentIdentityAdapter: Sync {
    fn id(&self) -> &'static str;
    fn ua_rules(&self) -> &'static [AgentUaRule];
    fn extract_session(&self, header: &HeaderLookup<'_>) -> Option<AgentSessionIdentity>;
}

pub(crate) fn extract_session(header: &HeaderLookup<'_>) -> Option<AgentSessionIdentity> {
    adapters::all()
        .iter()
        .find_map(|adapter| adapter.extract_session(header))
}

pub(crate) fn has_identity_adapter(adapter_id: &str) -> bool {
    adapters::all()
        .iter()
        .any(|adapter| adapter.id() == adapter_id)
}

pub(crate) fn builtin_ua_rules() -> Vec<UaClientRule> {
    adapters::all()
        .iter()
        .flat_map(|adapter| adapter.ua_rules())
        .map(|rule| UaClientRule {
            id: rule.id.to_string(),
            pattern: rule.pattern.to_string(),
            name: rule.name.to_string(),
            enabled: true,
        })
        .collect()
}

/// 识别客户端身份：受管标记头优先，再按配置和 Adapter 提供的 UA 规则匹配。
pub(crate) fn identify_client_agent(
    headers: &HeaderMap,
    rules: &[UaClientRule],
) -> Option<(String, String)> {
    if let Some(value) = headers
        .get(AGENT_CLIENT_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let id = value.to_ascii_lowercase();
        let name = super::plugin_registry::plugin_registry()
            .agent(&id)
            .map(|agent| agent.name.clone())
            .unwrap_or_else(|| value.to_string());
        return Some((id, name));
    }
    identify_client_by_ua(headers, rules)
}

pub(crate) fn identify_client_by_ua(
    headers: &HeaderMap,
    rules: &[UaClientRule],
) -> Option<(String, String)> {
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())?;
    rules
        .iter()
        .find(|rule| rule.enabled && !rule.pattern.is_empty() && ua.contains(&rule.pattern))
        .map(|rule| (rule.id.clone(), rule.name.clone()))
}
