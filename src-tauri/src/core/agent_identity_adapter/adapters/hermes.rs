use super::super::{AgentIdentityAdapter, AgentUaRule, HeaderLookup};
use crate::core::agent_session_identity::{AgentSessionIdentity, AGENT_CLIENT_HEADER, AGENT_SESSION_HEADER};

pub(super) struct HermesIdentityAdapter;

// Hermes Agent 复用 OpenAI Python SDK 的通用 User-Agent（`OpenAI/Python …`），无法靠
// UA 子串区分；客户端归属由 Flowlet 写入 `config.yaml` 的静态头
// `x-flowlet-client: hermes` 承载（identify_client_agent 会优先读该头）。因此这里不
// 声明任何 UA 规则，避免误伤其它使用 OpenAI SDK 的客户端。
impl AgentIdentityAdapter for HermesIdentityAdapter {
    fn id(&self) -> &'static str {
        "hermes"
    }
    fn ua_rules(&self) -> &'static [AgentUaRule] {
        &[]
    }
    fn extract_session(&self, header: &HeaderLookup<'_>) -> Option<AgentSessionIdentity> {
        // Hermes 原生不发送会话标识头；仅在（未来可选的）受管扩展注入会话头、且
        // 客户端标记头为 hermes 时才会读取，避免误读其他客户端的同名头。
        if !header(AGENT_CLIENT_HEADER).is_some_and(|value| value.eq_ignore_ascii_case("hermes")) {
            return None;
        }
        Some(AgentSessionIdentity {
            agent_type: "hermes".to_string(),
            session_id: header(AGENT_SESSION_HEADER)?,
            parent_session_id: None,
        })
    }
}
