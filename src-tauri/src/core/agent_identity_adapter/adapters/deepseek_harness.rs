use super::super::{AgentIdentityAdapter, AgentUaRule, HeaderLookup};
use crate::core::agent_session_identity::{
    AgentSessionIdentity, AGENT_SESSION_HEADER, DSH_NATIVE_SESSION_HEADER,
};

pub(super) struct DeepSeekHarnessIdentityAdapter;

const UA_RULES: [AgentUaRule; 1] = [AgentUaRule {
    id: "deepseek-harness",
    pattern: "deepseek-harness/",
    name: "DeepSeek Harness",
}];

impl AgentIdentityAdapter for DeepSeekHarnessIdentityAdapter {
    fn id(&self) -> &'static str {
        "deepseek-harness"
    }
    fn ua_rules(&self) -> &'static [AgentUaRule] {
        &UA_RULES
    }
    fn extract_session(&self, header: &HeaderLookup<'_>) -> Option<AgentSessionIdentity> {
        if !header("user-agent")
            .is_some_and(|value| value.to_ascii_lowercase().contains("deepseek-harness/"))
        {
            return None;
        }
        Some(AgentSessionIdentity {
            agent_type: "deepseek-harness".to_string(),
            // 受管会话桥注入的 `x-flowlet-session` 语义更明确，优先；DSH 原生 Provider
            // （`dsh-llm-deepseek`）直连时不部署桥接，回退读它自带的原生会话头。
            // 两者取值同源（`String(options.sessionId)`），因此合并键 `(agent_type, session_id)`
            // 对两条接入路径得到同一行会话。父会话信息只在会话文件里，不在代理身份路径。
            session_id: header(AGENT_SESSION_HEADER)
                .or_else(|| header(DSH_NATIVE_SESSION_HEADER))?,
            parent_session_id: None,
        })
    }
}
